import { createHash } from 'node:crypto';
import {
  checkAnchorForArtifact,
  countThreads,
  deriveThreadView,
  matchesTaskReviewFilter,
  normalizeTaskReviewText,
  parseTaskReviewQuote,
  TASK_REVIEW_LIMITS,
  TASK_REVIEW_VERSION,
  type TaskReviewArtifactRef,
  type TaskReviewCreateThreadRequest,
  type TaskReviewCurrentArtifact,
  type TaskReviewFailure,
  type TaskReviewFilter,
  type TaskReviewItem,
  type TaskReviewRefusalCode,
  type TaskReviewThread,
  type TaskReviewThreadView,
  type TaskReviewView,
} from '@kontourai/station-contracts/task-review';
import type { TaskReviewAccess } from '../orchestration/project-task-room-runtime.js';
import type { TaskMemoryStore } from '../orchestration/task-memory-store.js';
import type {
  TaskReviewEventWrite,
  TaskReviewStore,
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
  constructor(private readonly deps: Dependencies) {}

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
      if (plan.kind === 'available')
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
              digest: hash(normalizeTaskReviewText(plan.text)),
            },
          },
          {
            status: 'available',
            kind: 'plan',
            revision: plan.revision,
            text: plan.text,
          },
        );
      else unavailable('plan', target?.id ?? 'plan', 'Plan');
    }
    if (wants('summary')) {
      const summary = this.deps.memory.readSummary(access.write);
      if (summary)
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
              digest: hash(normalizeTaskReviewText(summary.text)),
            },
          },
          {
            status: 'available',
            kind: 'summary',
            revision: summary.revision,
            text: summary.text,
          },
        );
      else unavailable('summary', 'summary', 'Brief');
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
              digest: hash(normalizeTaskReviewText(answer.text)),
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
    const threads = this.deps.store
      .listThreads(access.write)
      .filter(
        (thread) =>
          thread.artifact.kind === kind && artifactId(thread.artifact) === id,
      )
      .map((thread) => deriveThreadView(thread, artifact.current));
    return { ...artifact.item, counts: countThreads(threads) };
  }

  async read(
    access: TaskReviewAccess,
    request: Request,
    state?: TaskReviewFilter,
  ): Promise<TaskReviewView> {
    const artifacts = await this.artifacts(access, request);
    const threads = this.deps.store
      .listThreads(access.write)
      .map((thread) =>
        deriveThreadView(
          thread,
          artifacts.get(key(thread.artifact.kind, artifactId(thread.artifact)))
            ?.current ?? { status: 'unavailable' },
        ),
      );
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
    const byItem = new Map<string, TaskReviewThreadView[]>();
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
        ? threads.filter((t) => matchesTaskReviewFilter(t, state))
        : threads,
      counts: countThreads(threads),
      limits: TASK_REVIEW_LIMITS,
    };
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
    return deriveThreadView(
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
      ? deriveThreadView(result.data, current)
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
