import { createHash } from 'node:crypto';
import {
  deriveThreadView,
  TASK_REVIEW_LIMITS,
  TASK_REVIEW_VERSION,
  type TaskReviewArtifactRef,
  type TaskReviewCounts,
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
  deliveryStatus?: (thread: TaskReviewThread) => 'confirmed' | 'unconfirmed';
  memory: Pick<TaskMemoryStore, 'readSummary'>;
  outputs: Pick<TaskOutputModule, 'list' | 'read' | 'readContent'>;
  readPlan(
    taskId: string,
    request: Request,
  ): Promise<
    | { kind: 'available'; documentId: string; revision: string; text: string }
    | { kind: 'unavailable' }
  >;
  readAnswers(
    taskId: string,
    request: Request,
  ): Promise<readonly { id: string; turnId: string; text: string }[]>;
}
type Artifact = {
  item: TaskReviewItem;
  current: TaskReviewCurrentArtifact;
};
const counts = (): TaskReviewCounts => ({ open: 0, outdated: 0, resolved: 0 });
const hash = (text: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const key = (kind: string, id: string) => JSON.stringify([kind, id]);
const assertCurrent = (access: TaskReviewAccess) => {
  if (!access.write.beforeCommit())
    throw new TaskReviewError('not-found', 'Task not found.');
};

/** Read-time artifact resolution. Review writes reach only its SQLite store. */
export class TaskReviewModule {
  constructor(private readonly deps: Dependencies) {}

  private async artifacts(
    access: TaskReviewAccess,
    request: Request,
  ): Promise<Map<string, Artifact>> {
    const { taskId } = access.write;
    const artifacts = new Map<string, Artifact>();
    const add = (item: TaskReviewItem, current: TaskReviewCurrentArtifact) =>
      artifacts.set(key(item.kind, item.id), { item, current });
    const unavailable = (
      kind: TaskReviewItem['kind'],
      id: string,
      label: string,
    ) =>
      add(
        { kind, id, label, status: 'unavailable', counts: counts() },
        { status: 'unavailable' },
      );
    const plan = await this.deps
      .readPlan(taskId, request)
      .catch(() => ({ kind: 'unavailable' as const }));
    if (plan.kind === 'available') {
      add(
        {
          kind: 'plan',
          id: plan.documentId,
          label: 'Plan',
          status: 'available',
          counts: counts(),
          text: plan.text,
          artifact: {
            kind: 'plan',
            id: plan.documentId,
            revision: plan.revision,
            digest: hash(plan.text),
          },
        },
        {
          status: 'available',
          kind: 'plan',
          revision: plan.revision,
          text: plan.text,
        },
      );
    } else unavailable('plan', 'plan', 'Plan');
    const summary = this.deps.memory.readSummary(access.write);
    if (summary)
      add(
        {
          kind: 'summary',
          id: 'summary',
          label: 'Brief',
          status: 'available',
          counts: counts(),
          text: summary.text,
          artifact: {
            kind: 'summary',
            id: 'summary',
            revision: String(summary.revision),
            digest: hash(summary.text),
          },
        },
        {
          status: 'available',
          kind: 'summary',
          revision: String(summary.revision),
          text: summary.text,
        },
      );
    else unavailable('summary', 'summary', 'Brief');
    try {
      const outputs = await this.deps.outputs.list(taskId);
      for (let index = 0; index < outputs.length; index++) {
        const output = outputs[index]!;
        // Read through the output owner; its digest identifies the kept snapshot.
        const current = await this.deps.outputs.read(taskId, output.id);
        const revision = current.materialization.digest;
        const content = /^(text\/|application\/(json|xml))/.test(
          current.materialization.mediaType,
        )
          ? await this.deps.outputs.readContent(taskId, current.id)
          : undefined;
        add(
          {
            kind: 'output',
            id: current.id,
            label: current.title,
            ...(content ? { text: content.bytes.toString('utf8') } : {}),
            status: 'available',
            counts: counts(),
            artifact: {
              kind: 'output',
              id: current.id,
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
    } catch {
      // Retained output threads below stay readable with unknown freshness.
    }
    for (const answer of await this.deps
      .readAnswers(taskId, request)
      .catch(() => [])) {
      add(
        {
          kind: 'answer',
          id: answer.id,
          label: 'Answer',
          status: 'available',
          counts: counts(),
          text: answer.text,
          artifact: {
            kind: 'answer',
            id: answer.id,
            revision: answer.turnId,
            digest: hash(answer.text),
          },
        },
        { status: 'available', kind: 'answer', revision: answer.turnId },
      );
    }
    for (const capture of this.deps.store.listCaptures(access.write)) {
      add(
        {
          kind: 'capture',
          id: capture.captureId,
          label: capture.label ?? 'Screen',
          status: 'available',
          counts: counts(),
          capture,
          artifact: {
            kind: 'capture',
            id: capture.captureId,
            revision: capture.digest,
            digest: capture.digest,
          },
        },
        { status: 'available', kind: 'capture', revision: capture.digest },
      );
    }
    assertCurrent(access);
    return artifacts;
  }

  private threadView(
    thread: TaskReviewThread,
    artifacts: Map<string, Artifact>,
  ): TaskReviewThreadView {
    const current = artifacts.get(key(thread.artifact.kind, thread.artifact.id))
      ?.current ?? { status: 'unavailable' };
    return deriveThreadView(thread, {
      ...current,
      deliveryStatus: this.deps.deliveryStatus?.(thread) ?? 'unconfirmed',
    });
  }

  async read(
    access: TaskReviewAccess,
    request: Request,
    state?: TaskReviewFilter,
  ): Promise<TaskReviewView> {
    const artifacts = await this.artifacts(access, request);
    const threads = this.deps.store
      .listThreads(access.write)
      .map((thread) => this.threadView(thread, artifacts));
    const total = { open: 0, outdated: 0, resolved: 0 };
    for (const thread of threads) {
      const bucket =
        thread.state === 'resolved'
          ? 'resolved'
          : thread.outdated === true
            ? 'outdated'
            : 'open';
      total[bucket]++;
      const artifactKey = key(thread.artifact.kind, thread.artifact.id);
      let artifact = artifacts.get(artifactKey);
      if (!artifact) {
        artifact = {
          item: {
            kind: thread.artifact.kind,
            id: thread.artifact.id,
            label:
              thread.artifact.kind === 'plan' ? 'Plan' : thread.artifact.kind,
            status: 'unavailable',
            counts: counts(),
          },
          current: { status: 'unavailable' },
        };
        // Replace the placeholder plan rather than showing two Plan items.
        if (thread.artifact.kind === 'plan')
          artifacts.delete(key('plan', 'plan'));
        artifacts.set(artifactKey, artifact);
      }
      artifact.item = {
        ...artifact.item,
        counts: {
          ...artifact.item.counts,
          [bucket]: artifact.item.counts[bucket] + 1,
        },
      };
    }
    return {
      version: TASK_REVIEW_VERSION,
      taskId: access.write.taskId,
      taskCreatedAt: access.write.taskCreatedAt,
      items: [...artifacts.values()].map((value) => value.item),
      threads: state
        ? threads.filter((t) =>
            state === 'open'
              ? t.state !== 'resolved' && t.outdated !== true
              : t.state === state,
          )
        : threads,
      counts: total,
      limits: TASK_REVIEW_LIMITS,
    };
  }

  async create(
    access: TaskReviewAccess,
    request: Request,
    input: TaskReviewCreateThreadRequest,
  ): Promise<TaskReviewThreadView> {
    const prior = this.deps.store
      .listThreads(access.write)
      .find((t) => t.operationId === input.operationId);
    let quote: string | undefined;
    if (!prior) {
      const artifacts = await this.artifacts(access, request);
      const item = artifacts.get(
        key(input.artifact.kind, input.artifact.id),
      )?.item;
      if (item?.status !== 'available')
        throw new TaskReviewError(
          'artifact-unavailable',
          'The current artifact is unavailable.',
        );
      const ref: TaskReviewArtifactRef = item.artifact;
      if (
        ref.revision !== input.artifact.revision ||
        ref.digest !== input.artifact.digest
      )
        throw new TaskReviewError(
          'anchor-mismatch',
          'Reload the current artifact before commenting.',
        );
      let body = item.text;
      if (item.kind === 'output' && input.anchor.kind !== 'whole') {
        const content = await this.deps.outputs.readContent(
          access.write.taskId,
          item.id,
        );
        if (
          !/^(text\/|application\/(json|xml))/.test(
            content.output.materialization.mediaType,
          )
        )
          throw new TaskReviewError(
            'anchor-mismatch',
            'This output accepts whole-artifact comments.',
          );
        body = content.bytes.toString('utf8');
      }
      const anchor = input.anchor;
      if (
        (anchor.kind === 'region') !== (item.kind === 'capture') &&
        anchor.kind !== 'whole'
      )
        throw new TaskReviewError(
          'anchor-mismatch',
          'The anchor does not match this artifact.',
        );
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
        if (!quote || quote.length > TASK_REVIEW_LIMITS.quoteChars)
          throw new TaskReviewError(
            'anchor-mismatch',
            'The retained quote exceeds the quote bound; select a smaller block.',
          );
      } else if (
        anchor.kind === 'whole' &&
        body &&
        body.length <= TASK_REVIEW_LIMITS.quoteChars
      )
        quote = body;
    }
    assertCurrent(access);
    const result = this.deps.store.createThread({
      ...access.write,
      ...input,
      ...(quote ? { quote } : {}),
    });
    if (!result.success) throw new TaskReviewError(result.code, result.error);
    return (await this.read(access, request)).threads.find(
      (t) => t.threadId === result.data.threadId,
    )!;
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
    return (await this.read(access, request)).threads.find(
      (t) => t.threadId === threadId,
    )!;
  }
}
