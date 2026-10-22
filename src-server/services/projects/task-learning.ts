/**
 * #4003 layer 4 (Learning): a done Task's standing decisions and dead ends
 * as candidates for its Project's knowledge store, reviewed by a person.
 *
 * - Candidates are DERIVED on read from Task memory
 *   (`TaskMemoryStore.listStandingRecords`). Nothing is copied until a
 *   person promotes one.
 * - A promotion is one `create` through the Project store's own adapter
 *   (`KnowledgeStoreProvider.adapterFor`), the same write path
 *   `POST /api/knowledge/roots/:rootId/records` uses, with the Task, record
 *   version and work item in the record's creation provenance.
 * - The record's id is derived from the Task incarnation and the record
 *   version, so a store refuses a second record for one version.
 * - Across stores, a version is promoted once (review F9): before the
 *   knowledge write, the promotion inserts one append-only row naming its
 *   store (`task_learning_promotions`, migration 022). A later or
 *   concurrent promotion of that version finds the row and writes, or reads
 *   back, only in that store, so two people choosing two stores still get
 *   one record. When the row's write failed or was interrupted, the next
 *   promotion finishes it in the row's store, with that request's edited
 *   title and text. A version whose recorded store has since been removed
 *   from the Project stays `no-store`: it is never written anywhere else.
 *   The dismissal check runs inside the row's transaction too, and a
 *   dismissal is refused once the row exists, so a claimed promotion whose
 *   write failed can still be finished. "Promoted"
 *   in the candidate list is still read back from the stores.
 * - A dismissal is kept in `task_learning_dismissals` (migration 021).
 *
 * Authority is the caller's: the routes pass a person's Task-room access.
 * No station-control tool names these routes, so an agent never reaches them.
 */
import { createHash } from 'node:crypto';
import type {
  KitRecord,
  KnowledgeStoreProvider,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  TASK_LEARNING_LIMITS,
  TASK_LEARNING_VERSION,
  type TaskLearningCandidate,
  type TaskLearningDismissal,
  type TaskLearningKind,
  type TaskLearningPromotion,
  type TaskLearningStore,
  type TaskLearningView,
  type TaskMemoryRecord,
} from '@kontourai/station-contracts/task-memory';
import { CONVERSATION_STORE_ADAPTER_ID } from '../../knowledge-store/adapters/conversation-store.js';
import type {
  TaskLearningDismissalRecord,
  TaskMemoryIncarnation,
  TaskMemoryStore,
} from '../orchestration/task-memory-store.js';

/** `provenance.agent` of a promoted record: the process that wrote it. */
export const TASK_LEARNING_PROVENANCE_AGENT = 'station-task-learning';

const CATEGORY: Record<TaskLearningKind, string> = {
  decision: 'task-learning.decisions',
  dead_end: 'task-learning.dead-ends',
};
const KIND_SLUG: Record<TaskLearningKind, string> = {
  decision: 'decision',
  dead_end: 'dead-end',
};

/** A person's Task-room access, as `ProjectTaskRoomRuntime` grants it. */
export interface TaskLearningAccess {
  readonly memory: TaskMemoryStore;
  readonly task: TaskRecord;
  /** The room's Project id, which dismissals are recorded under. */
  readonly projectId: string;
  /** The Project slug its knowledge stores are scoped by. */
  readonly projectSlug: string;
  readonly principalId: string;
  /** False once the Task incarnation or its room changed. */
  readonly isCurrent: () => boolean;
}

export type TaskLearningRefusal =
  | { readonly kind: 'not-done' }
  | { readonly kind: 'not-a-candidate' }
  | { readonly kind: 'was-dismissed' }
  /** A promotion of this version stands; it cannot be dismissed. */
  | { readonly kind: 'was-promoted' }
  | { readonly kind: 'no-store' }
  | { readonly kind: 'invalid'; readonly field: 'title' | 'text' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'store-failed'; readonly error: unknown };

export type TaskLearningPromoteResult =
  | {
      readonly kind: 'promoted' | 'already-promoted';
      readonly rootId: string;
      readonly record: KitRecord;
    }
  | TaskLearningRefusal;

export type TaskLearningDismissOutcome =
  | {
      readonly kind: 'dismissed' | 'already-dismissed';
      readonly dismissal: TaskLearningDismissalRecord;
    }
  | TaskLearningRefusal;

const incarnationOf = (task: TaskRecord): TaskMemoryIncarnation => ({
  taskId: task.id,
  taskCreatedAt: task.createdAt,
});

