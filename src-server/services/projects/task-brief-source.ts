/**
 * Gathers what a Task brief is built from (epic #4003): the Task record, the
 * Task document (the person-authored brief it was seeded with), Task memory
 * (summary and records), the Task's Sessions with their digest facts and
 * active claims, and a fresh read of the linked tracker item. The builder itself is pure
 * (`task-brief.ts`); this module owns the reads and their failure words.
 *
 * Both dispatch and `get_task_brief` re-read the item through the runtime's
 * one `WorkItemObserver`, asking for comments since
 * `TaskRecord.workItemObservedAt` (or the Task's creation). Only dispatch
 * reports the read's time back, so only a dispatch advances that mark: a
 * `get_task_brief` call is the Session catching up, and must not hide new
 * comments from the next Session dispatched.
 *
 * Authority is the caller's: `forDispatch` runs inside an already admitted
 * dispatch, and `forSession` / `listingForSession` derive the Task from the
 * Session's immutable server-owned room execution binding, never from an
 * argument.
 *
 * Whose Sessions (review F10): the brief's Session lines and claims name
 * only Sessions the receiving Session's owner may read (`canUserReadSession`
 * under that owner's read authority), as `list_project_activity` does; the
 * receiving Session itself is always shown. With no owner known, no other
 * Session is shown.
 */

