import { createHash } from 'node:crypto';
import {
  checkAnchorForArtifact,
  countThreads,
  deriveThreadView,
  matchesTaskReviewFilter,
  normalizeTaskReviewText,
  parseTaskReviewQuote,
  prepareTaskReviewDocument,
  TASK_REVIEW_LIMITS,
  TASK_REVIEW_VERSION,
  type TaskReviewArtifactRef,
  type TaskReviewCreateThreadRequest,
  type TaskReviewCurrentArtifact,
  type TaskReviewDocument,
  type TaskReviewFailure,
  type TaskReviewFilter,
  type TaskReviewItem,
  type TaskReviewRefusalCode,
  type TaskReviewThread,
  type TaskReviewThreadSummary,
  type TaskReviewThreadView,
  type TaskReviewView,
} from '@kontourai/station-contracts/task-review';
import type { TaskReviewAccess } from '../orchestration/project-task-room-runtime.js';
import type { TaskMemoryStore } from '../orchestration/task-memory-store.js';
import type {
  TaskReviewEventWrite,
  TaskReviewStore,
  TaskReviewStoredThread,
} from '../orchestration/task-review-store.js';
import type { TaskOutputModule } from './task-output-module.js';

/** UTF-8 bytes as well as the contract's UTF-16 bound; oversize content is refused. */
export const TASK_REVIEW_ITEM_MAX_BYTES = TASK_REVIEW_LIMITS.documentChars;
export class TaskReviewError extends Error {
  readonly response: TaskReviewFailure;
  constructor(
    readonly code: TaskReviewRefusalCode,
    message: string,
  ) {
    super(message);
    this.response = { success: false, code, error: message };
  }
}
interface Dependencies {
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  store: TaskReviewStore;
  memory: Pick<TaskMemoryStore, 'readSummary'>;
  outputs: Pick<TaskOutputModule, 'list' | 'read' | 'readContent'>;
  readPlan(
    taskId: string,
    request: Request,
  ): Promise<
    | { kind: 'available'; documentId: string; revision: string; text: string }
    | { kind: 'unavailable' }
  >;
  /** Optional selector confines mutation/item reads to one structured answer identity. */
  readAnswers(
    taskId: string,
    request: Request,
    itemId?: string,
  ): Promise<readonly { sessionId: string; turnId: string; text: string }[]>;
}
type Artifact = { item: TaskReviewItem; current: TaskReviewCurrentArtifact };
const emptyCounts = () => ({ open: 0, outdated: 0, resolved: 0 });
const hash = (text: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const artifactId = (ref: TaskReviewArtifactRef) =>
  ref.kind === 'answer' ? JSON.stringify([ref.sessionId, ref.turnId]) : ref.id;
const key = (kind: string, id: string) => JSON.stringify([kind, id]);
const assertCurrent = (access: TaskReviewAccess) => {
  if (!access.write.beforeCommit())
    throw new TaskReviewError('not-found', 'Task not found.');
};
function boundedText(text: string): string {
  if (
    text.length > TASK_REVIEW_LIMITS.documentChars ||
    Buffer.byteLength(text, 'utf8') > TASK_REVIEW_ITEM_MAX_BYTES
  )
    throw new TaskReviewError(
      'artifact-unavailable',
      `Review text exceeds the ${TASK_REVIEW_ITEM_MAX_BYTES}-byte limit.`,
    );
  return normalizeTaskReviewText(text);
}

/** Read-time artifact resolution. Review writes reach only its SQLite store. */
export class TaskReviewModule {
  private readonly artifactDigests = new Map<string, `sha256:${string}`>();
  private readonly textRevisions = new Map<
    string,
    {
      digest: `sha256:${string}`;
      text: string;
      prepared: TaskReviewDocument | null;
    }
  >();
  private readonly threadViews = new Map<
    string,
    { key: string; view: Omit<TaskReviewThreadView, 'events'> }
  >();
  constructor(private readonly deps: Dependencies) {}

  private revisionText(
    access: TaskReviewAccess,
    kind: string,
    id: string,
    revision: string | number,
    raw: string,
  ) {
    const cacheKey = JSON.stringify([
      access.write.taskId,
      access.write.taskCreatedAt,
      kind,
      id,
      revision,
    ]);
    const cached = this.textRevisions.get(cacheKey);
    if (cached) return cached;
    const prepared = prepareTaskReviewDocument(raw);
    const text = prepared?.text ?? normalizeTaskReviewText(raw);
    const result = { digest: hash(text), text, prepared };
    // Retain at most 16 bounded revisions across Tasks; the cache carries no authority.
    if (this.textRevisions.size >= 16)
      this.textRevisions.delete(this.textRevisions.keys().next().value!);
    this.textRevisions.set(cacheKey, result);
    return result;
  }

  private answerDigest(
    access: TaskReviewAccess,
    id: string,
    turnId: string,
    text: string,
  ): `sha256:${string}` {
    const cacheKey = JSON.stringify([
      access.write.taskId,
      access.write.taskCreatedAt,
      id,
      turnId,
    ]);
    const cached = this.artifactDigests.get(cacheKey);
    if (cached) return cached;
    const digest = hash(normalizeTaskReviewText(text));
    if (this.artifactDigests.size >= TASK_REVIEW_LIMITS.threadsPerTask * 4)
      this.artifactDigests.delete(this.artifactDigests.keys().next().value!);
    this.artifactDigests.set(cacheKey, digest);
    return digest;
  }

  private derive(
    thread: TaskReviewThread,
    current: TaskReviewCurrentArtifact,
  ): TaskReviewThreadView {
    const cacheKey = JSON.stringify([
      thread.events.length,
      current.status,
      current.status === 'available' ? current.kind : undefined,
      current.status === 'available' ? current.revision : undefined,
      current.status === 'available' && current.kind === 'output'
        ? current.newerOutputWithSamePath
        : undefined,
    ]);
    const cached = this.threadViews.get(thread.threadId);
    if (cached?.key === cacheKey)
      return { ...cached.view, events: thread.events };
    const view = deriveThreadView(thread, current);
    if (this.threadViews.size >= TASK_REVIEW_LIMITS.threadsPerTask * 4)
      this.threadViews.delete(this.threadViews.keys().next().value!);
    const { events: _events, ...cachedView } = view;
    this.threadViews.set(thread.threadId, { key: cacheKey, view: cachedView });
    return view;
  }

  private unavailable(
    entry: { threadId: string; ordinal: number; eventCount: number },
    error: unknown,
  ): TaskReviewThreadSummary {
    this.deps.logger.warn('task review thread unavailable', {
      threadId: entry.threadId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return {
      status: 'unavailable',
      state: 'unavailable',
      threadId: entry.threadId,
      ordinal: entry.ordinal,
      eventCount: entry.eventCount,
    };
  }

  private summaries(
    access: TaskReviewAccess,
    artifacts: Map<string, Artifact>,
    target?: { kind: string; id: string },
  ): TaskReviewThreadSummary[] {
    return this.deps.store
      .listThreadEntries(access.write)
      .filter(
        (entry) =>
          !target ||
          (entry.status === 'available' &&
            entry.thread.artifact.kind === target.kind &&
            artifactId(entry.thread.artifact) === target.id),
      )
      .map((entry: TaskReviewStoredThread) => {
        if (entry.status === 'unavailable')
          return this.unavailable(entry, entry.error);
        const { thread } = entry;
        try {
          const current = artifacts.get(
            key(thread.artifact.kind, artifactId(thread.artifact)),
          )?.current ?? { status: 'unavailable' as const };
          const { events, ...view } = this.derive(thread, current);
          return {
            ...view,
            status: 'available' as const,
            eventCount: events.length,
            lastEvent: events.at(-1)!,
          };
        } catch (error) {
          return this.unavailable(
            { ...thread, eventCount: thread.events.length },
            error,
          );
        }
      });
  }

  private async artifacts(
    access: TaskReviewAccess,
    request: Request,
    target?: { kind: string; id: string },
    content = false,
  ): Promise<Map<string, Artifact>> {
    const { taskId } = access.write;
    const artifacts = new Map<string, Artifact>();
    const wants = (kind: string) => !target || target.kind === kind;
    const add = (item: TaskReviewItem, current: TaskReviewCurrentArtifact) => {
      if (!target || (target.kind === item.kind && target.id === item.id))
        artifacts.set(key(item.kind, item.id), { item, current });
    };
    const unavailable = (
      kind: TaskReviewItem['kind'],
      id: string,
      label: string,
    ) =>
      add(
        { kind, id, label, status: 'unavailable', counts: emptyCounts() },
        { status: 'unavailable' },
      );
    if (wants('plan')) {
      const plan = await this.deps
        .readPlan(taskId, request)
        .catch(() => ({ kind: 'unavailable' as const }));
      if (plan.kind === 'available') {
        const cached = this.revisionText(
          access,
          'plan',
          plan.documentId,
          plan.revision,
          plan.text,
        );
        add(
          {
            kind: 'plan',
            id: plan.documentId,
            label: 'Plan',
            status: 'available',
            counts: emptyCounts(),
            ...(content ? { text: boundedText(plan.text) } : {}),
            artifact: {
              kind: 'plan',
              id: plan.documentId,
              revision: plan.revision,
              digest: cached.digest,
            },
          },
          {
            status: 'available',
            kind: 'plan',
            revision: plan.revision,
            text: cached.text,
            preparedDocument: cached.prepared,
          },
        );
      } else unavailable('plan', target?.id ?? 'plan', 'Plan');
    }
    if (wants('summary')) {
      const summary = this.deps.memory.readSummary(access.write);
      if (summary) {
        const cached = this.revisionText(
          access,
          'summary',
          'summary',
          summary.revision,
          summary.text,
        );
        add(
          {
            kind: 'summary',
            id: 'summary',
            label: 'Brief',
            status: 'available',
            counts: emptyCounts(),
            ...(content ? { text: boundedText(summary.text) } : {}),
            artifact: {
              kind: 'summary',
              id: 'summary',
              revision: summary.revision,
              digest: cached.digest,
            },
          },
          {
            status: 'available',
            kind: 'summary',
            revision: summary.revision,
            text: cached.text,
            preparedDocument: cached.prepared,
          },
        );
      } else unavailable('summary', 'summary', 'Brief');
    }
    if (wants('output')) {
      // One owner listing supplies all immutable metadata and same-path provenance.
      const outputs = await this.deps.outputs.list(taskId).catch(() => []);
      for (const [index, output] of outputs.entries()) {
        if (target && target.id !== output.id) continue;
        const revision = output.materialization.digest;
        let text: string | undefined;
        if (content) {
          if (output.materialization.byteLength > TASK_REVIEW_ITEM_MAX_BYTES)
            throw new TaskReviewError(
              'artifact-unavailable',
              `Review text exceeds the ${TASK_REVIEW_ITEM_MAX_BYTES}-byte limit.`,
            );
          if (
            !/^(text\/|application\/(json|xml))/.test(
              output.materialization.mediaType,
            )
          )
            throw new TaskReviewError(
              'artifact-unavailable',
              'This output has no review text; use a whole-artifact comment.',
            );
          text = boundedText(
            (
              await this.deps.outputs.readContent(taskId, output.id)
            ).bytes.toString('utf8'),
          );
        }
        add(
          {
            kind: 'output',
            id: output.id,
            label: output.title,
            status: 'available',
            counts: emptyCounts(),
            ...(text !== undefined ? { text } : {}),
            artifact: {
              kind: 'output',
              id: output.id,
              revision,
              digest: revision,
            },
          },
          {
            status: 'available',
            kind: 'output',
            revision,
            newerOutputWithSamePath: outputs.some(
              (other, otherIndex) =>
                other.id !== output.id &&
                other.source.relativePath === output.source.relativePath &&
                (other.createdAt > output.createdAt ||
                  (other.createdAt === output.createdAt && otherIndex > index)),
            ),
          },
        );
      }
    }
    if (wants('answer')) {
      for (const answer of await this.deps
        .readAnswers(taskId, request, target?.id)
        .catch(() => [])) {
        const id = JSON.stringify([answer.sessionId, answer.turnId]);
        const digest = this.answerDigest(
          access,
          id,
          answer.turnId,
          answer.text,
        );
        add(
          {
            kind: 'answer',
            id,
            label: 'Answer',
            status: 'available',
            counts: emptyCounts(),
            ...(content ? { text: boundedText(answer.text) } : {}),
            artifact: {
              kind: 'answer',
              sessionId: answer.sessionId,
              turnId: answer.turnId,
              revision: answer.turnId,
              digest,
            },
          },
          { status: 'available', kind: 'answer', revision: answer.turnId },
        );
      }
    }
    if (wants('capture'))
      for (const capture of this.deps.store.listCaptures(access.write))
        add(
          {
            kind: 'capture',
            id: capture.captureId,
            label: capture.label ?? 'Screen',
            status: 'available',
            counts: emptyCounts(),
            capture,
            artifact: {
              kind: 'capture',
              id: capture.captureId,
              revision: capture.commit,
              digest: capture.digest,
            },
          },
          { status: 'available', kind: 'capture', revision: capture.commit },
        );
    assertCurrent(access);
    return artifacts;
  }

  async readItem(
    access: TaskReviewAccess,
    request: Request,
    kind: string,
    id: string,
  ): Promise<TaskReviewItem> {
    const artifact = (
      await this.artifacts(access, request, { kind, id }, true)
    ).get(key(kind, id));
    if (artifact?.item.status !== 'available')
      throw new TaskReviewError('not-found', 'Review item not found.');
    const threads = this.summaries(
      access,
      new Map([[key(kind, id), artifact]]),
      { kind, id },
    ).filter((thread) => thread.status === 'available');
    return { ...artifact.item, counts: countThreads(threads) };
  }

  async read(
    access: TaskReviewAccess,
    request: Request,
    state?: TaskReviewFilter,
  ): Promise<TaskReviewView> {
    const artifacts = await this.artifacts(access, request);
    const summaries = this.summaries(access, artifacts);
    const threads = summaries.filter((thread) => thread.status === 'available');
    for (const thread of threads) {
      const id = artifactId(thread.artifact);
      const itemKey = key(thread.artifact.kind, id);
      if (!artifacts.has(itemKey)) {
        if (thread.artifact.kind === 'plan')
          artifacts.delete(key('plan', 'plan'));
        artifacts.set(itemKey, {
          item: {
            kind: thread.artifact.kind,
            id,
            label:
              thread.artifact.kind === 'plan' ? 'Plan' : thread.artifact.kind,
            status: 'unavailable',
            counts: emptyCounts(),
          },
          current: { status: 'unavailable' },
        });
      }
    }
    const byItem = new Map<
      string,
      Extract<TaskReviewThreadSummary, { status: 'available' }>[]
    >();
    for (const thread of threads) {
      const itemKey = key(thread.artifact.kind, artifactId(thread.artifact));
      const group = byItem.get(itemKey) ?? [];
      group.push(thread);
      byItem.set(itemKey, group);
    }
    return {
      version: TASK_REVIEW_VERSION,
      taskId: access.write.taskId,
      taskCreatedAt: access.write.taskCreatedAt,
      items: [...artifacts.entries()].map(([itemKey, value]) => ({
        ...value.item,
        counts: countThreads(byItem.get(itemKey) ?? []),
      })),
      threads: state
        ? summaries.filter(
            (t) =>
              t.status === 'unavailable' || matchesTaskReviewFilter(t, state),
          )
        : summaries,
      counts: countThreads(threads),
      limits: TASK_REVIEW_LIMITS,
    };
  }

  async readThread(
    access: TaskReviewAccess,
    request: Request,
    threadId: string,
  ): Promise<TaskReviewThreadView> {
    let thread: TaskReviewThread | undefined;
    try {
      thread = this.deps.store.readThread({ ...access.write, threadId });
      if (thread && thread.projectId === access.write.projectId)
        return await this.project(access, request, thread);
    } catch (error) {
      if (error instanceof TaskReviewError) throw error;
      this.unavailable({ threadId, ordinal: 0, eventCount: 0 }, error);
      throw new TaskReviewError('unavailable', 'Review thread is unavailable.');
    }
    throw new TaskReviewError('not-found', 'Review thread not found.');
  }

  private async project(
    access: TaskReviewAccess,
    request: Request,
    thread: TaskReviewThread,
  ): Promise<TaskReviewThreadView> {
    const artifacts = await this.artifacts(access, request, {
      kind: thread.artifact.kind,
      id: artifactId(thread.artifact),
    });
    return this.derive(
      thread,
      artifacts.get(key(thread.artifact.kind, artifactId(thread.artifact)))
        ?.current ?? { status: 'unavailable' },
    );
  }

  async create(
    access: TaskReviewAccess,
    request: Request,
    input: TaskReviewCreateThreadRequest,
  ): Promise<TaskReviewThreadView> {
    const prior = this.deps.store
      .listThreads(access.write)
      .find((t) => t.operationId === input.operationId);
    let quote = prior?.quote;
    let current: TaskReviewCurrentArtifact | undefined;
    if (!prior) {
      const id = artifactId(input.artifact);
      const selected = (
        await this.artifacts(
          access,
          request,
          { kind: input.artifact.kind, id },
          input.anchor.kind !== 'whole' && input.anchor.kind !== 'region',
        )
      ).get(key(input.artifact.kind, id));
      const item = selected?.item;
      if (item?.status !== 'available')
        throw new TaskReviewError(
          'artifact-unavailable',
          'The current artifact is unavailable.',
        );
      current = selected?.current;
      if (
        item.artifact.revision !== input.artifact.revision ||
        item.artifact.digest !== input.artifact.digest
      )
        throw new TaskReviewError(
          'anchor-mismatch',
          'Reload the current artifact before commenting.',
        );
      if (!checkAnchorForArtifact(item.kind, input.anchor))
        throw new TaskReviewError(
          'anchor-mismatch',
          'The anchor does not match this artifact.',
        );
      const body = item.text;
      const anchor = input.anchor;
      if (anchor.kind === 'text-quote') {
        if (
          body === undefined ||
          body.slice(anchor.start, anchor.end) !== anchor.exact ||
          body.slice(
            Math.max(0, anchor.start - anchor.prefix.length),
            anchor.start,
          ) !== anchor.prefix ||
          body.slice(anchor.end, anchor.end + anchor.suffix.length) !==
            anchor.suffix
        )
          throw new TaskReviewError(
            'anchor-mismatch',
            'The quote does not occur at that position in this revision.',
          );
        quote = anchor.exact;
      } else if (anchor.kind === 'block') {
        const lines = body?.split('\n');
        if (!lines || anchor.endLine > lines.length)
          throw new TaskReviewError(
            'anchor-mismatch',
            'The block is outside this artifact.',
          );
        quote = lines.slice(anchor.startLine - 1, anchor.endLine).join('\n');
        if (parseTaskReviewQuote(quote) === null)
          throw new TaskReviewError(
            'anchor-mismatch',
            'The block must contain 1–2000 characters; select a nonempty, smaller block.',
          );
      }
    }
    if (
      input.anchor.kind === 'block' &&
      input.quote !== undefined &&
      input.quote !== quote
    )
      throw new TaskReviewError(
        'anchor-mismatch',
        'The retained quote does not match the selected block.',
      );
    assertCurrent(access);
    const result = this.deps.store.createThread({
      ...access.write,
      ...input,
      ...(input.anchor.kind === 'block' && quote !== undefined
        ? { quote }
        : {}),
    });
    if (!result.success) throw new TaskReviewError(result.code, result.error);
    return current
      ? this.derive(result.data, current)
      : this.project(access, request, result.data);
  }

  async append(
    access: TaskReviewAccess,
    request: Request,
    threadId: string,
    event: TaskReviewEventWrite,
  ): Promise<TaskReviewThreadView> {
    const result = this.deps.store.appendEvent({
      ...access.write,
      threadId,
      event,
    });
    if (!result.success) throw new TaskReviewError(result.code, result.error);
    return this.project(access, request, result.data);
  }
}