/**
 * The knowledge record id a promotion of this record version writes: the
 * kind, key and version, readable in the store's files, then a digest of
 * the Task incarnation and that version (a re-created Task's records are new
 * ones). The fixed-length digest at the end keeps one candidate's id from
 * being a prefix of another's, since a store's `get` also resolves prefixes.
 */
export function taskLearningKnowledgeRecordId(
  incarnation: TaskMemoryIncarnation,
  record: { readonly kind: TaskLearningKind; key: string; version: number },
): string {
  const readable = `${KIND_SLUG[record.kind]}-${record.key}-v${record.version}`;
  const digest = createHash('sha256')
    .update(`${incarnation.taskId}\n${incarnation.taskCreatedAt}\n${readable}`)
    .digest('hex')
    .slice(0, 16);
  return `task-${readable}-${digest}`;
}

/** The Project's stores a person can promote into: writable, Project-scoped. */
async function projectStores(
  store: KnowledgeStoreProvider,
  projectSlug: string,
): Promise<KnowledgeStoreRoot[]> {
  return (await store.listRoots()).filter(
    (root) =>
      root.scope.kind === 'project' &&
      root.scope.projectSlug === projectSlug &&
      root.adapterId !== CONVERSATION_STORE_ADAPTER_ID,
  );
}

function standingCandidates(
  access: TaskLearningAccess,
): Array<TaskMemoryRecord & { kind: TaskLearningKind }> {
  const { decisions, deadEnds } = access.memory.listStandingRecords(
    incarnationOf(access.task),
  );
  return [...decisions, ...deadEnds] as Array<
    TaskMemoryRecord & { kind: TaskLearningKind }
  >;
}

/** The store holding this id, if any: a promotion is read back, not recorded. */
async function findPromoted(
  store: KnowledgeStoreProvider,
  roots: readonly KnowledgeStoreRoot[],
  id: string,
): Promise<{ rootId: string; record: KitRecord } | undefined> {
  for (const root of roots) {
    const record = await (await store.adapterFor(root.id)).get(id);
    // `get` also resolves aliases and id prefixes; only the exact id counts.
    if (record?.id === id) return { rootId: root.id, record };
  }
  return undefined;
}

export async function readTaskLearning(
  store: KnowledgeStoreProvider,
  access: TaskLearningAccess,
): Promise<TaskLearningView> {
  const roots = await projectStores(store, access.projectSlug);
  const offered = access.task.status === 'done';
  const incarnation = incarnationOf(access.task);
  const candidates: TaskLearningCandidate[] = [];
  if (offered) {
    const dismissals = new Map(
      access.memory
        .listLearningDismissals(incarnation)
        .map((d) => [`${d.kind}:${d.key}:${d.version}`, d]),
    );
    for (const record of standingCandidates(access)) {
      const knowledgeRecordId = taskLearningKnowledgeRecordId(
        incarnation,
        record,
      );
      const dismissed = dismissals.get(
        `${record.kind}:${record.key}:${record.version}`,
      );
      const promoted = dismissed
        ? undefined
        : await findPromoted(store, roots, knowledgeRecordId);
      candidates.push({
        record,
        knowledgeRecordId,
        review: dismissed
          ? {
              state: 'dismissed',
              dismissedAt: dismissed.dismissedAt,
              dismissedBy: dismissed.principalId,
            }
          : promoted
            ? { state: 'promoted', rootId: promoted.rootId, knowledgeRecordId }
            : { state: 'open' },
      });
    }
  }
  const stores: TaskLearningStore[] = roots.map((root) => ({
    rootId: root.id,
    displayName: root.displayName,
  }));
  return {
    version: TASK_LEARNING_VERSION,
    taskId: access.task.id,
    offered,
    projectSlug: access.projectSlug,
    ...(access.task.workItemRef
      ? { workItemRef: access.task.workItemRef }
      : {}),
    stores,
    candidates,
    limits: TASK_LEARNING_LIMITS,
  };
}

/** The current candidate for this version, or why there is none. */
function candidateFor(
  access: TaskLearningAccess,
  wanted: TaskLearningDismissal,
):
  | { kind: 'candidate'; record: TaskMemoryRecord & { kind: TaskLearningKind } }
  | TaskLearningRefusal {
  if (access.task.status !== 'done') return { kind: 'not-done' };
  const record = standingCandidates(access).find(
    (r) =>
      r.kind === wanted.kind &&
      r.key === wanted.key &&
      r.version === wanted.version,
  );
  return record ? { kind: 'candidate', record } : { kind: 'not-a-candidate' };
}