import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { sessionLadderWord } from '@kontourai/station-contracts/session-attention';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type {
  TaskMemoryRecord,
  TaskSummaryRevision,
} from '@kontourai/station-contracts/task-memory';
import {
  INTERNAL_SESSION_READ_SCOPE,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { WORK_CLAIM_MAX_ACTIVE_PER_SESSION } from '../../routes/orchestration/work-claim-limits.js';
import type { EventStore } from '../orchestration/event-store.js';
import {
  type DigestTurn,
  readSessionDigestHead,
} from '../orchestration/session-digest.js';
import type { TaskMemoryIncarnation } from '../orchestration/task-memory-store.js';
import {
  type ActiveWorkClaimReader,
  composeActiveWorkClaimReader,
} from '../orchestration/work-claims.js';
import type { WorkItemObserver } from '../work-item-providers/github-work-item-observer.js';
import {
  buildTaskBrief,
  renderTaskRecordListing,
  renderTaskSummaryHistory,
  TASK_BRIEF_SUMMARY_HISTORY_REVISIONS,
  type TaskBriefInclude,
  type TaskBriefInput,
  type TaskBriefObservation,
  type TaskBriefSessionFacts,
  type TaskBriefSnapshot,
} from './task-brief.js';

/**
 * Dispatch and `get_task_brief` wait at most this long for the tracker read.
 * Past it the read is aborted, which stops its gh process, and the brief says
 * the item was not re-read; the dispatch goes ahead.
 */
const TASK_BRIEF_OBSERVE_TIMEOUT_MS = 10_000;

export interface TaskBriefSessionFactsRead {
  /** The ladder word `list_project_activity` reports. */
  status?: string;
  turnCount?: number;
  lastTurn?: DigestTurn;
}

/** The Task memory reads a brief needs: `TaskMemoryStore`'s own. */
export interface TaskBriefMemoryReader {
  readSummary(input: TaskMemoryIncarnation): TaskSummaryRevision | undefined;
  listRecords(input: TaskMemoryIncarnation): TaskMemoryRecord[];
  listSummaryRevisions(input: TaskMemoryIncarnation & { limit: number }): {
    revisions: TaskSummaryRevision[];
    total: number;
  };
}

export interface TaskBriefSourceDeps {
  readTask(taskId: string): TaskRecord | null;
  /** Every Session dispatched for the Task, oldest first. */
  listTaskSessions(
    taskId: string,
  ): readonly { sessionId: string; provider?: string; createdAt: string }[];
  readDocument(taskId: string): Promise<TaskBriefInput['document']>;
  /** Absent: the Task memory store is not running. */
  memory?: TaskBriefMemoryReader;
  /**
   * The Task's active claims (`work-claims.ts`). Absent: no claim store is
   * running, and Session lines carry no claims.
   */
  workClaims?: Pick<ActiveWorkClaimReader, 'listActiveClaims'>;
  /**
   * The opaque Project id claims are scoped by, for the Task's own Project
   * identity (often its slug; verifier V1). Absent: the Task's `projectId`
   * as stored. Present and unresolved: no claims are read.
   */
  localProjectIdFor?(identity: string): string | undefined;
  /**
   * Whether `viewerUserId` may read `sessionId`. Absent: every Session of
   * the Task is shown (tests that compose no read model).
   */
  canViewerRead?(viewerUserId: string, sessionId: string): boolean;
  /** The recorded owner of a Session, for `forSession`'s viewer. */
  ownerOf?(sessionId: string): string | undefined;
  /** Recorded facts per Session; a Session it cannot read is absent. */
  sessionFacts?(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, TaskBriefSessionFactsRead>>;
  /** The immutable Session → Task binding (`project_task_room_execution_bindings`). */
  readBinding(
    sessionId: string,
  ): { projectId: string; taskId: string } | undefined;
  /** The runtime's one exact-identity tracker reader. */
  workItemObserver: WorkItemObserver;
  observeTimeoutMs?: number;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

export type TaskBriefForSession =
  | { kind: 'brief'; brief: TaskBriefSnapshot }
  | { kind: 'unbound' }
  | { kind: 'unavailable'; reason: string };

export type TaskBriefListingForSession =
  | {
      kind: 'listing';
      listing: { taskId: string; include: TaskBriefInclude; text: string };
    }
  | { kind: 'unbound' }
  | { kind: 'unavailable'; reason: string };

export interface TaskBriefForDispatch {
  brief: TaskBriefSnapshot;
  /**
   * The tracker read's `observedAt`, present only when the linked item was
   * observed. The dispatcher records it as `TaskRecord.workItemObservedAt`
   * once the dispatch is associated, and never otherwise.
   */
  workItemObservedAt?: string;
}

export interface TaskBriefSource {
  /** The brief a Session dispatched for `task` receives with its first turn. */
  forDispatch(
    task: TaskRecord,
    sessionId: string,
    /** The dispatched Session's owner: whose read authority the lines use. */
    ownerUserId?: string,
  ): Promise<TaskBriefForDispatch>;
  /** The current brief for the Task the Session is bound to. */
  forSession(sessionId: string): Promise<TaskBriefForSession>;
  /** What the brief only counts: every record, or the summary's history. */
  listingForSession(
    sessionId: string,
    include: TaskBriefInclude,
  ): Promise<TaskBriefListingForSession>;
}

type WorkClaimRecordLike = Awaited<
  ReturnType<ActiveWorkClaimReader['listActiveClaims']>
>[number];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const incarnationOf = (task: TaskRecord): TaskMemoryIncarnation => ({
  taskId: task.id,
  taskCreatedAt: task.createdAt,
});

export function createTaskBriefSource(
  deps: TaskBriefSourceDeps,
): TaskBriefSource {
  const readDocument = async (
    taskId: string,
  ): Promise<TaskBriefInput['document']> => {
    try {
      return await deps.readDocument(taskId);
    } catch (error) {
      return { kind: 'unavailable', reason: errorText(error) };
    }
  };

  const readMemory = (task: TaskRecord): TaskBriefInput['memory'] => {
    if (!deps.memory)
      return { kind: 'unavailable', reason: 'Task memory is not running' };
    try {
      const incarnation = incarnationOf(task);
      const summary = deps.memory.readSummary(incarnation);
      return {
        kind: 'available',
        ...(summary ? { summary } : {}),
        records: deps.memory.listRecords(incarnation),
      };
    } catch (error) {
      return { kind: 'unavailable', reason: errorText(error) };
    }
  };

  /** Active claims by claiming Session; a failed read leaves lines bare. */
  const claimsBySession = async (
    task: TaskRecord,
  ): Promise<Map<string, WorkClaimRecordLike[]>> => {
    const bySession = new Map<string, WorkClaimRecordLike[]>();
    if (!deps.workClaims) return bySession;
    try {
      const projectId = deps.localProjectIdFor
        ? deps.localProjectIdFor(task.projectId)
        : task.projectId;
      if (projectId === undefined) return bySession;
      const claims = await deps.workClaims.listActiveClaims({
        projectId,
        taskId: task.id,
      });
      for (const claim of claims) {
        const list = bySession.get(claim.sessionId) ?? [];
        list.push(claim);
        bySession.set(claim.sessionId, list);
      }
    } catch (error) {
      deps.logger?.warn('Task brief work-claims read failed', {
        taskId: task.id,
        error: errorText(error),
      });
    }
    return bySession;
  };

  const sessions = async (
    task: TaskRecord,
    sessionId: string,
    viewerUserId: string | undefined,
  ): Promise<TaskBriefSessionFacts[]> => {
    const taskId = task.id;
    // Only Sessions the viewer may read, and always the viewer's own.
    const visible = (id: string) =>
      id === sessionId ||
      !deps.canViewerRead ||
      (viewerUserId !== undefined && deps.canViewerRead(viewerUserId, id));
    const claims = new Map(
      [...(await claimsBySession(task))].filter(([claimant]) =>
        visible(claimant),
      ),
    );
    const dispatched = deps
      .listTaskSessions(taskId)
      .filter((session) => visible(session.sessionId));
    // A claim's Session was bound to this Task when it claimed (the Task id is
    // stamped from that binding), so a claimant missing from the dispatch
    // list is still one of the Task's Sessions: give it a line rather than
    // drop what it is on.
    for (const [claimant, held] of claims)
      if (!dispatched.some((session) => session.sessionId === claimant))
        dispatched.push({
          sessionId: claimant,
          createdAt: held[held.length - 1]!.claimedAt,
        });
    let facts: ReadonlyMap<string, TaskBriefSessionFactsRead> = new Map();
    try {
      facts =
        (await deps.sessionFacts?.(
          dispatched.map((session) => session.sessionId),
        )) ?? facts;
    } catch (error) {
      // Facts are the brief's extra; without them each line says only what
      // the dispatch recorded.
      deps.logger?.warn('Task brief Session facts read failed', {
        taskId,
        error: errorText(error),
      });
    }
    return dispatched.map((session) => {
      const read = facts.get(session.sessionId);
      const held = claims.get(session.sessionId);
      return {
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        ...(session.provider ? { provider: session.provider } : {}),
        ...(read?.status ? { status: read.status } : {}),
        ...(read?.turnCount !== undefined ? { turnCount: read.turnCount } : {}),
        ...(read?.lastTurn ? { lastTurn: read.lastTurn } : {}),
        ...(session.sessionId === sessionId ? { self: true } : {}),
        ...(held
          ? {
              claims: held.map((claim) => ({
                ...(claim.workItemRef
                  ? { workItemRef: claim.workItemRef }
                  : {}),
                ...(claim.paths.length ? { paths: claim.paths } : {}),
                expiresAt: claim.expiresAt,
              })),
            }
          : {}),
      };
    });
  };

  const observe = async (
    task: TaskRecord,
  ): Promise<TaskBriefObservation | undefined> => {
    const ref = task.workItemRef;
    if (!ref) return undefined;
    // Review F4: the host's tracker login reads only a ref that entered
    // through a board check (Start Task, or a board-checked create).
    if (task.workItemProvenance !== 'project-board')
      return {
        status: 'not-read',
        reason: "the ref was not checked against the Project's board",
      };
    // Comments newer than the last time a dispatch read the item, or than
    // the Task's creation when none has (Start Task records its own read).
    const commentsSince = task.workItemObservedAt ?? task.createdAt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = new AbortController();
    try {
      const result = await Promise.race([
        deps.workItemObserver.observeWorkItem(ref, {
          commentsSince,
          signal: stop.signal,
        }),
        new Promise<TaskBriefObservation>((resolve) => {
          timer = setTimeout(() => {
            // Settle as timed out first, then stop the read itself, not
            // only the wait for it (review F8).
            resolve({ status: 'not-read', reason: 'timed out' });
            stop.abort();
          }, deps.observeTimeoutMs ?? TASK_BRIEF_OBSERVE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      // Exact identity: an answer about another item is no answer.
      if (
        result.status === 'observed' &&
        result.observation.workItemRef !== ref
      )
        return {
          status: 'unavailable',
          reason: 'the tracker answered for a different item',
        };
      return result;
    } catch (error) {
      deps.logger?.warn('Task brief tracker read failed', {
        taskId: task.id,
        error: errorText(error),
      });
      return { status: 'not-read', reason: 'the tracker read failed' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** The bound Task, or why there is none. */
  const boundTask = (
    sessionId: string,
  ):
    | { kind: 'task'; task: TaskRecord; projectId: string }
    | { kind: 'unbound' }
    | { kind: 'unavailable'; reason: string } => {
    const binding = deps.readBinding(sessionId);
    if (!binding) return { kind: 'unbound' };
    const task = deps.readTask(binding.taskId);
    if (!task || task.projectId !== binding.projectId)
      return {
        kind: 'unavailable',
        reason: 'The Task this session was dispatched for no longer exists.',
      };
    return { kind: 'task', task, projectId: binding.projectId };
  };

  return {
    async forDispatch(task, sessionId, ownerUserId) {
      const [document, observation, lines] = await Promise.all([
        readDocument(task.id),
        observe(task),
        sessions(task, sessionId, ownerUserId),
      ]);
      const brief = buildTaskBrief({
        task,
        document,
        memory: readMemory(task),
        sessions: lines,
        ...(observation ? { observation } : {}),
      });
      return {
        brief,
        ...(observation?.status === 'observed'
          ? { workItemObservedAt: observation.observation.observedAt }
          : {}),
      };
    },

    async forSession(sessionId) {
      const bound = boundTask(sessionId);
      if (bound.kind !== 'task') return bound;
      const { task } = bound;
      const [document, observation, lines] = await Promise.all([
        readDocument(task.id),
        observe(task),
        sessions(task, sessionId, deps.ownerOf?.(sessionId)),
      ]);
      // The binding is immutable, but the Task can be replaced while the
      // document read crosses its worker boundary.
      const current = deps.readTask(task.id);
      if (
        !current ||
        current.createdAt !== task.createdAt ||
        current.projectId !== bound.projectId
      )
        return {
          kind: 'unavailable',
          reason: 'The Task changed while its brief was read.',
        };
      return {
        kind: 'brief',
        brief: buildTaskBrief({
          task: current,
          document,
          memory: readMemory(current),
          sessions: lines,
          ...(observation ? { observation } : {}),
        }),
      };
    },

    async listingForSession(sessionId, include) {
      const bound = boundTask(sessionId);
      if (bound.kind !== 'task') return bound;
      const { task } = bound;
      if (!deps.memory)
        return { kind: 'unavailable', reason: 'Task memory is not running.' };
      try {
        const incarnation = incarnationOf(task);
        const text =
          include === 'all_records'
            ? renderTaskRecordListing({
                task,
                records: deps.memory.listRecords(incarnation),
              })
            : renderTaskSummaryHistory({
                task,
                ...deps.memory.listSummaryRevisions({
                  ...incarnation,
                  limit: TASK_BRIEF_SUMMARY_HISTORY_REVISIONS,
                }),
              });
        return { kind: 'listing', listing: { taskId: task.id, include, text } };
      } catch (error) {
        return { kind: 'unavailable', reason: errorText(error) };
      }
    },
  };
}

/**
 * The runtime composition both consumers share: the dispatcher (first-turn
 * delivery) and the `get_task_brief` route. Structural inputs, so neither
 * consumer's wiring can drift from the other's.
 */
export function composeTaskBriefSource(input: {
  taskGraph: {
    readTaskView(taskId: string): TaskRecord | null;
    listTaskDispatchSessions(
      taskId: string,
    ): readonly { sessionId: string; provider?: string; createdAt: string }[];
  };
  eventStore:
    | (Pick<
        EventStore,
        | 'conversationForSession'
        | 'conversationSessions'
        | 'readTurnDigestFacts'
        | 'createWorkClaimStore'
      > & {
        readProjectTaskRoomExecutionBinding(
          sessionId: string,
        ): { projectId: string; taskId: string } | undefined;
        taskMemoryStore(): TaskBriefMemoryReader;
      })
    | undefined;
  /**
   * The Session read model `list_project_activity` words its status from,
   * and that decides whether a claim's claimant has ended. Read with the
   * internal scope: every Session read here was dispatched for the one Task
   * the caller is bound to (or is dispatching). Absent, the brief reads no
   * claims: without the claimant's state it cannot tell an active one.
   */
  sessionReadModel?: {
    listSessionReadModel(
      authority: typeof INTERNAL_SESSION_READ_SCOPE,
      options: { threadIds: readonly string[] },
    ): Promise<OrchestrationSessionSummary[]>;
    currentConversationSessionId(conversationId: string): string;
    canUserReadSession(
      threadId: string,
      authority: SessionReadAuthority,
    ): boolean;
    sessionRecordedOwnerId(threadId: string): string | undefined;
  };
  /**
   * A person's Session read authority (the runtime's own construction, with
   * its tenancy): the brief shows another Session only when the viewer's
   * owner may read it.
   */
  readAuthorityForUser: (userId: string) => SessionReadAuthority;
  /** See {@link TaskBriefSourceDeps.localProjectIdFor}. */
  localProjectIdFor: (identity: string) => string | undefined;
  /** Read lazily: the room runtime is composed after the dispatcher. */
  roomRuntime: () =>
    | {
        readTaskDocumentForBrief(
          taskId: string,
        ): Promise<TaskBriefInput['document']>;
      }
    | undefined;
  workItemObserver: WorkItemObserver;
  logger?: TaskBriefSourceDeps['logger'];
}): TaskBriefSource {
  const store = input.eventStore;
  return createTaskBriefSource({
    readTask: (taskId) => input.taskGraph.readTaskView(taskId),
    listTaskSessions: (taskId) =>
      input.taskGraph.listTaskDispatchSessions(taskId),
    readDocument: async (taskId) => {
      const runtime = input.roomRuntime();
      return runtime
        ? runtime.readTaskDocumentForBrief(taskId)
        : { kind: 'unavailable', reason: 'the Task room is not running' };
    },
    ...(store ? { memory: store.taskMemoryStore() } : {}),
    localProjectIdFor: input.localProjectIdFor,
    ...(input.sessionReadModel
      ? {
          canViewerRead: (viewerUserId: string, sessionId: string) =>
            input.sessionReadModel!.canUserReadSession(
              sessionId,
              input.readAuthorityForUser(viewerUserId),
            ),
          ownerOf: (sessionId: string) =>
            input.sessionReadModel!.sessionRecordedOwnerId(sessionId),
        }
      : {}),
    // The read API the claims routes and `list_project_activity` share.
    // Reads never reach the per-claimant bound; it is the store's write rule.
    ...(store && input.sessionReadModel
      ? {
          workClaims: composeActiveWorkClaimReader({
            store: store.createWorkClaimStore({
              maxActivePerClaimant: WORK_CLAIM_MAX_ACTIVE_PER_SESSION,
            }),
            orchestrationService: input.sessionReadModel,
          }),
        }
      : {}),
    sessionFacts: async (sessionIds) => {
      const facts = new Map<string, TaskBriefSessionFactsRead>();
      if (!sessionIds.length) return facts;
      const summaries = input.sessionReadModel
        ? await input.sessionReadModel.listSessionReadModel(
            INTERNAL_SESSION_READ_SCOPE,
            { threadIds: sessionIds },
          )
        : [];
      const status = new Map(
        summaries.map((summary) => [
          summary.threadId,
          sessionLadderWord(summary),
        ]),
      );
      for (const sessionId of sessionIds) {
        let head: ReturnType<typeof readSessionDigestHead> | undefined;
        try {
          head = store ? readSessionDigestHead(store, sessionId) : undefined;
        } catch {
          // One Session's unreadable digest leaves only its line bare.
          head = undefined;
        }
        const word = status.get(sessionId);
        facts.set(sessionId, {
          ...(word ? { status: word } : {}),
          ...(head ?? {}),
        });
      }
      return facts;
    },
    readBinding: (sessionId) =>
      store?.readProjectTaskRoomExecutionBinding(sessionId),
    workItemObserver: input.workItemObserver,
    ...(input.logger ? { logger: input.logger } : {}),
  });
}