function provenanceNote(
  access: TaskLearningAccess,
  record: TaskMemoryRecord,
): string {
  return [
    `Promoted by ${access.principalId} from Station Task memory.`,
    `task: ${access.task.id}`,
    `task created: ${access.task.createdAt}`,
    `record: ${record.kind}/${record.key} v${record.version}`,
    ...(access.task.workItemRef
      ? [`work item: ${access.task.workItemRef}`]
      : []),
  ].join('\n');
}

export async function promoteTaskLearning(
  store: KnowledgeStoreProvider,
  access: TaskLearningAccess,
  promotion: TaskLearningPromotion,
): Promise<TaskLearningPromoteResult> {
  const title = promotion.title.trim();
  const body = promotion.text.trim();
  if (!title || title.length > TASK_LEARNING_LIMITS.titleChars)
    return { kind: 'invalid', field: 'title' };
  if (!body || body.length > TASK_LEARNING_LIMITS.bodyChars)
    return { kind: 'invalid', field: 'text' };
  const found = candidateFor(access, promotion);
  if (found.kind !== 'candidate') return found;
  const { record } = found;
  const incarnation = incarnationOf(access.task);
  const dismissed = access.memory
    .listLearningDismissals(incarnation)
    .some(
      (d) =>
        d.kind === record.kind &&
        d.key === record.key &&
        d.version === record.version,
    );
  if (dismissed) return { kind: 'was-dismissed' };
  const roots = await projectStores(store, access.projectSlug);
  const root = roots.find((r) => r.id === promotion.rootId);
  if (!root) return { kind: 'no-store' };
  const id = taskLearningKnowledgeRecordId(incarnation, record);
  try {
    // Any Project store already holding this version: it was promoted.
    const existing = await findPromoted(store, roots, id);
    if (existing) return { kind: 'already-promoted', ...existing };
    // The one decision across stores, made before the knowledge write.
    const claim = access.memory.claimLearningPromotion({
      ...incarnation,
      kind: record.kind,
      key: record.key,
      version: record.version,
      projectId: access.projectId,
      rootId: root.id,
      principalId: access.principalId,
      beforeCommit: access.isCurrent,
    });
    if (claim.kind === 'stale') return { kind: 'stale' };
    if (claim.kind === 'dismissed') return { kind: 'was-dismissed' };
    const target = roots.find((r) => r.id === claim.promotion.rootId);
    // The store this version was first promoted into is no longer one of
    // the Project's: nothing is written anywhere else.
    if (!target) return { kind: 'no-store' };
    if (claim.kind === 'existing') {
      const done = await findPromoted(store, [target], id);
      if (done) return { kind: 'already-promoted', ...done };
    }
    if (!access.isCurrent()) return { kind: 'stale' };
    const adapter = await store.adapterFor(target.id);
    try {
      await adapter.create({
        id,
        type: 'raw',
        title,
        body,
        category: CATEGORY[record.kind],
        tags: ['task-learning', KIND_SLUG[record.kind]],
        provenance: {
          agent: TASK_LEARNING_PROVENANCE_AGENT,
          ...(record.author.kind === 'session'
            ? { session_id: record.author.sessionId }
            : {}),
          note: provenanceNote(access, record),
        },
      });
    } catch (error) {
      // A concurrent promotion of the same version won the create: the store
      // refuses an existing id, so read back the record it wrote.
      const raced = await findPromoted(store, [target], id);
      if (raced) return { kind: 'already-promoted', ...raced };
      throw error;
    }
    const written = await adapter.get(id);
    if (!written)
      throw new Error('The promoted record could not be read back.');
    return { kind: 'promoted', rootId: target.id, record: written };
  } catch (error) {
    return { kind: 'store-failed', error };
  }
}

export function dismissTaskLearning(
  access: TaskLearningAccess,
  dismissal: TaskLearningDismissal,
): TaskLearningDismissOutcome {
  if (access.task.status !== 'done') return { kind: 'not-done' };
  const result = access.memory.dismissLearningCandidate({
    ...incarnationOf(access.task),
    ...dismissal,
    projectId: access.projectId,
    principalId: access.principalId,
    beforeCommit: access.isCurrent,
  });
  return result.kind === 'promoted' ? { kind: 'was-promoted' } : result;
}
