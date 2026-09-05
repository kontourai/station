/**
 * Runtime-owned Project/Task room authority.  HTTP callers name only a Task;
 * this module derives the Project scope and every opaque room grant from the
 * authenticated request on each operation.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  LIVE_ACTIVITY_MAX_PARTICIPANTS,
  LIVE_ACTIVITY_MAX_ROOMS,
  LIVE_ACTIVITY_SCHEMA_VERSION,
  type LiveActivityRoomProjection,
} from '@kontourai/station-contracts/live-activity';
import type {
  ProjectTaskRoomAppendOutcome,
  ProjectTaskRoomAuthority,
  ProjectTaskRoomGrant,
  ProjectTaskRoomGrantKind,
  ProjectTaskRoomOpenOutcome,
  ProjectTaskRoomPrincipal,
  ProjectTaskRoomReadOutcome,
  ProjectTaskRoomScope,
} from '@kontourai/station-contracts/project-task-room';
import type {
  TaskDispatchResult,
  TaskRecord,
} from '@kontourai/station-contracts/task-graph';
import {
  LIVE_WORK_RECOVERY_SCHEMA_VERSION,
  type LiveWorkAuthorization,
  type LiveWorkCapability,
  type LiveWorkMutationOutcome,
  type LiveWorkRecoveryAuthorization,
  type LiveWorkRecoveryState,
  type LiveWorkScope,
  LiveWorkSession,
} from '../../domain/live-work-session.js';
import {
  SHARED_WORKING_STATE_SCHEMA_VERSION,
  SharedWorkingState,
  type TextDocumentOperation,
} from '../../domain/shared-working-state.js';
import {
  createSharedWorkingStateEditingCapability,
  type SharedWorkingStateEditBatch,
  sharedWorkingStateEditBatchDigest,
} from '../../domain/shared-working-state-editing.js';
import { ProjectTaskLiveWorkHistoryAdapter } from './project-task-live-work-history-adapter.js';
import { projectTaskRoomDocumentId } from './project-task-room-document-id.js';
import type {
  ProjectTaskRoomAgentGrantAuthority,
  ProjectTaskRoomCapabilityAuthority,
  ProjectTaskRoomCapabilityResolution,
  ProjectTaskRoomLinkAuthority,
} from './project-task-room-history.js';
import type { ProjectTaskRoomRevisionEvidencePort } from './project-task-room-revision-evidence-bridge.js';
import type { ProjectTaskRoomWorkingState } from './project-task-room-working-state.js';
import { createOrchestrationRunId } from './run-projection.js';

type BrowserCapability = 'discover' | 'history-read' | 'message-write';
type RoomCapability =
  | BrowserCapability
  | 'lifecycle-append'
  | 'home-transfer'
  | 'revision-link'
  | 'agent-publish';
// Room policy is deliberately independent from mutable Task projection fields
// such as status, dispatch association, and updatedAt. Those transitions are
// enforced through the exact task/document and principal checks at each effect.
const PROJECT_TASK_ROOM_POLICY_REVISION = 'project-task-room-policy/v1';
const PROJECT_TASK_ROOM_CURSOR_TTL_MS = 15_000;
const PROJECT_TASK_ROOM_CURSOR_LIMIT = 64;
const PROJECT_TASK_ROOM_CURSOR_RATE_PER_SECOND = 20;
export const LIVE_ACTIVITY_MAX_ROOM_SCAN = LIVE_ACTIVITY_MAX_ROOMS * 4;

/** Pure bounded ordering: unreadable entries cannot consume the 64-room cap. */
export function orderedLiveActivityEntries<
  T extends {
    readonly room: {
      readonly scope: Pick<LiveWorkScope, 'projectId' | 'taskId' | 'surfaceId'>;
    };
  },
>(entries: readonly T[]): readonly T[] {
  return [...entries]
    .sort((left, right) =>
      [
        left.room.scope.projectId,
        left.room.scope.taskId,
        left.room.scope.surfaceId,
      ]
        .join('\u0000')
        .localeCompare(
          [
            right.room.scope.projectId,
            right.room.scope.taskId,
            right.room.scope.surfaceId,
          ].join('\u0000'),
        ),
    )
    .slice(0, LIVE_ACTIVITY_MAX_ROOM_SCAN);
}

export function canCollectLiveActivityRoom(authorizedRooms: number): boolean {
  return authorizedRooms < LIVE_ACTIVITY_MAX_ROOMS;
}
interface RequestPrincipal {
  readonly kind: 'granted';
  readonly operatorId: string;
  readonly deviceId: string;
  readonly policyRevision: string;
}
export interface ProjectTaskRoomRequestAuthority {
  resolve(
    request: Request,
  ): Promise<RequestPrincipal | { readonly kind: 'revoked' | 'unavailable' }>;
}
export interface ProjectTaskRoomRuntimeDeps {
  readonly taskGraph: Pick<
    { readTaskView(taskId: string): TaskRecord | null },
    'readTaskView'
  >;
  readonly projectForId: (
    projectId: string,
  ) => { readonly id: string; readonly slug: string } | undefined;
  readonly history: (authority: {
    capabilities: ProjectTaskRoomCapabilityAuthority;
    agents: ProjectTaskRoomAgentGrantAuthority;
    links?: ProjectTaskRoomLinkAuthority;
  }) => ProjectTaskRoomAuthority;
  /** archive#3546 bridge: recorder, scope-bound resolver, and lifecycle owner. */
  readonly revisionEvidence?: ProjectTaskRoomRevisionEvidencePort;
  readonly working: ProjectTaskRoomWorkingState;
  readonly requestAuthority: ProjectTaskRoomRequestAuthority;
  /** Durable Session projection used to reconstruct exact provider/lifecycle. */
  readonly readAgentLifecycle?: (input: { sessionId: string }) => Promise<
    | {
        readonly provider: string;
        readonly outcome?: 'completed' | 'failed' | 'cancelled';
      }
    | undefined
  >;
  /** Hosted tenancy has no task-room ownership model yet: never expose it. */
  readonly hosted?: () => boolean;
  /** Test-only crash boundary for durable publication recovery proofs. */
  readonly afterRevisionPublicationStep?: (
    step: 'document-commit' | 'freeze' | 'link-commit',
  ) => void;
}
interface IssuedGrant {
  readonly capability: RoomCapability;
  readonly scope: ProjectTaskRoomScope;
  readonly principal:
    | RequestPrincipal
    | Extract<ProjectTaskRoomPrincipal, { kind: 'agent' }>;
  readonly request?: Request;
  /** A bounded server-minted live-material authority, never a browser key. */
  readonly material?: true;
  readonly receiptId: string;
}
interface IssuedEditPlan {
  readonly batch: SharedWorkingStateEditBatch;
  readonly scope: { projectId: string; taskId: string; documentId: string };
  readonly principal: RequestPrincipal;
  readonly issuedAt: number;
}
interface LiveMaterialAuthority {
  readonly principal: RequestPrincipal;
}
interface PersistedLiveRoomRecovery {
  readonly schemaVersion: 'station.project-task-room-runtime-recovery/v1';
  readonly state: LiveWorkRecoveryState;
  /** Only armed intents may cross a process boundary into system replay. */
  readonly armedIntentIds: readonly string[];
  /** Private, server-only bindings for durable system reconciliation. */
  readonly authorities: readonly {
    readonly token: string;
    readonly principal: RequestPrincipal;
  }[];
}
interface RoomSubscriber {
  readonly request: Request;
  readonly emit: (event: unknown) => void;
  ready: boolean;
  pending: unknown[];
}
interface LiveRoomEntry {
  readonly generation: string;
  readonly room: LiveWorkSession;
  readonly authorities: Map<string, LiveMaterialAuthority>;
  /** Current TTL authority per paired-device actor. */
  readonly ttlAuthorities: Map<string, string>;
  readonly cursors: Map<
    string,
    {
      readonly actorId: string;
      readonly workingRevision: string;
      readonly selection: { readonly anchor: number; readonly focus: number };
      readonly expiresAt: number;
      readonly publicationId: string;
    }
  >;
  readonly cursorAdmissions: Map<
    string,
    { readonly timestamp: number; readonly publicationId: string }[]
  >;
  /**
   * Agent presence is projected only after TaskDispatcher has durably bound
   * the exact Task, Agent, and orchestration Session. It is intentionally
   * separate from paired-device identity material: a browser can neither
   * mint nor mutate these entries.
   */
  readonly agentParticipants: Map<
    string,
    {
      readonly actor: {
        readonly actorId: string;
        readonly kind: 'agent';
        readonly label: string;
      };
      readonly work: {
        readonly sessionId: string;
        readonly runId?: string;
        readonly workName: string;
        readonly workState: 'working';
        readonly startedAt: number;
      };
      readonly publication: 'published';
    }
  >;
}
interface PendingAgentLifecycle {
  readonly taskId: string;
  readonly sessionId: string;
  readonly provider?: string;
  readonly outcome: 'started' | 'completed' | 'failed' | 'cancelled';
  readonly dispatchId: string;
  readonly occurredAt: string;
  readonly authorizationReceiptId: string;
}

export type ProjectTaskRoomRuntimeOutcome<T> =
  | T
  | { readonly kind: 'not-found' | 'unavailable' };

export class ProjectTaskRoomRuntime {
  readonly #deps: ProjectTaskRoomRuntimeDeps;
  readonly #issued = new Map<string, IssuedGrant>();
  readonly #plans = new Map<string, IssuedEditPlan>();
  /** Ephemeral request context for one in-flight material effect only. */
  readonly #activeLiveMaterial = new Map<string, Request>();
  /** System recovery is explicit and never borrows a subscriber request. */
  readonly #activeLiveRecovery = new Set<string>();
  readonly #history: ProjectTaskRoomAuthority;
  readonly #live = new Map<string, LiveRoomEntry>();
  readonly #recovery = new Map<string, Promise<boolean>>();
  readonly #subscribers = new Map<string, Set<RoomSubscriber>>();
  /**
   * Document projection is causally independent of ephemeral live presence.
   * Keep its exact in-order stream apart from the latter's potentially slow
   * per-delivery reauthorization, so typing/cursor recovery cannot stall a
   * durable accepted edit's rendered projection.
   */
  readonly #documentNotificationChains = new Map<string, Promise<void>>();
  readonly #notificationChains = new Map<string, Promise<void>>();
  #unwatchWorking: (() => void) | undefined;
  #closed = false;

  constructor(deps: ProjectTaskRoomRuntimeDeps) {
    this.#deps = deps;
    this.#history = deps.history({
      capabilities: {
        resolve: (input) => this.#resolveGrant(input.grant, input.required),
      },
      agents: { revalidate: (receipt) => this.#revalidateAgent(receipt) },
      ...(deps.revisionEvidence ? { links: deps.revisionEvidence.links } : {}),
    });
  }

  /** Server-only ingress after Task/Session association; no browser DTO enters here. */
  async prepareAgentStarted(result: TaskDispatchResult): Promise<void> {
    await this.#persistAgentLifecycle({
      taskId: result.task.id,
      sessionId: result.session.threadId,
      provider: result.session.provider,
      outcome: 'started',
      dispatchId: `task-association:${result.task.id}:${result.session.threadId}`,
      occurredAt: result.task.dispatchedAt ?? result.dispatch.createdAt,
      authorizationReceiptId: agentLifecycleReceiptId(
        result.task.id,
        result.session.threadId,
        'started',
      ),
    });
  }

  /** Server-only ingress after Task/Session association; no browser DTO enters here. */
  async publishAgentStarted(result: TaskDispatchResult): Promise<void> {
    const lifecycle: PendingAgentLifecycle = {
      taskId: result.task.id,
      sessionId: result.session.threadId,
      provider: result.session.provider,
      outcome: 'started',
      dispatchId: `task-association:${result.task.id}:${result.session.threadId}`,
      occurredAt: result.task.dispatchedAt ?? result.dispatch.createdAt,
      authorizationReceiptId: agentLifecycleReceiptId(
        result.task.id,
        result.session.threadId,
        'started',
      ),
    };
    await this.#persistAgentLifecycle(lifecycle);
    await this.#publishAgentLifecycle(lifecycle);
  }

  /**
   * Server-only agent editing ingress. The caller supplies no operation graph,
   * actor identity, Project scope, or room authority: all of those are derived
   * again from the durable Task/Session association on both sides of every
   * asynchronous boundary.
   */
  async seedPerformanceOperations(input: {
    readonly taskId: string;
    readonly count: 1 | 10 | 10_000;
  }): Promise<{
    readonly kind: 'seeded';
    readonly taskId: string;
    readonly operationCount: number;
    readonly baseRevision: string;
    readonly revision: string;
  }> {
    if (this.#closed || this.#deps.hosted?.())
      throw new Error('Performance operation seed is unavailable');
    const roomScope = this.#scope(input.taskId);
    if (!roomScope)
      throw new Error('Performance operation Task is unavailable');
    const scope = { ...roomScope, documentId: documentIdFor(roomScope) };
    const snapshot = await this.#deps.working.privateSnapshot({ scope });
    if (!snapshot)
      throw new Error('Performance operation state is unavailable');
    const actorId = 'performance-seed';
    const epoch = authorizationEpoch(this.#roomPolicyRevision(roomScope));
    const seedId = randomUUID().replaceAll('-', '').slice(0, 12);
    let revision = snapshot.revision;
    const operationAt = (index: number): TextDocumentOperation => {
      const operationId = `p:${seedId}:${index}`;
      const priorOperationId =
        index === 0 ? undefined : `p:${seedId}:${index - 1}`;
      return {
        schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
        operationId,
        documentId: scope.documentId,
        replicaId: `p:${seedId}`,
        actor: {
          actorId,
          kind: 'agent',
        },
        parents: priorOperationId ? [priorOperationId] : [],
        authorizationEpoch: epoch,
        kind: 'insert',
        after: priorOperationId ? `${priorOperationId}:0` : null,
        text: String(index % 10),
      };
    };
    for (let offset = 0; offset < input.count; offset += 300) {
      const operations = Array.from(
        { length: Math.min(300, input.count - offset) },
        (_, index) => operationAt(offset + index),
      );
      const intentId = `p:${seedId}:b:${offset}`;
      const result = await this.#deps.working.settle({
        scope,
        intentId,
        intentDigest: sharedWorkingStateEditBatchDigest({
          intentId,
          scope,
          operations,
        }),
        actorId,
        actorLabel: 'Performance fixture',
        actorKind: 'agent',
        epoch,
        operations,
        suppressRevisionPublicationForDiagnostic: true,
      });
      if (result.kind !== 'committed' && result.kind !== 'duplicate')
        throw new Error(
          `Performance operation seed was ${result.kind} at ${offset}`,
        );
      if (!result.revision)
        throw new Error('Performance operation seed lacks revision');
      revision = result.revision;
    }
    return {
      kind: 'seeded',
      taskId: input.taskId,
      operationCount: input.count,
      baseRevision: snapshot.revision,
      revision,
    };
  }

  async publishAgentDocumentEdit(input: {
    readonly taskId: string;
    readonly agentId: string;
    readonly sessionId: string;
    readonly provider: string;
    readonly desiredText: string;
  }): Promise<
    | {
        readonly kind: 'committed' | 'duplicate' | 'unchanged';
        readonly revision: string;
        readonly text: string;
        readonly sessionId: string;
        readonly runId: string;
      }
    | {
        readonly kind: 'not-found' | 'refused' | 'unavailable';
        readonly reason?: string;
      }
  > {
    if (this.#closed || this.#deps.hosted?.()) return { kind: 'unavailable' };
    const association = this.#agentAssociation(input);
    if (!association) return { kind: 'not-found' };
    const snapshot = await this.#deps.working.privateSnapshot({
      scope: association.document,
    });
    if (!snapshot || !this.#agentAssociation(input))
      return { kind: 'unavailable' };
    const state = new SharedWorkingState({
      scope: association.document,
      snapshot,
    });
    const runId = createOrchestrationRunId(input.provider, input.sessionId);
    const actorId = agentActorId(input.taskId, input.agentId, input.sessionId);
    const intentId = randomUUID();
    const capability = createSharedWorkingStateEditingCapability({
      scope: association.document,
      snapshot: () => snapshot,
      authorization: () => ({
        scope: association.document,
        epoch: authorizationEpoch(this.#roomPolicyRevision(association.scope)),
        allowedActorIds: new Set([actorId]),
      }),
      actor: () => ({
        actorId,
        kind: 'agent',
        displayLabel: input.agentId,
      }),
      attribution: () => ({
        projectId: association.scope.projectId,
        taskId: input.taskId,
        agentSessionId: input.sessionId,
        runId,
        correlationId: `agent-edit:${input.taskId}:${input.sessionId}`,
      }),
      replicaId: `agent-session:${input.sessionId}`,
      nextIntentId: () => intentId,
    });
    const plan = capability.plan({
      currentText: state.text(),
      desiredText: input.desiredText,
      selection: {
        anchor: input.desiredText.length,
        focus: input.desiredText.length,
      },
      pending: [],
    });
    if (plan.outcome === 'unchanged')
      return {
        kind: 'unchanged',
        revision: snapshot.revision,
        text: state.text(),
        sessionId: input.sessionId,
        runId,
      };
    if (plan.outcome !== 'planned')
      return { kind: 'refused', reason: plan.reason };
    const settlement = {
      scope: association.document,
      intentId: plan.batch.intentId,
      intentDigest: plan.batch.digest,
      actorId,
      actorLabel: input.agentId,
      actorKind: 'agent',
      publicationCorrelation: {
        agentSessionId: input.sessionId,
        runId,
      },
      // Evidence publication still requires the durable Task owner; the
      // immutable working operations themselves retain exact Agent + Session
      // + Run attribution.
      publicationPrincipal: {
        operatorId: association.task.createdBy,
        deviceId: `agent-session:${input.sessionId}`,
        policyRevision: this.#roomPolicyRevision(association.scope),
      },
      epoch: plan.batch.operations[0]?.authorizationEpoch ?? 0,
      operations: plan.batch.operations,
      beforeCommit: async () => Boolean(this.#agentAssociation(input)),
    } as const;
    let result = await this.#deps.working.settle(settlement);
    if (
      result.kind === 'rejected' &&
      result.reason === 'revision-publication-pending' &&
      this.#agentAssociation(input)
    ) {
      await this.#drainRevisionPublication({
        taskId: input.taskId,
        scope: association.document,
        systemRecovery: true,
      });
      if (!this.#agentAssociation(input)) return { kind: 'not-found' };
      // The worker receipt makes this exact retry duplicate-safe if the first
      // attempt committed but its response was lost at the process boundary.
      result = await this.#deps.working.settle(settlement);
    }
    if (!this.#agentAssociation(input)) return { kind: 'not-found' };
    if (result.kind !== 'committed' && result.kind !== 'duplicate')
      return result.kind === 'rejected'
        ? {
            kind: 'refused',
            reason: result.reason ?? 'working-operation-rejected',
          }
        : { kind: 'unavailable' };
    if (!result.revision || result.text === undefined)
      return { kind: 'unavailable' };
    this.#publishAgentPresence({
      task: association.task,
      scope: association.scope,
      sessionId: input.sessionId,
      provider: input.provider,
      startedAt: Date.parse(
        association.task.dispatchedAt ?? association.task.updatedAt,
      ),
    });
    await this.#notify(association.document, { type: 'document', ...result });
    const revisionEvidence = await this.#drainRevisionPublication({
      taskId: input.taskId,
      scope: association.document,
      systemRecovery: true,
    });
    if (revisionEvidence.kind === 'linked')
      await this.#publishHistory(association.document);
    return {
      kind: result.kind,
      revision: result.revision,
      text: result.text,
      sessionId: input.sessionId,
      runId,
    };
  }

  /** Server-only ingress from canonical session.exited. */
  async publishAgentFinished(input: {
    taskId: string;
    sessionId: string;
    provider: string;
    outcome: 'completed' | 'failed' | 'cancelled';
  }): Promise<void> {
    const task = this.#deps.taskGraph.readTaskView(input.taskId);
    if (!task || task.sessionId !== input.sessionId || !task.agentId) return;
    const lifecycle: PendingAgentLifecycle = {
      taskId: task.id,
      sessionId: input.sessionId,
      provider: input.provider,
      outcome: input.outcome,
      dispatchId: `room-exit:${input.sessionId}`,
      occurredAt: new Date().toISOString(),
      authorizationReceiptId: agentLifecycleReceiptId(
        task.id,
        input.sessionId,
        input.outcome,
      ),
    };
    await this.#persistAgentLifecycle(lifecycle);
    await this.#publishAgentLifecycle(lifecycle);
  }

  async reconcileAgentLifecycles(taskIds: readonly string[]): Promise<void> {
    for (const taskId of taskIds) {
      const scope = this.#scope(taskId);
      if (!scope) continue;
      const document = { ...scope, documentId: documentIdFor(scope) };
      const pending = await this.#deps.working.readAgentLifecycles({
        scope: document,
      });
      for (const record of pending) {
        const lifecycle = parsePendingAgentLifecycle(record.value);
        if (!lifecycle || lifecycle.taskId !== taskId) continue;
        await this.#publishAgentLifecycle(lifecycle);
      }
      // Task association is the durable source of a started publication. It
      // closes the crash window before an outbox insert (or when that insert
      // was unavailable) without ever retrying provider dispatch.
      const task = this.#deps.taskGraph.readTaskView(taskId);
      const durableLifecycle =
        task?.agentId && task.sessionId
          ? await this.#deps.readAgentLifecycle?.({
              sessionId: task.sessionId,
            })
          : undefined;
      if (task?.agentId && task.sessionId)
        await this.#publishAgentLifecycle({
          taskId: task.id,
          sessionId: task.sessionId,
          ...(durableLifecycle?.provider
            ? { provider: durableLifecycle.provider }
            : {}),
          outcome: 'started',
          dispatchId: `task-association:${task.id}:${task.sessionId}`,
          occurredAt: task.dispatchedAt ?? task.createdAt,
          authorizationReceiptId: agentLifecycleReceiptId(
            task.id,
            task.sessionId,
            'started',
          ),
        });
      if (task?.agentId && task.sessionId && durableLifecycle?.outcome) {
        const lifecycle: PendingAgentLifecycle = {
          taskId: task.id,
          sessionId: task.sessionId,
          provider: durableLifecycle.provider,
          outcome: durableLifecycle.outcome,
          dispatchId: `room-recovery:${task.sessionId}`,
          occurredAt: task.updatedAt,
          authorizationReceiptId: agentLifecycleReceiptId(
            task.id,
            task.sessionId,
            durableLifecycle.outcome,
          ),
        };
        await this.#persistAgentLifecycle(lifecycle);
        await this.#publishAgentLifecycle({
          ...lifecycle,
        });
      }
    }
  }

  /** Replays only an already-committed document publication; never an edit. */
  async reconcileRevisionPublications(
    taskIds: readonly string[],
  ): Promise<void> {
    if (this.#closed || this.#deps.hosted?.()) return;
    for (const taskId of taskIds) {
      const scope = this.#scope(taskId);
      if (!scope) continue;
      await this.#drainRevisionPublication({
        taskId,
        scope: { ...scope, documentId: documentIdFor(scope) },
        systemRecovery: true,
      });
    }
  }

  async discover(input: {
    taskId: string;
    request: Request;
  }): Promise<ProjectTaskRoomRuntimeOutcome<ProjectTaskRoomOpenOutcome>> {
    const grant = await this.#issue(input.taskId, input.request, 'discover');
    if (!grant) return { kind: 'not-found' };
    const opened = this.#mapOpen(await this.#history.open({ grant }));
    if (opened.kind !== 'opened' && opened.kind !== 'existing') return opened;
    const scope = this.#scope(input.taskId);
    if (scope)
      await this.#drainRevisionPublication({
        taskId: input.taskId,
        request: input.request,
        scope: { ...scope, documentId: documentIdFor(scope) },
        historyOpened: true,
      });
    return {
      ...opened,
      revisionLinksAvailable: this.#deps.revisionEvidence?.available() === true,
    } as typeof opened & { readonly revisionLinksAvailable: boolean };
  }

  async history(input: {
    taskId: string;
    request: Request;
    cursor?: Parameters<ProjectTaskRoomAuthority['read']>[0]['cursor'];
    limit?: number;
    /** Route-only browser projection; internal callers retain durable records. */
    project?: boolean;
  }): Promise<ProjectTaskRoomRuntimeOutcome<ProjectTaskRoomReadOutcome>> {
    const grant = await this.#issue(
      input.taskId,
      input.request,
      'history-read',
    );
    if (!grant) return { kind: 'not-found' };
    const result = await this.#history.read({
      grant,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    if (result.kind === 'denied' || result.kind === 'not-found')
      return { kind: 'not-found' };
    return input.project
      ? (projectHistory(
          result,
        ) as ProjectTaskRoomRuntimeOutcome<ProjectTaskRoomReadOutcome>)
      : result;
  }

  async message(input: {
    taskId: string;
    request: Request;
    proposalId: string;
    text: string;
    occurredAt?: string;
  }): Promise<ProjectTaskRoomRuntimeOutcome<ProjectTaskRoomAppendOutcome>> {
    const grant = await this.#issue(
      input.taskId,
      input.request,
      'message-write',
    );
    if (!grant) return { kind: 'not-found' };
    const result = await this.#history.append({
      grant,
      intent: {
        proposalId: input.proposalId,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        body: { kind: 'human-message', text: input.text },
      },
    });
    if (result.kind === 'committed' || result.kind === 'duplicate') {
      const scope = this.#scope(input.taskId);
      if (scope)
        await this.#publishHistory({
          projectId: scope.projectId,
          taskId: scope.taskId,
          documentId: documentIdFor(scope),
        });
    }
    return result.kind === 'denied' ? { kind: 'not-found' } : result;
  }

  /** Browser-safe text projection: no atom graph or write authority leaves this seam. */
  async document(input: { taskId: string; request: Request; after?: string }) {
    const scope = await this.#authorizedDocument(input.taskId, input.request);
    const principal = scope ? await this.#principal(input.request) : undefined;
    if (!scope || !principal) return { kind: 'not-found' } as const;
    const result = await this.#deps.working.read({
      scope,
      ...(input.after ? { after: input.after } : {}),
    });
    // SQLite reads cross a worker boundary. Revalidate the exact Project/Task
    // scope and the original paired-device/operator principal before this
    // browser-safe projection becomes observable.
    const currentScope = await this.#authorizedDocument(
      input.taskId,
      input.request,
    );
    const currentPrincipal = await this.#principal(input.request);
    if (
      !currentScope ||
      !currentPrincipal ||
      !sameDocument(currentScope, scope) ||
      !samePrincipal(currentPrincipal, principal)
    )
      return { kind: 'not-found' } as const;
    return result.kind === 'unavailable'
      ? ({ kind: 'unavailable' } as const)
      : result;
  }

  /** Settles only an exact, server-issued private edit plan. */
  async submitBatch(input: {
    taskId: string;
    request: Request;
    intentId: string;
    intentDigest: string;
    /**
     * Server-internal diagnostic observer. It runs only after a durable working
     * settlement has been reauthorized and immediately before that settlement
     * is projected to subscribers. It must never be used as room authority.
     */
    onDurableSettlementForDiagnostic?: () => void;
  }) {
    const scope = await this.#authorizedDocument(input.taskId, input.request);
    const principal = scope ? await this.#principal(input.request) : undefined;
    if (!scope || !principal) return { kind: 'not-found' } as const;
    const plan = this.#plans.get(input.intentId);
    if (!plan) {
      const receipt = await this.#deps.working.receipt({
        scope,
        intentId: input.intentId,
        intentDigest: input.intentDigest,
      });
      // A durable duplicate can cross the worker boundary just like a fresh
      // settlement.  Reauthorize before its text reaches either the caller or
      // a room subscriber.
      if (
        !(await this.#sameAuthorizedDocument(
          input.taskId,
          input.request,
          scope,
          principal,
        ))
      )
        return { kind: 'not-found' } as const;
      if (receipt.kind === 'duplicate') {
        input.onDurableSettlementForDiagnostic?.();
        await this.#notify(scope, { type: 'document', ...receipt });
        const revisionEvidence = await this.#drainRevisionPublication({
          taskId: input.taskId,
          request: input.request,
          scope,
        });
        return { ...receipt, revisionEvidence };
      }
      return receipt.kind === 'conflict'
        ? ({ kind: 'rejected', reason: 'idempotency-conflict' } as const)
        : ({ kind: 'rejected' } as const);
    }
    if (
      plan.issuedAt + 5 * 60_000 < Date.now() ||
      plan.batch.digest !== input.intentDigest ||
      !sameDocument(plan.scope, scope) ||
      !samePrincipal(plan.principal, principal)
    )
      return { kind: 'rejected' as const };
    // The grant is checked immediately before the private atomic commit; a
    // revocation during planning therefore cannot settle a previously-issued plan.
    const current = await this.#principal(input.request);
    if (!current || !samePrincipal(current, plan.principal))
      return { kind: 'not-found' as const };
    const result = await this.#deps.working.settle({
      scope,
      intentId: input.intentId,
      intentDigest: input.intentDigest,
      actorId: actorIdFor(plan.principal),
      actorLabel: plan.principal.operatorId,
      publicationPrincipal: {
        operatorId: plan.principal.operatorId,
        deviceId: plan.principal.deviceId,
        policyRevision: plan.principal.policyRevision,
      },
      epoch: plan.batch.operations[0]?.authorizationEpoch ?? 0,
      operations: plan.batch.operations,
      beforeCommit: async () =>
        this.#sameAuthorizedDocument(
          input.taskId,
          input.request,
          scope,
          plan.principal,
        ),
    });
    // Do not accept or publish a result that crossed an asynchronous worker
    // boundary after its initiating paired-device grant was revoked.
    if (
      !(await this.#sameAuthorizedDocument(
        input.taskId,
        input.request,
        scope,
        plan.principal,
      ))
    )
      return { kind: 'not-found' } as const;
    if (result.kind === 'committed' || result.kind === 'duplicate') {
      input.onDurableSettlementForDiagnostic?.();
      await this.#notify(scope, { type: 'document', ...result });
      if (result.kind === 'committed')
        this.#deps.afterRevisionPublicationStep?.('document-commit');
      const revisionEvidence = await this.#drainRevisionPublication({
        taskId: input.taskId,
        request: input.request,
        scope,
      });
      return { ...result, revisionEvidence };
    }
    if (result.kind === 'conflict')
      return { kind: 'rejected', reason: 'idempotency-conflict' } as const;
    return result.kind === 'unavailable'
      ? ({ kind: 'unavailable' } as const)
      : result;
  }

  async #drainRevisionPublication(input: {
    taskId: string;
    request?: Request;
    scope: { projectId: string; taskId: string; documentId: string };
    historyOpened?: boolean;
    systemRecovery?: boolean;
  }): Promise<
    | { readonly kind: 'linked'; readonly revisionId: string }
    | { readonly kind: 'unavailable' }
  > {
    try {
      const bridge = this.#deps.revisionEvidence;
      if (!bridge) return { kind: 'unavailable' };
      // The ordered document notification has completed its authorization and
      // entered the transport. Give queued stream/socket work a real event-loop
      // turn before the synchronous ledger restore in available()/freeze().
      // Persistence remains awaited; delivery is not evidence-link completion.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#closed || !bridge.available()) return { kind: 'unavailable' };
      const read = await this.#deps.working.readRevisionPublication({
        scope: input.scope,
      });
      if (read.kind !== 'available') return { kind: 'unavailable' };
      const publication = read.publication;
      let revisionId = publication.evidenceRevision;
      if (!revisionId) {
        const recorded = bridge.recordPublication(publication);
        if (recorded.kind !== 'recorded') return { kind: 'unavailable' };
        revisionId = recorded.revisionId;
        this.#deps.afterRevisionPublicationStep?.('freeze');
        const marked = await this.#deps.working.markRevisionPublication({
          scope: input.scope,
          intentId: publication.intentId,
          evidenceRevision: revisionId,
        });
        if (marked !== 'marked' && marked !== 'duplicate')
          return { kind: 'unavailable' };
      } else {
        const validated = await this.#deps.working.markRevisionPublication({
          scope: input.scope,
          intentId: publication.intentId,
          evidenceRevision: revisionId,
        });
        if (validated !== 'duplicate') return { kind: 'unavailable' };
      }
      if (!input.historyOpened) {
        const discover = input.request
          ? await this.#issue(input.taskId, input.request, 'discover')
          : input.systemRecovery
            ? this.#issueSystemLiveMaterial(
                input.taskId,
                { principal: { kind: 'granted', ...publication.principal } },
                'discover',
              )
            : undefined;
        if (!discover) return { kind: 'unavailable' };
        const opened = await this.#history.open({ grant: discover });
        if (opened.kind !== 'opened' && opened.kind !== 'existing')
          return { kind: 'unavailable' };
      }
      const currentGrant = input.request
        ? await this.#issue(input.taskId, input.request, 'revision-link')
        : input.systemRecovery
          ? true
          : undefined;
      if (!currentGrant) return { kind: 'unavailable' };
      const grant = this.#issueSystemLiveMaterial(
        input.taskId,
        { principal: { kind: 'granted', ...publication.principal } },
        'revision-link',
      );
      if (!grant) return { kind: 'unavailable' };
      const append = await this.#history.append({
        grant,
        intent: {
          proposalId: publication.intentId,
          occurredAt: publication.createdAt,
          correlationId: revisionId,
          body: {
            kind: 'outcome-link',
            linkKind: 'revision',
            reference: revisionId,
          },
        },
      });
      if (append.kind !== 'committed' && append.kind !== 'duplicate')
        return { kind: 'unavailable' };
      this.#deps.afterRevisionPublicationStep?.('link-commit');
      const removed = await this.#deps.working.removeRevisionPublication({
        scope: input.scope,
        intentId: publication.intentId,
        evidenceRevision: revisionId,
      });
      return removed === 'removed' || removed === 'missing'
        ? { kind: 'linked', revisionId }
        : { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async editPlan(input: {
    taskId: string;
    request: Request;
    intentId: string;
    desiredText: string;
    selection: { anchor: number; focus: number };
  }) {
    const scope = await this.#authorizedDocument(input.taskId, input.request);
    const principal = scope ? await this.#principal(input.request) : undefined;
    if (!scope || !principal) return { kind: 'not-found' } as const;
    const snapshot = await this.#deps.working.privateSnapshot({ scope });
    if (!snapshot) return { kind: 'unavailable' } as const;
    const state = new SharedWorkingState({ scope, snapshot });
    const issuedIntentId = randomUUID();
    // Document operations participate in the room policy, not the credential
    // version of the browser that happened to plan them. Exact device
    // reauthorization still fences the eventual commit below.
    const roomScope = this.#scope(input.taskId);
    if (!roomScope) return { kind: 'not-found' } as const;
    const epoch = authorizationEpoch(this.#roomPolicyRevision(roomScope));
    const capability = createSharedWorkingStateEditingCapability({
      scope,
      snapshot: () => snapshot,
      authorization: () => ({
        scope,
        epoch,
        allowedActorIds: new Set([actorIdFor(principal)]),
      }),
      actor: () => ({ actorId: actorIdFor(principal), kind: 'human' }),
      replicaId: `room:${principal.deviceId}`,
      // The browser's local request identity is not an operation identity.
      // Operation IDs are minted under this server authority.
      nextIntentId: () => issuedIntentId,
    });
    const plan = capability.plan({
      currentText: state.text(),
      desiredText: input.desiredText,
      selection: input.selection,
      pending: [],
    });
    if (plan.outcome !== 'planned') return { kind: plan.outcome };
    while (this.#plans.size >= 256)
      this.#plans.delete(this.#plans.keys().next().value!);
    this.#plans.set(plan.batch.intentId, {
      batch: plan.batch,
      scope,
      principal,
      issuedAt: Date.now(),
    });
    return {
      kind: 'planned' as const,
      intentId: plan.batch.intentId,
      digest: plan.batch.digest,
      optimistic: plan.batch.optimistic,
      selection: plan.batch.selection,
      operationCount: plan.batch.operations.length,
    };
  }

  async persistRecovery(input: {
    taskId: string;
    request: Request;
    generation: string;
    value: unknown;
  }) {
    const scope = await this.#authorizedDocument(input.taskId, input.request);
    if (!scope) return 'unavailable' as const;
    return this.#deps.working.recovery({
      scope,
      generation: input.generation,
      value: input.value,
    });
  }

  async recovery(input: { taskId: string; request: Request }) {
    const scope = await this.#authorizedDocument(input.taskId, input.request);
    const principal = scope ? await this.#principal(input.request) : undefined;
    if (!scope || !principal) return { kind: 'not-found' } as const;
    const stored = await this.#deps.working.readRecovery({ scope });
    if (
      !(await this.#sameAuthorizedDocument(
        input.taskId,
        input.request,
        scope,
        principal,
      ))
    )
      return { kind: 'not-found' } as const;
    if (stored.kind !== 'available') return stored;
    const recovery = parsePersistedRecovery(stored.value);
    return recovery
      ? { ...stored, value: recovery.state }
      : ({ kind: 'unavailable' } as const);
  }

  /** Closed browser vocabulary; identity and exact room scope remain server-derived. */
  async live(input: {
    taskId: string;
    request: Request;
    command:
      | 'join'
      | 'heartbeat'
      | 'announce'
      | 'depart'
      | 'watch'
      | 'follow'
      | 'stop'
      | 'typing'
      | 'cursor'
      | 'finish';
    requestId?: string;
    paneId?: string;
    targetActorId?: string;
    active?: boolean;
    generation?: string;
    workingRevision?: string;
    selection?: { anchor: number; focus: number };
    outcome?: 'completed' | 'failed' | 'cancelled';
  }) {
    const document = await this.#authorizedDocument(
      input.taskId,
      input.request,
    );
    const principal = document
      ? await this.#principal(input.request)
      : undefined;
    if (!document || !principal) return { kind: 'not-found' } as const;
    if (!(await this.#recoverPending(document)))
      return { kind: 'unavailable' } as const;
    // Every mutation, recovery export, and returned projection in this live
    // transaction shares one sampled clock. Awaited persistence may not make a
    // later wall-clock regression invalidate an already-authorized command.
    const now = Date.now();
    const actorId = actorIdFor(principal);
    const entry = this.#liveEntry(document, now);
    const priorTtlAuthority =
      input.command === 'join' ? entry.ttlAuthorities.get(actorId) : undefined;
    let retireTtlAuthority: string | undefined;
    const material = ['announce', 'depart', 'finish'].includes(input.command);
    // A browser request ID is never an authority lookup key. Material effects
    // and the join-created TTL closure receive distinct server-minted tokens.
    const requestId =
      material || input.command === 'join'
        ? this.#bindLiveMaterial(entry, principal)
        : (input.requestId ?? randomUUID());
    const cursorPublicationId =
      input.command === 'cursor' ? randomUUID() : undefined;
    // Material appends retain a pre-effect recovery image. Non-material live
    // activity is checkpointed once after mutation, avoiding two recovery-rate
    // admissions for the normal 120-transition/minute workload.
    if (material && input.command !== 'announce') {
      const checkpoint = await this.#checkpointForRequest({
        taskId: input.taskId,
        request: input.request,
        document,
        principal,
        entry,
        now,
      });
      if (checkpoint !== 'stored') return { kind: checkpoint } as const;
    }
    if (material) {
      if (
        !(await this.#sameAuthorizedDocument(
          input.taskId,
          input.request,
          document,
          principal,
        ))
      )
        return { kind: 'not-found' } as const;
      this.#activeLiveMaterial.set(requestId, input.request);
    }
    const scope = entry.room.scope;
    const authorization: LiveWorkAuthorization = {
      actorId,
      scope,
      capabilities: new Set([
        'join',
        'read',
        'write',
        'watch',
        'follow',
        'announce',
        'history-read',
      ]),
    };
    let result: LiveWorkMutationOutcome;
    try {
      if (input.command === 'join')
        result = entry.room.join({ actorId, requestId }, authorization, now);
      else if (input.command === 'heartbeat')
        result = entry.room.heartbeat({ actorId }, authorization, now);
      else if (input.command === 'announce') {
        // Prepare the exact durable proposal first.  With an asynchronous room
        // history port this produces an indeterminate pending intent without
        // dispatching it, so the recovery image below is the authoritative retry
        // record before SQLite can commit `live-work-started`.
        const prepared = entry.room.announce(
          { actorId, requestId },
          authorization,
          now,
        );
        if (
          prepared.outcome === 'degraded' &&
          prepared.state === 'indeterminate'
        ) {
          const preparedCheckpoint = await this.#checkpointForRequest({
            taskId: input.taskId,
            request: input.request,
            document,
            principal,
            entry,
            now,
            unarmedLifecycleId: prepared.intentId,
          });
          if (preparedCheckpoint !== 'stored') {
            await this.#discardPreparedRecovery(
              document,
              entry,
              prepared.intentId,
              requestId,
              now,
            );
            return { kind: preparedCheckpoint } as const;
          }
          const armedCheckpoint = await this.#checkpointForRequest({
            taskId: input.taskId,
            request: input.request,
            document,
            principal,
            entry,
            now,
          });
          if (armedCheckpoint !== 'stored') {
            await this.#discardPreparedRecovery(
              document,
              entry,
              prepared.intentId,
              requestId,
              now,
            );
            return { kind: armedCheckpoint } as const;
          }
          this.#activeLiveMaterial.set(requestId, input.request);
          result = await entry.room.settlePreparedAsync(
            prepared.intentId,
            authorization,
            now,
          );
        } else result = prepared;
      } else if (input.command === 'depart')
        result = await entry.room.departAsync(
          { actorId, requestId },
          authorization,
          now,
        );
      else if (input.command === 'watch')
        result = entry.room.watch(
          {
            actorId,
            paneId: input.paneId ?? '',
            targetActorId: input.targetActorId ?? '',
          },
          authorization,
          now,
        );
      else if (input.command === 'follow')
        result = entry.room.follow(
          {
            actorId,
            paneId: input.paneId ?? '',
            targetActorId: input.targetActorId ?? '',
          },
          authorization,
          now,
        );
      else if (input.command === 'stop')
        result = entry.room.localInput(
          { actorId, paneId: input.paneId ?? '' },
          authorization,
          now,
        );
      else if (input.command === 'typing')
        result = entry.room.setTyping(
          { actorId, active: input.active === true },
          authorization,
          now,
        );
      else if (input.command === 'cursor')
        result = await this.#setCursor({
          document,
          entry,
          actorId,
          generation: input.generation,
          workingRevision: input.workingRevision,
          selection: input.selection,
          authorization,
          now,
          request: input.request,
          principal,
          taskId: input.taskId,
          publicationId: cursorPublicationId!,
        });
      else
        result = await entry.room.finishAsync(
          { actorId, requestId, outcome: input.outcome ?? 'cancelled' },
          authorization,
          now,
        );
    } finally {
      this.#activeLiveMaterial.delete(requestId);
    }
    // Never disclose a settled result if the paired-device/operator grant was
    // revoked while the durable append awaited its worker boundary.
    if (
      material &&
      !(await this.#sameAuthorizedDocument(
        input.taskId,
        input.request,
        document,
        principal,
      ))
    )
      return { kind: 'not-found' } as const;
    if (
      (material || input.command === 'join') &&
      result.outcome !== 'degraded' &&
      result.outcome !== 'unavailable'
    )
      entry.authorities.delete(requestId);
    if (input.command === 'join') {
      const currentTtl = entry.ttlAuthorities.get(actorId);
      if (result.outcome === 'joined' || result.outcome === 'refreshed') {
        // The identity authority installed a replacement token during join.
        // Retire its old token only after the replacement reached recovery
        // storage; a crash between mutation and checkpoint must still replay
        // the old durable closure with its matching authority.
        if (priorTtlAuthority && priorTtlAuthority !== currentTtl)
          retireTtlAuthority = priorTtlAuthority;
      } else {
        // Identity resolution happens inside LiveWorkSession.join. Restore the
        // prior closure authority when that admission did not take effect.
        if (currentTtl && currentTtl !== priorTtlAuthority)
          entry.authorities.delete(currentTtl);
        if (priorTtlAuthority)
          entry.ttlAuthorities.set(actorId, priorTtlAuthority);
        else entry.ttlAuthorities.delete(actorId);
      }
    }
    if (
      input.command === 'depart' &&
      (result.outcome === 'updated' || result.outcome === 'departed')
    ) {
      this.#releaseTtlAuthority(entry, actorId);
      entry.cursors.delete(actorId);
      entry.cursorAdmissions.delete(actorId);
    }
    // A successful announce must persist its lifecycle and dormant TTL closure
    // before this response becomes observable. Other successful material
    // effects are already terminally durable; degraded material remains
    // checkpointed for exact retry. Every non-material command checkpoints
    // once after mutation.
    const mustCheckpointAfter =
      (input.command !== 'cursor' && !material) ||
      input.command === 'announce' ||
      result.outcome === 'degraded' ||
      result.outcome === 'unavailable';
    if (mustCheckpointAfter) {
      const checkpoint = await this.#checkpointForRequest({
        taskId: input.taskId,
        request: input.request,
        document,
        principal,
        entry,
        now,
      });
      if (checkpoint !== 'stored') return { kind: checkpoint } as const;
    }
    // The immediately preceding checkpoint (if any) and every material
    // settlement crossed an async boundary. No live projection may be returned
    // until the exact initiating principal is current one final time.
    if (
      !(await this.#sameAuthorizedDocument(
        input.taskId,
        input.request,
        document,
        principal,
      ))
    ) {
      if (cursorPublicationId) {
        if (entry.cursors.get(actorId)?.publicationId === cursorPublicationId)
          entry.cursors.delete(actorId);
        const admissions = entry.cursorAdmissions
          .get(actorId)
          ?.filter(
            (admission) => admission.publicationId !== cursorPublicationId,
          );
        if (admissions?.length) entry.cursorAdmissions.set(actorId, admissions);
        else entry.cursorAdmissions.delete(actorId);
      }
      return { kind: 'not-found' } as const;
    }
    if (retireTtlAuthority) entry.authorities.delete(retireTtlAuthority);
    const event = {
      kind: 'available' as const,
      generation: entry.generation,
      viewerActorId: actorId,
      result,
      // #checkpointLive may advance the session safe clock. Never take a
      // projection with the stale pre-checkpoint clock.
      snapshot: this.#liveSnapshot(entry, authorization, now, true),
    };
    this.#notify(document, { type: 'live', ...event });
    return event;
  }

  async subscribe(input: {
    taskId: string;
    request: Request;
    emit: (event: unknown) => void;
    after?: string;
  }) {
    const document = await this.#authorizedDocument(
      input.taskId,
      input.request,
    );
    const principal = document
      ? await this.#principal(input.request)
      : undefined;
    if (!document || !principal) return { kind: 'not-found' } as const;
    const key = documentKey(document);
    const subscribers = this.#subscribers.get(key) ?? new Set<RoomSubscriber>();
    const subscriber: RoomSubscriber = {
      request: input.request,
      emit: input.emit,
      ready: false,
      pending: [],
    };
    subscribers.add(subscriber);
    this.#subscribers.set(key, subscribers);
    if (!this.#unwatchWorking)
      this.#unwatchWorking = this.#deps.working.watch(() => {
        void this.#publishWorkingChanges();
      });
    if (!(await this.#recoverPending(document))) {
      this.#removeSubscriber(document, subscriber);
      return { kind: 'not-found' } as const;
    }
    const now = Date.now();
    const entry = this.#liveEntry(document, now);
    const authorization: LiveWorkAuthorization = {
      actorId: actorIdFor(principal),
      scope: entry.room.scope,
      capabilities: new Set(['read']),
    };
    const documentProjection = await this.#deps.working.read({
      scope: document,
      ...(input.after ? { after: input.after } : {}),
    });
    if (
      !(await this.#sameAuthorizedDocument(
        input.taskId,
        input.request,
        document,
        principal,
      ))
    ) {
      this.#removeSubscriber(document, subscriber);
      return { kind: 'not-found' } as const;
    }
    return {
      kind: 'subscribed' as const,
      initial: {
        type: 'snapshot',
        generation: entry.generation,
        viewerActorId: actorIdFor(principal),
        live: this.#liveSnapshot(entry, authorization, now),
        document: documentProjection,
      },
      unsubscribe: () => {
        this.#removeSubscriber(document, subscriber);
      },
      activate: () => {
        subscriber.ready = true;
        for (const event of subscriber.pending.splice(0))
          subscriber.emit(event);
      },
    };
  }

  /** SSE cadence rechecks the same request authority even when the document is idle. */
  async subscriptionAlive(input: { taskId: string; request: Request }) {
    return Boolean(await this.#authorizedDocument(input.taskId, input.request));
  }

  /**
   * Cadence is not merely a heartbeat: it advances TTL pruning, checkpoints
   * its recovery image, and republishes the resulting live projection under
   * the subscriber's still-current paired-device authority.
   */
  async subscriptionCadence(input: { taskId: string; request: Request }) {
    const document = await this.#authorizedDocument(
      input.taskId,
      input.request,
    );
    const principal = document
      ? await this.#principal(input.request)
      : undefined;
    if (!document || !principal) return false;
    const entry = this.#live.get(documentKey(document));
    if (!entry) return true;
    const now = Date.now();
    const authorization: LiveWorkAuthorization = {
      actorId: actorIdFor(principal),
      scope: entry.room.scope,
      capabilities: new Set(['read']),
    };
    const snapshot = this.#liveSnapshot(entry, authorization, now);
    if (snapshot.outcome !== 'available') return false;
    // snapshot() is also the TTL prune point. Persist that pre-effect image
    // before attempting the newly materialized closure(s), so a crash can
    // replay exactly the same durable intent.
    if (
      (await this.#checkpointForRequest({
        taskId: input.taskId,
        request: input.request,
        document,
        principal,
        entry,
        now,
      })) !== 'stored'
    )
      return false;
    const reconciled = await this.#reconcileCadencePending(
      document,
      entry,
      now,
    );
    if (reconciled === undefined) return false;
    if (
      reconciled &&
      (await this.#checkpointForRequest({
        taskId: input.taskId,
        request: input.request,
        document,
        principal,
        entry,
        now,
      })) !== 'stored'
    )
      return false;
    const current = this.#liveSnapshot(entry, authorization, now);
    if (current.outcome !== 'available') return false;
    if (reconciled) await this.#publishHistory(document);
    this.#notify(document, {
      type: 'live',
      kind: 'available',
      generation: entry.generation,
      result: { outcome: 'updated' },
      snapshot: current,
    });
    return true;
  }

  /**
   * Host-wide Activity read composed from the already-live room authorities.
   * This is intentionally a projection only: it never opens a room, restores
   * presence, or turns a connected browser into a publishing participant.
   */
  async liveActivity(input: { request: Request }): Promise<
    | {
        readonly kind: 'available';
        readonly projection: LiveActivityRoomProjection;
      }
    | { readonly kind: 'unavailable' }
  > {
    if (this.#closed || this.#deps.hosted?.()) return { kind: 'unavailable' };
    const observedAt = Date.now();
    const rows: LiveActivityRoomProjection['participants'][number][] = [];
    const entries = orderedLiveActivityEntries([...this.#live.values()]);
    let authorizedRooms = 0;

    for (const entry of entries) {
      if (
        rows.length >= LIVE_ACTIVITY_MAX_PARTICIPANTS ||
        !canCollectLiveActivityRoom(authorizedRooms)
      )
        break;
      const taskScope = this.#scope(entry.room.scope.taskId);
      const document = await this.#authorizedDocument(
        entry.room.scope.taskId,
        input.request,
      );
      const principal = document
        ? await this.#principal(input.request)
        : undefined;
      if (
        !taskScope ||
        !document ||
        !principal ||
        !sameDocument(document, {
          projectId: entry.room.scope.projectId,
          taskId: entry.room.scope.taskId,
          documentId: entry.room.scope.surfaceId,
        })
      )
        continue;
      // Recheck at the exact read boundary. The prior async task/document and
      // principal reads prove nothing about a credential revoked while they
      // were in flight.
      if (
        !(await this.#sameAuthorizedDocument(
          entry.room.scope.taskId,
          input.request,
          document,
          principal,
        ))
      )
        continue;
      authorizedRooms += 1;
      const live = this.#liveSnapshot(
        entry,
        {
          actorId: actorIdFor(principal),
          scope: entry.room.scope,
          capabilities: new Set(['read']),
        },
        observedAt,
      );
      if (live.outcome !== 'available') continue;
      const visibleByActor = new Map(
        live.snapshot.participants.map((participant) => [
          participant.actor.actorId,
          participant,
        ]),
      );
      const paneByActor = new Map(
        live.snapshot.panes
          .filter(
            (pane) =>
              (pane.state === 'watching' || pane.state === 'following') &&
              pane.targetActorId !== undefined &&
              visibleByActor.has(pane.targetActorId),
          )
          .map((pane) => [pane.actorId, pane]),
      );
      for (const participant of live.snapshot.participants) {
        if (rows.length >= LIVE_ACTIVITY_MAX_PARTICIPANTS) break;
        if (participant.publication !== 'published') continue;
        const pane = paneByActor.get(participant.actor.actorId);
        const target = pane?.targetActorId
          ? visibleByActor.get(pane.targetActorId)
          : undefined;
        const watchingState =
          pane?.state === 'watching' || pane?.state === 'following'
            ? pane.state
            : undefined;
        rows.push({
          id: createHash('sha256')
            .update(
              `${entry.room.scope.projectId}\u0000${entry.room.scope.taskId}\u0000${participant.actor.actorId}`,
            )
            .digest('hex')
            .slice(0, 24),
          actor: {
            kind: participant.actor.kind,
            label: participant.actor.label,
          },
          scope: {
            projectId: taskScope.projectId,
            projectSlug: taskScope.projectSlug,
            taskId: taskScope.taskId,
          },
          work:
            participant.actor.kind === 'agent'
              ? participant.work
              : {
                  workName: participant.work.workName,
                  workState: participant.work.workState,
                  startedAt: participant.work.startedAt,
                },
          ...(watchingState && target
            ? {
                watching: {
                  state: watchingState,
                  targetLabel: target.actor.label,
                },
              }
            : {}),
        });
      }
    }
    return {
      kind: 'available',
      projection: {
        schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
        observedAt,
        participants: rows,
      },
    };
  }

  async close() {
    this.#closed = true;
    this.#issued.clear();
    this.#plans.clear();
    this.#recovery.clear();
    this.#activeLiveMaterial.clear();
    this.#activeLiveRecovery.clear();
    this.#unwatchWorking?.();
    this.#unwatchWorking = undefined;
    this.#subscribers.clear();
    this.#documentNotificationChains.clear();
    this.#notificationChains.clear();
    await Promise.all(
      [...this.#live.values()].map((entry) => entry.room.close()),
    );
    this.#live.clear();
    await this.#deps.working.close();
    const history = await this.#history.close();
    this.#deps.revisionEvidence?.close();
    return history;
  }

  async #persistAgentLifecycle(
    lifecycle: PendingAgentLifecycle,
  ): Promise<void> {
    if (this.#closed || this.#deps.hosted?.()) return;
    const scope = this.#scope(lifecycle.taskId);
    if (!scope) return;
    await this.#deps.working.agentLifecycle({
      scope: { ...scope, documentId: documentIdFor(scope) },
      intentId: `agent:${lifecycle.outcome}:${lifecycle.sessionId}`,
      value: lifecycle,
    });
  }

  async #publishAgentLifecycle(
    lifecycle: PendingAgentLifecycle,
  ): Promise<void> {
    if (this.#closed || this.#deps.hosted?.()) return;
    const task = this.#deps.taskGraph.readTaskView(lifecycle.taskId);
    if (
      !task?.agentId ||
      task.id !== lifecycle.taskId ||
      task.sessionId !== lifecycle.sessionId
    )
      return;
    const scope = this.#scope(task.id);
    if (!scope) return;
    const principal: Extract<ProjectTaskRoomPrincipal, { kind: 'agent' }> = {
      kind: 'agent',
      agentId: task.agentId,
      ownerOperatorId: task.createdBy,
      deviceId: `agent-session:${lifecycle.sessionId}`,
      authorizationReceiptId: lifecycle.authorizationReceiptId,
    };
    // The channel must exist before append. This is a private server grant;
    // the browser never receives it and cannot select the agent identity.
    const opened = this.#issueAgent(scope, principal, 'discover');
    const open = await this.#history.open({ grant: opened });
    if (open.kind !== 'opened' && open.kind !== 'existing') return;
    const grant = this.#issueAgent(scope, principal, 'agent-publish');
    const append = await this.#history.append({
      grant,
      intent: {
        proposalId: `agent:${lifecycle.outcome}:${lifecycle.sessionId}`,
        occurredAt: lifecycle.occurredAt,
        correlationId: lifecycle.sessionId,
        causationId: lifecycle.dispatchId,
        body:
          lifecycle.outcome === 'started'
            ? { kind: 'live-work-started', sessionId: lifecycle.sessionId }
            : {
                kind: 'live-work-finished',
                sessionId: lifecycle.sessionId,
                outcome: lifecycle.outcome,
              },
      },
    });
    if (append.kind === 'committed' || append.kind === 'duplicate') {
      if (lifecycle.outcome === 'started')
        this.#publishAgentPresence({
          task,
          scope,
          sessionId: lifecycle.sessionId,
          provider: lifecycle.provider,
          startedAt: Date.parse(lifecycle.occurredAt),
        });
      else this.#removeAgentPresence(scope, task.agentId, lifecycle.sessionId);
      await this.#deps.working.removeAgentLifecycle({
        scope: { ...scope, documentId: documentIdFor(scope) },
        intentId: `agent:${lifecycle.outcome}:${lifecycle.sessionId}`,
      });
      await this.#publishHistory({
        projectId: scope.projectId,
        taskId: scope.taskId,
        documentId: documentIdFor(scope),
      });
    }
  }

  #agentAssociation(input: {
    readonly taskId: string;
    readonly agentId: string;
    readonly sessionId: string;
  }):
    | {
        readonly task: TaskRecord;
        readonly scope: ProjectTaskRoomScope;
        readonly document: {
          readonly projectId: string;
          readonly taskId: string;
          readonly documentId: string;
        };
      }
    | undefined {
    if (this.#closed || this.#deps.hosted?.()) return undefined;
    const task = this.#deps.taskGraph.readTaskView(input.taskId);
    const scope = this.#scope(input.taskId);
    if (
      !task ||
      !scope ||
      task.id !== input.taskId ||
      task.agentId !== input.agentId ||
      task.sessionId !== input.sessionId ||
      task.projectId !== scope.projectId
    )
      return undefined;
    return {
      task,
      scope,
      document: { ...scope, documentId: documentIdFor(scope) },
    };
  }

  #publishAgentPresence(input: {
    readonly task: TaskRecord;
    readonly scope: ProjectTaskRoomScope;
    readonly sessionId: string;
    readonly provider?: string;
    readonly startedAt: number;
  }): void {
    if (
      this.#closed ||
      input.task.agentId === undefined ||
      input.task.sessionId !== input.sessionId
    )
      return;
    const document = {
      ...input.scope,
      documentId: documentIdFor(input.scope),
    };
    const entry = this.#liveEntry(
      document,
      Number.isSafeInteger(input.startedAt) && input.startedAt >= 0
        ? input.startedAt
        : Date.now(),
    );
    const actorId = agentActorId(
      input.task.id,
      input.task.agentId,
      input.sessionId,
    );
    const existingRunId = entry.agentParticipants.get(actorId)?.work.runId;
    const runId = input.provider
      ? createOrchestrationRunId(input.provider, input.sessionId)
      : existingRunId;
    entry.agentParticipants.set(actorId, {
      actor: { actorId, kind: 'agent', label: input.task.agentId },
      work: {
        sessionId: input.sessionId,
        ...(runId ? { runId } : {}),
        workName: input.task.title,
        workState: 'working',
        startedAt:
          Number.isSafeInteger(input.startedAt) && input.startedAt >= 0
            ? input.startedAt
            : Date.now(),
      },
      publication: 'published',
    });
    this.#notify(document, {
      type: 'live',
      kind: 'available',
      generation: entry.generation,
      result: { outcome: 'updated' },
      snapshot: { outcome: 'available' },
    });
  }

  #removeAgentPresence(
    scope: ProjectTaskRoomScope,
    agentId: string,
    sessionId: string,
  ): void {
    const document = { ...scope, documentId: documentIdFor(scope) };
    const entry = this.#live.get(documentKey(document));
    if (!entry) return;
    entry.agentParticipants.delete(
      agentActorId(scope.taskId, agentId, sessionId),
    );
    this.#notify(document, {
      type: 'live',
      kind: 'available',
      generation: entry.generation,
      result: { outcome: 'updated' },
      snapshot: { outcome: 'available' },
    });
  }

  #issueAgent<K extends 'discover' | 'agent-publish'>(
    scope: ProjectTaskRoomScope,
    principal: Extract<ProjectTaskRoomPrincipal, { kind: 'agent' }>,
    capability: K,
  ): ProjectTaskRoomGrant<K> {
    const token = randomUUID();
    while (this.#issued.size >= 256)
      this.#issued.delete(this.#issued.keys().next().value!);
    this.#issued.set(token, {
      capability,
      scope,
      principal,
      receiptId: principal.authorizationReceiptId,
    });
    return Object.freeze({
      schemaVersion: 'station.project-task-room-grant/v1',
      capability,
      opaqueToken: token,
    }) as ProjectTaskRoomGrant<K>;
  }

  #bindLiveMaterial(
    entry: Pick<LiveRoomEntry, 'authorities' | 'ttlAuthorities'>,
    principal: RequestPrincipal,
  ) {
    const token = randomUUID();
    // A live TTL closure is the only system authority that can later emit its
    // exact durable departure. Never evict a currently-live closure token to
    // make room for a transient material request.
    while (entry.authorities.size >= 256) {
      const pinned = new Set(entry.ttlAuthorities.values());
      const evict = [...entry.authorities.keys()].find(
        (candidate) => !pinned.has(candidate),
      );
      if (!evict) break;
      entry.authorities.delete(evict);
    }
    entry.authorities.set(token, { principal });
    return token;
  }
  #releaseTtlAuthority(entry: LiveRoomEntry, actorId: string) {
    const token = entry.ttlAuthorities.get(actorId);
    if (token) entry.authorities.delete(token);
    entry.ttlAuthorities.delete(actorId);
  }

  async #issueLiveMaterial<K extends RoomCapability>(
    taskId: string,
    authority: LiveMaterialAuthority,
    capability: K,
    materialId: string,
    ttlClosureAuthority = false,
  ): Promise<ProjectTaskRoomGrant<K> | undefined> {
    const request = this.#activeLiveMaterial.get(materialId);
    if (!request) {
      if (!ttlClosureAuthority && !this.#activeLiveRecovery.has(materialId))
        return undefined;
      return this.#issueSystemLiveMaterial(taskId, authority, capability);
    }
    // The binding carries immutable identity for collision-free recovery, but
    // every live effect mints its grant from a fresh canonical request check.
    const grant = await this.#issue(taskId, request, capability);
    if (!grant) return undefined;
    const current = await this.#principal(request);
    return current && samePrincipal(authority.principal, current)
      ? grant
      : undefined;
  }
  /** Mints a bounded private grant for a persisted, system-authorized retry. */
  #issueSystemLiveMaterial<K extends RoomCapability>(
    taskId: string,
    authority: LiveMaterialAuthority,
    capability: K,
  ): ProjectTaskRoomGrant<K> | undefined {
    const scope = this.#scope(taskId);
    if (!scope) return undefined;
    const token = randomUUID();
    while (this.#issued.size >= 256)
      this.#issued.delete(this.#issued.keys().next().value!);
    this.#issued.set(token, {
      capability,
      scope,
      principal: authority.principal,
      material: true,
      receiptId: requestReceiptId(scope, authority.principal, capability),
    });
    return Object.freeze({
      schemaVersion: 'station.project-task-room-grant/v1',
      capability,
      opaqueToken: token,
    }) as ProjectTaskRoomGrant<K>;
  }

  async #revalidateAgent(receipt: {
    receiptId: string;
    scope: ProjectTaskRoomScope;
    principal: ProjectTaskRoomPrincipal;
  }) {
    if (receipt.principal.kind !== 'agent') return { kind: 'denied' as const };
    const task = this.#deps.taskGraph.readTaskView(receipt.scope.taskId);
    return task &&
      task.projectId === receipt.scope.projectId &&
      receipt.receiptId === receipt.principal.authorizationReceiptId &&
      task.agentId === receipt.principal.agentId &&
      task.createdBy === receipt.principal.ownerOperatorId &&
      task.sessionId === agentSessionId(receipt.principal) &&
      sameScope(receipt.scope, this.#scope(task.id) ?? receipt.scope)
      ? { kind: 'authorized' as const, principal: receipt.principal }
      : { kind: 'revoked' as const };
  }

  async #issue<K extends RoomCapability>(
    taskId: string,
    request: Request,
    capability: K,
  ): Promise<ProjectTaskRoomGrant<K> | undefined> {
    if (this.#closed || this.#deps.hosted?.()) return undefined;
    const scope = this.#scope(taskId);
    if (!scope) return undefined;
    const principal = await this.#principal(request);
    if (!principal) return undefined;
    const token = randomUUID();
    // Grants span only the one request → history-worker operation. Keep their
    // registry bounded even when a peer floods distinct, otherwise-valid
    // requests; eviction merely makes an old in-flight operation unavailable.
    while (this.#issued.size >= 256)
      this.#issued.delete(this.#issued.keys().next().value!);
    this.#issued.set(token, {
      capability,
      scope,
      principal,
      request,
      receiptId: requestReceiptId(scope, principal, capability),
    });
    return Object.freeze({
      schemaVersion: 'station.project-task-room-grant/v1',
      capability,
      opaqueToken: token,
    }) as ProjectTaskRoomGrant<K>;
  }

  async #setCursor(input: {
    document: { projectId: string; taskId: string; documentId: string };
    entry: LiveRoomEntry;
    actorId: string;
    generation?: string;
    workingRevision?: string;
    selection?: { anchor: number; focus: number };
    authorization: LiveWorkAuthorization;
    now: number;
    request: Request;
    principal: RequestPrincipal;
    taskId: string;
    publicationId: string;
  }): Promise<LiveWorkMutationOutcome> {
    if (
      input.generation !== input.entry.generation ||
      typeof input.workingRevision !== 'string' ||
      !input.workingRevision ||
      !input.selection ||
      !Number.isSafeInteger(input.selection.anchor) ||
      !Number.isSafeInteger(input.selection.focus) ||
      input.selection.anchor < 0 ||
      input.selection.focus < 0
    )
      return { outcome: 'invalid' };
    const live = input.entry.room.snapshot(input.authorization, input.now);
    if (
      live.outcome !== 'available' ||
      !live.snapshot.participants.some(
        (participant) => participant.actor.actorId === input.actorId,
      )
    )
      return { outcome: 'forbidden' };
    const document = await this.#deps.working.read({ scope: input.document });
    const authorized = await this.#sameAuthorizedDocument(
      input.taskId,
      input.request,
      input.document,
      input.principal,
    );
    if (
      !authorized ||
      input.entry.generation !== input.generation ||
      actorIdFor(input.principal) !== input.actorId
    )
      return { outcome: 'unavailable' };
    if (
      (document.kind !== 'snapshot' && document.kind !== 'delta') ||
      document.revision !== input.workingRevision ||
      typeof document.text !== 'string' ||
      input.selection.anchor > document.text.length ||
      input.selection.focus > document.text.length
    )
      return { outcome: 'invalid' };
    // No await occurs after this exact post-worker authority/revision witness.
    // The staged cursor becomes public in one synchronous critical section.
    this.#pruneCursors(input.entry, input.now);
    const admissions = (
      input.entry.cursorAdmissions.get(input.actorId) ?? []
    ).filter((admission) => admission.timestamp > input.now - 1_000);
    if (admissions.length >= PROJECT_TASK_ROOM_CURSOR_RATE_PER_SECOND)
      return { outcome: 'rate_limited' };
    if (
      !input.entry.cursors.has(input.actorId) &&
      input.entry.cursors.size >= PROJECT_TASK_ROOM_CURSOR_LIMIT
    )
      return { outcome: 'capacity_exceeded' };
    admissions.push({
      timestamp: input.now,
      publicationId: input.publicationId,
    });
    input.entry.cursorAdmissions.set(input.actorId, admissions);
    input.entry.cursors.set(input.actorId, {
      actorId: input.actorId,
      workingRevision: input.workingRevision,
      selection: { ...input.selection },
      expiresAt: input.now + PROJECT_TASK_ROOM_CURSOR_TTL_MS,
      publicationId: input.publicationId,
    });
    return { outcome: 'updated' };
  }

  #pruneCursors(entry: LiveRoomEntry, now: number): void {
    for (const [actorId, cursor] of entry.cursors)
      if (cursor.expiresAt <= now) entry.cursors.delete(actorId);
    for (const [actorId, admissions] of entry.cursorAdmissions) {
      const current = admissions.filter(
        (admission) => admission.timestamp > now - 1_000,
      );
      if (current.length) entry.cursorAdmissions.set(actorId, current);
      else entry.cursorAdmissions.delete(actorId);
    }
  }

  #liveSnapshot(
    entry: LiveRoomEntry,
    authorization: LiveWorkAuthorization,
    now: number,
    afterMutation = false,
  ) {
    this.#pruneCursors(entry, now);
    const read = afterMutation
      ? entry.room.snapshotAfterMutation(authorization, now)
      : entry.room.snapshot(authorization, now);
    if (read.outcome !== 'available') return read;
    const participants = [...read.snapshot.participants];
    for (const participant of entry.agentParticipants.values())
      if (
        !participants.some(
          (candidate) => candidate.actor.actorId === participant.actor.actorId,
        )
      )
        participants.push(participant);
    participants.sort((left, right) =>
      left.actor.actorId.localeCompare(right.actor.actorId),
    );
    const visibleActors = new Set(
      participants.map((participant) => participant.actor.actorId),
    );
    return {
      outcome: 'available' as const,
      snapshot: {
        ...read.snapshot,
        participants,
        cursors: [...entry.cursors.values()]
          .filter((cursor) => visibleActors.has(cursor.actorId))
          .sort((left, right) => left.actorId.localeCompare(right.actorId))
          .map((cursor) => ({
            actorId: cursor.actorId,
            workingRevision: cursor.workingRevision,
            selection: { ...cursor.selection },
            expiresAt: cursor.expiresAt,
          })),
      },
    };
  }

  #liveEntry(
    document: { projectId: string; taskId: string; documentId: string },
    sessionStartedAt: number,
  ) {
    const key = `${document.projectId}\u0000${document.taskId}\u0000${document.documentId}`;
    const existing = this.#live.get(key);
    if (existing) return existing;
    const generation = randomUUID();
    const scope: LiveWorkScope = {
      projectId: document.projectId,
      taskId: document.taskId,
      surfaceId: document.documentId,
      sessionId: generation,
      channelId: `room:${document.documentId}`,
    };
    const authorities = new Map<string, LiveMaterialAuthority>();
    const ttlAuthorities = new Map<string, string>();
    const room = this.#createLiveSession(
      scope,
      document,
      authorities,
      ttlAuthorities,
      sessionStartedAt,
    );
    const entry: LiveRoomEntry = {
      generation,
      room,
      authorities,
      ttlAuthorities,
      cursors: new Map(),
      cursorAdmissions: new Map(),
      agentParticipants: new Map(),
    };
    this.#live.set(key, entry);
    return entry;
  }
  #createLiveSession(
    scope: LiveWorkScope,
    document: { projectId: string; taskId: string; documentId: string },
    authorities: Map<string, LiveMaterialAuthority>,
    ttlAuthorities: Map<string, string>,
    sessionStartedAt: number,
  ) {
    const adapter = new ProjectTaskLiveWorkHistoryAdapter(this.#history, {
      issue: async ({ requestId, capability }) => {
        const authority = authorities.get(requestId);
        const grant = authority
          ? await this.#issueLiveMaterial(
              document.taskId,
              authority,
              capability,
              requestId,
              [...ttlAuthorities.values()].includes(requestId),
            )
          : undefined;
        return grant ? { kind: 'granted', grant } : { kind: 'denied' as const };
      },
    });
    return new LiveWorkSession(
      scope,
      {},
      { history: adapter },
      {
        identityAuthority: {
          resolve: ({ actorId, requestId }) => {
            const authority = authorities.get(requestId);
            if (!authority || actorIdFor(authority.principal) !== actorId)
              return { state: 'UNAVAILABLE' as const };
            const ttlClosureRequestId = this.#bindLiveMaterial(
              { authorities, ttlAuthorities },
              authority.principal,
            );
            ttlAuthorities.set(actorId, ttlClosureRequestId);
            return {
              state: 'AVAILABLE' as const,
              identity: {
                actor: {
                  actorId,
                  kind: 'human',
                  // The browser may distinguish live collaborators, but a
                  // paired-device identifier is private authority material.
                  // Derive a stable opaque display label from the actor ID so
                  // every SSE projection remains safe to persist or share.
                  label: participantDisplayLabel(authority.principal),
                },
                occurrenceId: `${scope.sessionId}:${actorId}`,
                sessionId: scope.sessionId,
                workName: 'Project task work',
                workState: 'working',
                startedAt: sessionStartedAt,
                ttlClosureRequestId,
              },
            };
          },
        },
        // This runtime owns the private SQLite recovery adapter and is the
        // only composition seam permitted to use system recovery authority.
        recoveryAuthority: {
          authorize: ({ authorization, scope }) =>
            authorization.kind === 'system' &&
            authorization.scope.projectId === scope.projectId &&
            authorization.scope.taskId === scope.taskId &&
            authorization.scope.surfaceId === scope.surfaceId &&
            authorization.scope.sessionId === scope.sessionId &&
            authorization.scope.channelId === scope.channelId,
        },
      },
    );
  }
  #notify(
    document: { projectId: string; taskId: string; documentId: string },
    event: unknown,
  ) {
    const key = documentKey(document);
    const chains = isDocumentNotification(event)
      ? this.#documentNotificationChains
      : this.#notificationChains;
    const prior = chains.get(key) ?? Promise.resolve();
    const next = prior
      .then(() => this.#notifyAuthorized(document, event))
      .catch(() => {});
    chains.set(key, next);
    void next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
    return next;
  }
  /** One teardown seam for setup failures, terminal delivery, and unsubscribe. */
  #removeSubscriber(
    document: { projectId: string; taskId: string; documentId: string },
    subscriber: RoomSubscriber,
  ) {
    const key = documentKey(document);
    const subscribers = this.#subscribers.get(key);
    if (!subscribers) return;
    subscribers.delete(subscriber);
    if (!subscribers.size) this.#subscribers.delete(key);
    if (!this.#subscribers.size) {
      this.#unwatchWorking?.();
      this.#unwatchWorking = undefined;
    }
  }
  async #notifyAuthorized(
    document: { projectId: string; taskId: string; documentId: string },
    event: unknown,
  ) {
    const subscribers = this.#subscribers.get(documentKey(document));
    if (!subscribers) return;
    for (const subscriber of [...subscribers]) {
      const projected = await this.#subscriberEvent(
        document,
        subscriber.request,
        event,
      );
      if (projected === undefined) {
        this.#deliver(subscriber, { type: 'terminal' });
        this.#removeSubscriber(document, subscriber);
        continue;
      }
      this.#deliver(subscriber, projected);
    }
    if (!subscribers.size) this.#subscribers.delete(documentKey(document));
  }
  async #subscriberEvent(
    document: { projectId: string; taskId: string; documentId: string },
    request: Request,
    event: unknown,
  ): Promise<unknown | undefined> {
    const current = await this.#authorizedDocumentWithPrincipal(
      document.taskId,
      request,
    );
    if (!current || !sameDocument(current.document, document)) return undefined;
    if (
      !event ||
      typeof event !== 'object' ||
      (event as { type?: unknown }).type !== 'live'
    )
      return event;
    const entry = this.#live.get(documentKey(document));
    if (!entry) return undefined;
    const authorization: LiveWorkAuthorization = {
      actorId: actorIdFor(current.principal),
      scope: entry.room.scope,
      capabilities: new Set(['read']),
    };
    return {
      ...(event as Record<string, unknown>),
      viewerActorId: actorIdFor(current.principal),
      snapshot: this.#liveSnapshot(entry, authorization, Date.now(), true),
    };
  }
  #deliver(subscriber: RoomSubscriber, event: unknown) {
    if (!subscriber.ready) {
      if (subscriber.pending.length < 64) subscriber.pending.push(event);
      else {
        subscriber.pending = [{ type: 'terminal' }];
      }
      return;
    }
    try {
      subscriber.emit(event);
    } catch {}
  }
  async #subscriberAuthorized(
    document: { projectId: string; taskId: string; documentId: string },
    request: Request,
  ) {
    const current = await this.#authorizedDocument(document.taskId, request);
    return Boolean(current && sameDocument(current, document));
  }
  async #publishHistory(document: {
    projectId: string;
    taskId: string;
    documentId: string;
  }) {
    const subscribers = this.#subscribers.get(documentKey(document));
    if (!subscribers) return;
    for (const subscriber of [...subscribers]) {
      const result = await this.history({
        taskId: document.taskId,
        request: subscriber.request,
        limit: 50,
        project: true,
      });
      if (result.kind === 'not-found') {
        this.#deliver(subscriber, { type: 'terminal' });
        this.#removeSubscriber(document, subscriber);
      } else if (result.kind !== 'unavailable')
        this.#deliver(subscriber, { type: 'history', ...result });
    }
  }

  async #checkpointLive(
    document: { projectId: string; taskId: string; documentId: string },
    entry: LiveRoomEntry,
    now: number,
    armedIntentIds?: readonly string[],
    unarmedLifecycleId?: string,
  ) {
    const authorization: LiveWorkRecoveryAuthorization = {
      kind: 'system',
      recoveryId: `room-recovery:${entry.generation}`,
      scope: entry.room.scope,
    };
    const recovery = entry.room.checkpointRecovery(authorization, now);
    if (recovery.outcome !== 'available') return false;
    const value: PersistedLiveRoomRecovery = {
      schemaVersion: 'station.project-task-room-runtime-recovery/v1',
      state: recovery.state,
      armedIntentIds:
        armedIntentIds ??
        recovery.state.pending
          .filter((pending) => pending.lifecycleId !== unarmedLifecycleId)
          .map((pending) => pending.intent.intentId),
      authorities: [...entry.authorities.entries()].map(
        ([token, authority]) => ({ token, principal: authority.principal }),
      ),
    };
    return (
      (await this.#deps.working.recovery({
        scope: document,
        generation: entry.generation,
        value,
      })) === 'stored'
    );
  }
  /**
   * A recovery checkpoint crosses the private worker boundary. Its result is
   * never a credential lease: immediately prove the original document and
   * paired-device principal again before the caller can proceed.
   */
  async #checkpointForRequest(input: {
    taskId: string;
    request: Request;
    document: { projectId: string; taskId: string; documentId: string };
    principal: RequestPrincipal;
    entry: LiveRoomEntry;
    now: number;
    armedIntentIds?: readonly string[];
    unarmedLifecycleId?: string;
  }): Promise<'stored' | 'not-found' | 'unavailable'> {
    if (
      !(await this.#checkpointLive(
        input.document,
        input.entry,
        input.now,
        input.armedIntentIds,
        input.unarmedLifecycleId,
      ))
    )
      return 'unavailable';
    return (await this.#sameAuthorizedDocument(
      input.taskId,
      input.request,
      input.document,
      input.principal,
    ))
      ? 'stored'
      : 'not-found';
  }
  /** Clears a non-replayable prepared announce after authority is revoked. */
  async #discardPreparedRecovery(
    document: { projectId: string; taskId: string; documentId: string },
    entry: LiveRoomEntry,
    intentId: string,
    requestId: string,
    now: number,
  ) {
    this.#activeLiveMaterial.delete(requestId);
    entry.authorities.delete(requestId);
    entry.room.discardPrepared(intentId);
    return this.#checkpointLive(document, entry, now);
  }

  /**
   * Reconcile every durable pending fact created by the cadence prune. The
   * recovery image is the source of the actor/capability tuple; no subscriber
   * request identity is reused for another participant's TTL closure.
   */
  async #reconcileCadencePending(
    document: { projectId: string; taskId: string; documentId: string },
    entry: LiveRoomEntry,
    now: number,
  ): Promise<boolean | undefined> {
    const stored = await this.#deps.working.readRecovery({ scope: document });
    if (
      stored.kind !== 'available' ||
      stored.generation !== entry.generation ||
      !stored.value
    )
      return undefined;
    const recovery = parsePersistedRecovery(stored.value);
    if (!recovery) return undefined;
    let reconciled = false;
    const authorization: LiveWorkRecoveryAuthorization = {
      kind: 'system',
      recoveryId: `room-recovery:${entry.generation}`,
      scope: entry.room.scope,
    };
    for (const pending of recovery.state.pending) {
      const intentId = pending?.intent?.intentId;
      if (
        typeof intentId !== 'string' ||
        typeof pending.actorId !== 'string' ||
        !recovery.armedIntentIds.has(intentId) ||
        !isLiveCapability(pending.capability)
      )
        return undefined;
      const authority = recovery.authorities.get(pending.intent.requestId);
      if (!authority || actorIdFor(authority.principal) !== pending.actorId)
        return undefined;
      entry.authorities.set(pending.intent.requestId, authority);
      this.#activeLiveRecovery.add(pending.intent.requestId);
      let outcome: LiveWorkMutationOutcome;
      try {
        outcome = await entry.room.recoverAsync(intentId, authorization, now);
      } finally {
        this.#activeLiveRecovery.delete(pending.intent.requestId);
      }
      if (outcome.outcome === 'unavailable') return undefined;
      if (outcome.outcome === 'updated' || outcome.outcome === 'departed')
        this.#releaseTtlAuthority(entry, pending.actorId);
      reconciled = true;
    }
    return reconciled;
  }

  /** Recovery settles durable effects only; a restart begins a new live room. */
  async #recoverPending(document: {
    projectId: string;
    taskId: string;
    documentId: string;
  }) {
    const key = documentKey(document);
    const existing = this.#recovery.get(key);
    if (existing) return existing;
    const recovery = this.#restorePending(document);
    this.#recovery.set(key, recovery);
    return recovery;
  }
  async #restorePending(document: {
    projectId: string;
    taskId: string;
    documentId: string;
  }): Promise<boolean> {
    try {
      const stored = await this.#deps.working.readRecovery({ scope: document });
      if (this.#closed) return false;
      if (stored.kind === 'unavailable') return true;
      const persisted = parsePersistedRecovery(stored.value);
      if (!persisted) return false;
      const state = persisted.state;
      const unarmedLifecycleIds = new Set(
        state.pending
          .filter(
            (pending) => !persisted.armedIntentIds.has(pending.intent.intentId),
          )
          .map((pending) => pending.lifecycleId)
          .filter(
            (lifecycleId): lifecycleId is string => lifecycleId !== undefined,
          ),
      );
      if (unarmedLifecycleIds.size) {
        // A prepared block never crossed the post-reauthorization arm
        // boundary. Discard only that lifecycle block; an earlier participant
        // may already have an armed announce/closure that must still replay.
        const retained = discardUnarmedRecoveryBlocks(
          state,
          unarmedLifecycleIds,
        );
        const cleared = await this.#deps.working.recovery({
          scope: document,
          generation: stored.generation,
          value: persistedRecoveryValue(
            retained,
            persisted.authorities,
            retained.pending.map((pending) => pending.intent.intentId),
          ),
        });
        // Re-enter once against the reduced durable state so retained armed
        // blocks settle in this restart rather than waiting for another one.
        return (
          cleared === 'stored' &&
          !this.#closed &&
          (await this.#restorePending(document))
        );
      }
      if (
        state.pending.some((pending) => {
          const authority = persisted.authorities.get(pending.intent.requestId);
          return (
            !authority || actorIdFor(authority.principal) !== pending.actorId
          );
        })
      )
        return false;
      const recoveryScope = state?.scope;
      // The recovery row belongs to one Project/Task/document and generation.
      // Never let a syntactically valid image from another row reissue its
      // material intents through this room authority.
      if (
        !recoveryScope ||
        recoveryScope.projectId !== document.projectId ||
        recoveryScope.taskId !== document.taskId ||
        recoveryScope.surfaceId !== document.documentId ||
        recoveryScope.sessionId !== stored.generation ||
        recoveryScope.channelId !== `room:${document.documentId}`
      )
        return false;
      const authorization: LiveWorkRecoveryAuthorization = {
        kind: 'system',
        recoveryId: `room-recovery:${stored.generation}`,
        scope: recoveryScope,
      };
      const now = Date.now();
      const ports = {
        history: new ProjectTaskLiveWorkHistoryAdapter(this.#history, {
          issue: async ({ capability, requestId }) => {
            const authority = persisted.authorities.get(requestId);
            const grant = authority
              ? this.#issueSystemLiveMaterial(
                  document.taskId,
                  authority,
                  capability,
                )
              : undefined;
            return grant
              ? { kind: 'granted', grant }
              : ({ kind: 'denied' } as const);
          },
        }),
      };
      // Settling an announce recreates its dormant TTL closure. Rehydrate that
      // one derived recovery generation as well, so a hard exit after the
      // durable start cannot strand it until another restart.
      let recoveryState = state;
      let corrected: ReturnType<LiveWorkSession['exportRecovery']> | undefined;
      for (let generation = 0; generation < 2; generation += 1) {
        const restored = LiveWorkSession.restore(
          recoveryScope,
          recoveryState,
          authorization,
          now,
          {},
          ports,
          { recoveryAuthority: { authorize: () => true } },
        );
        if (restored.outcome !== 'available' || this.#closed) return false;
        for (const pending of recoveryState.pending) {
          const outcome = await restored.session.recoverAsync(
            pending.intent.intentId,
            authorization,
            now,
          );
          if (this.#closed || outcome.outcome === 'unavailable') return false;
        }
        corrected = restored.session.exportRecovery(authorization, now);
        if (corrected.outcome !== 'available' || this.#closed) return false;
        if (!corrected.state.pending.length) break;
        recoveryState = corrected.state;
      }
      if (corrected?.outcome !== 'available') return false;
      const storedRecovery = await this.#deps.working.recovery({
        scope: document,
        generation: stored.generation,
        value: persistedRecoveryValue(corrected.state, persisted.authorities),
      });
      if (storedRecovery !== 'stored' || this.#closed) return false;
      return true;
    } catch {
      return false;
    }
  }

  async #publishWorkingChanges() {
    for (const [key, subscribers] of this.#subscribers) {
      const [projectId, taskId, documentId] = key.split('\u0000');
      const scope = {
        projectId: projectId!,
        taskId: taskId!,
        documentId: documentId!,
      };
      const projection = await this.#deps.working.read({ scope });
      for (const subscriber of [...subscribers]) {
        // Every externally-observed update is reauthorized at delivery time.
        if (!(await this.#subscriberAuthorized(scope, subscriber.request))) {
          this.#deliver(subscriber, { type: 'terminal' });
          subscribers.delete(subscriber);
          continue;
        }
        this.#deliver(subscriber, { type: 'document', ...projection });
      }
      // The working-state watch samples SQLite data_version. A remote
      // EventStore process can therefore wake this worker for a durable room
      // history append even when its document projection is unchanged. Replay
      // the bounded history through the normal authority seam in that case.
      await this.#publishHistory(scope);
      if (!subscribers.size) this.#subscribers.delete(key);
    }
    if (!this.#subscribers.size) {
      this.#unwatchWorking?.();
      this.#unwatchWorking = undefined;
    }
  }

  #scope(taskId: string): ProjectTaskRoomScope | undefined {
    const task = this.#deps.taskGraph.readTaskView(taskId);
    if (!task) return undefined;
    const project = this.#deps.projectForId(task.projectId);
    return project?.id === task.projectId
      ? { projectId: project.id, projectSlug: project.slug, taskId: task.id }
      : undefined;
  }
  /** One policy epoch is shared by every human, device, and agent in a room. */
  #roomPolicyRevision(scope: ProjectTaskRoomScope): string {
    return `${PROJECT_TASK_ROOM_POLICY_REVISION}:${scope.projectId}:${scope.taskId}`;
  }
  async #authorizedDocument(taskId: string, request: Request) {
    return (await this.#authorizedDocumentWithPrincipal(taskId, request))
      ?.document;
  }
  /**
   * A content delivery needs both the exact current document scope and its
   * principal. Resolve them once: running the same paired-request authority
   * twice serially turns one required recheck into avoidable delivery latency.
   */
  async #authorizedDocumentWithPrincipal(taskId: string, request: Request) {
    if (this.#closed || this.#deps.hosted?.() || !this.#scope(taskId))
      return undefined;
    const principal = await this.#principal(request);
    if (!principal) return undefined;
    const scope = this.#scope(taskId)!;
    return {
      document: {
        projectId: scope.projectId,
        taskId: scope.taskId,
        documentId: documentIdFor(scope),
      },
      principal,
    };
  }
  async #sameAuthorizedDocument(
    taskId: string,
    request: Request,
    expectedDocument: { projectId: string; taskId: string; documentId: string },
    expectedPrincipal: RequestPrincipal,
  ) {
    const [document, principal] = await Promise.all([
      this.#authorizedDocument(taskId, request),
      this.#principal(request),
    ]);
    return Boolean(
      document &&
        principal &&
        sameDocument(document, expectedDocument) &&
        samePrincipal(principal, expectedPrincipal),
    );
  }
  async #principal(request: Request): Promise<RequestPrincipal | undefined> {
    try {
      const result = await this.#deps.requestAuthority.resolve(request);
      return result.kind === 'granted' ? result : undefined;
    } catch {
      return undefined;
    }
  }
  async #resolveGrant(
    grant: ProjectTaskRoomGrant<ProjectTaskRoomGrantKind>,
    required: ProjectTaskRoomGrantKind,
  ): Promise<ProjectTaskRoomCapabilityResolution> {
    const issued = this.#issued.get(grant.opaqueToken);
    if (
      !issued ||
      issued.capability !== required ||
      grant.capability !== required
    )
      return { kind: 'denied' };
    const currentScope = this.#scope(issued.scope.taskId);
    if (issued.principal.kind === 'agent') {
      const task = this.#deps.taskGraph.readTaskView(issued.scope.taskId);
      if (
        !currentScope ||
        !task ||
        !sameScope(currentScope, issued.scope) ||
        issued.receiptId !== issued.principal.authorizationReceiptId ||
        task.agentId !== issued.principal.agentId ||
        task.createdBy !== issued.principal.ownerOperatorId ||
        task.sessionId !== agentSessionId(issued.principal)
      )
        return { kind: 'revoked' };
      return {
        kind: 'granted',
        receipt: {
          receiptId: issued.receiptId,
          capability: required,
          scope: currentScope,
          principal: issued.principal,
          policyRevision: this.#roomPolicyRevision(currentScope),
        },
      };
    }
    // A live-material authority is minted from the immutable principal/scope/
    // policy snapshot immediately before the effect. It deliberately carries
    // no Request (and therefore no bearer credential) across async recovery.
    if (issued.material) {
      if (!currentScope || !sameScope(currentScope, issued.scope))
        return { kind: 'revoked' };
      const principal = issued.principal as RequestPrincipal;
      return {
        kind: 'granted',
        receipt: {
          receiptId: issued.receiptId,
          capability: required,
          scope: currentScope,
          principal: {
            kind: 'operator',
            operatorId: principal.operatorId,
            deviceId: principal.deviceId,
          },
          policyRevision: this.#roomPolicyRevision(currentScope),
        },
      };
    }
    if (!issued.request) return { kind: 'revoked' };
    const currentPrincipal = await this.#principal(issued.request);
    if (
      !currentScope ||
      !currentPrincipal ||
      !sameScope(currentScope, issued.scope) ||
      !samePrincipal(currentPrincipal, issued.principal)
    )
      return { kind: 'revoked' };
    return {
      kind: 'granted',
      receipt: {
        receiptId: issued.receiptId,
        capability: required,
        scope: currentScope,
        principal: {
          kind: 'operator',
          operatorId: currentPrincipal.operatorId,
          deviceId: currentPrincipal.deviceId,
        },
        policyRevision: this.#roomPolicyRevision(currentScope),
      },
    };
  }
  #mapOpen(
    result: ProjectTaskRoomOpenOutcome,
  ): ProjectTaskRoomRuntimeOutcome<ProjectTaskRoomOpenOutcome> {
    return result.kind === 'denied' || result.kind === 'not-found'
      ? { kind: 'not-found' }
      : result;
  }
}
const documentIdFor = projectTaskRoomDocumentId;
function documentKey(scope: {
  projectId: string;
  taskId: string;
  documentId: string;
}) {
  return `${scope.projectId}\u0000${scope.taskId}\u0000${scope.documentId}`;
}

function isDocumentNotification(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === 'document'
  );
}
function sameScope(a: ProjectTaskRoomScope, b: ProjectTaskRoomScope) {
  return (
    a.projectId === b.projectId &&
    a.projectSlug === b.projectSlug &&
    a.taskId === b.taskId
  );
}
function samePrincipal(a: RequestPrincipal, b: RequestPrincipal) {
  return (
    a.operatorId === b.operatorId &&
    a.deviceId === b.deviceId &&
    a.policyRevision === b.policyRevision
  );
}
function sameDocument(
  a: { projectId: string; taskId: string; documentId: string },
  b: { projectId: string; taskId: string; documentId: string },
) {
  return (
    a.projectId === b.projectId &&
    a.taskId === b.taskId &&
    a.documentId === b.documentId
  );
}
/** A live actor is a paired-device identity, never the first room caller. */
function actorIdFor(principal: RequestPrincipal) {
  return `human:${createHash('sha256')
    .update(`${principal.operatorId}\u0000${principal.deviceId}`)
    .digest('hex')}`;
}

function agentSessionId(
  principal: Extract<ProjectTaskRoomPrincipal, { kind: 'agent' }>,
) {
  const prefix = 'agent-session:';
  return principal.deviceId.startsWith(prefix)
    ? principal.deviceId.slice(prefix.length)
    : undefined;
}

function isLiveCapability(value: unknown): value is LiveWorkCapability {
  return (
    value === 'join' ||
    value === 'read' ||
    value === 'write' ||
    value === 'watch' ||
    value === 'follow' ||
    value === 'announce' ||
    value === 'history-read'
  );
}

function persistedRecoveryValue(
  state: LiveWorkRecoveryState,
  authorities: ReadonlyMap<string, LiveMaterialAuthority>,
  armedIntentIds = state.pending.map((pending) => pending.intent.intentId),
): PersistedLiveRoomRecovery {
  return {
    schemaVersion: 'station.project-task-room-runtime-recovery/v1',
    state,
    armedIntentIds: [...armedIntentIds],
    authorities: [...authorities.entries()].map(([token, authority]) => ({
      token,
      principal: authority.principal,
    })),
  };
}

function parsePersistedRecovery(value: unknown):
  | {
      readonly state: LiveWorkRecoveryState;
      readonly authorities: ReadonlyMap<string, LiveMaterialAuthority>;
      readonly armedIntentIds: ReadonlySet<string>;
    }
  | undefined {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'state',
      'armedIntentIds',
      'authorities',
    ]) ||
    value.schemaVersion !== 'station.project-task-room-runtime-recovery/v1' ||
    !plainRecord(value.state) ||
    value.state.schemaVersion !== LIVE_WORK_RECOVERY_SCHEMA_VERSION ||
    !Array.isArray(value.armedIntentIds) ||
    value.armedIntentIds.length > 256 ||
    !value.armedIntentIds.every((intentId) => boundedId(intentId)) ||
    new Set(value.armedIntentIds).size !== value.armedIntentIds.length ||
    !Array.isArray(value.authorities) ||
    value.authorities.length > 256
  )
    return undefined;
  const authorities = new Map<string, LiveMaterialAuthority>();
  for (const item of value.authorities) {
    if (
      !plainRecord(item) ||
      !exactKeys(item, ['token', 'principal']) ||
      !boundedId(item.token) ||
      !plainRecord(item.principal) ||
      !exactKeys(item.principal, [
        'kind',
        'operatorId',
        'deviceId',
        'policyRevision',
      ]) ||
      item.principal.kind !== 'granted' ||
      !boundedId(item.principal.operatorId) ||
      !boundedId(item.principal.deviceId) ||
      !boundedId(item.principal.policyRevision) ||
      authorities.has(item.token)
    )
      return undefined;
    authorities.set(item.token, {
      principal: {
        kind: 'granted',
        operatorId: item.principal.operatorId,
        deviceId: item.principal.deviceId,
        policyRevision: item.principal.policyRevision,
      },
    });
  }
  return {
    state: value.state as unknown as LiveWorkRecoveryState,
    authorities,
    armedIntentIds: new Set(value.armedIntentIds),
  };
}

function discardUnarmedRecoveryBlocks(
  state: LiveWorkRecoveryState,
  lifecycleIds: ReadonlySet<string>,
): LiveWorkRecoveryState {
  return {
    ...state,
    pending: state.pending.filter(
      (pending) =>
        !pending.lifecycleId || !lifecycleIds.has(pending.lifecycleId),
    ),
    lifecycles: state.lifecycles.filter(
      (lifecycle) => !lifecycleIds.has(lifecycle.announcementId),
    ),
    terminal: state.terminal.filter(
      (terminal) =>
        !terminal.lifecycleId || !lifecycleIds.has(terminal.lifecycleId),
    ),
    replay: state.replay.filter((event) => !lifecycleIds.has(event.intentId)),
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}
function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function parsePendingAgentLifecycle(
  value: unknown,
): PendingAgentLifecycle | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<PendingAgentLifecycle>;
  return typeof candidate.taskId === 'string' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.provider === 'string' &&
    typeof candidate.dispatchId === 'string' &&
    typeof candidate.occurredAt === 'string' &&
    typeof candidate.authorizationReceiptId === 'string' &&
    (candidate.outcome === 'started' ||
      candidate.outcome === 'completed' ||
      candidate.outcome === 'failed' ||
      candidate.outcome === 'cancelled')
    ? (candidate as PendingAgentLifecycle)
    : undefined;
}

function agentLifecycleReceiptId(
  taskId: string,
  sessionId: string,
  outcome: PendingAgentLifecycle['outcome'],
) {
  return `agent-room:${createHash('sha256')
    .update(`${taskId}\u0000${sessionId}\u0000${outcome}`)
    .digest('hex')}`;
}

function agentActorId(taskId: string, agentId: string, sessionId: string) {
  return `agent:${createHash('sha256')
    .update(`${taskId}\u0000${agentId}\u0000${sessionId}`)
    .digest('hex')}`;
}

function requestReceiptId(
  scope: ProjectTaskRoomScope,
  principal: RequestPrincipal,
  capability: RoomCapability,
) {
  return `room-request:${createHash('sha256')
    .update(
      `${scope.projectId}\u0000${scope.taskId}\u0000${principal.operatorId}\u0000${principal.deviceId}\u0000${principal.policyRevision}\u0000${capability}`,
    )
    .digest('hex')}`;
}

function participantDisplayLabel(principal: RequestPrincipal) {
  return `Participant ${actorIdFor(principal).slice(-12)}`;
}

/**
 * Browser history is a deliberately smaller DTO than the durable record.
 * Grant receipts, device/operator identities, policy revisions, and scope
 * only exist inside the history worker's verified record.
 */
function projectHistory(value: any): unknown {
  if (value?.kind === 'available') {
    return {
      kind: 'available',
      records: value.records.map((record: any) => ({
        actor: {
          kind: record.principal.kind === 'agent' ? 'agent' : 'human',
          label:
            record.principal.kind === 'agent'
              ? `Agent ${record.principal.agentId}`
              : `Participant ${createHash('sha256')
                  .update(
                    `${record.principal.operatorId}\u0000${record.principal.deviceId}`,
                  )
                  .digest('hex')
                  .slice(-12)}`,
        },
        sequence: record.envelope.seq,
        body: projectBody(record.body),
        digests: {
          proposal: record.envelope.proposalDigest,
          checkpoint: record.checkpointDigest,
        },
        integrity: 'L0',
      })),
      checkpoint: projectCheckpoint(value.checkpoint),
      hasMore: value.hasMore === true,
      ...(value.nextCursor
        ? { nextCursor: encodeCursor(value.nextCursor) }
        : {}),
      integrity: 'L0',
    };
  }
  if (value?.kind === 'gap')
    return {
      kind: 'gap',
      missingThroughSeq: value.missingThroughSeq,
      checkpoint: projectCheckpoint(value.checkpoint),
      resumeCursor: encodeCursor(value.resumeCursor),
    };
  if (value?.kind === 'stale')
    return {
      kind: 'stale',
      ...(value.checkpoint
        ? { checkpoint: projectCheckpoint(value.checkpoint) }
        : {}),
    };
  return value;
}
function projectCheckpoint(value: any) {
  return {
    throughSeq: value.throughSeq,
    checkpointDigest: value.checkpointDigest,
    retainedAnchorSeq: value.retainedAnchorSeq,
    retainedAnchorDigest: value.retainedAnchorDigest,
  };
}
function projectBody(value: any): unknown {
  if (value?.kind === 'human-message')
    return { kind: value.kind, text: value.text };
  if (value?.kind === 'live-work-started')
    return {
      kind: value.kind,
      sessionId: value.sessionId,
      ...(value.run ? { run: projectLink(value.run) } : {}),
    };
  if (value?.kind === 'live-work-presence-ended')
    return {
      kind: value.kind,
      sessionId: value.sessionId,
      reason: value.reason,
      ...(value.run ? { run: projectLink(value.run) } : {}),
    };
  if (value?.kind === 'live-work-finished')
    return {
      kind: value.kind,
      sessionId: value.sessionId,
      outcome: value.outcome,
      ...(value.run ? { run: projectLink(value.run) } : {}),
      ...(value.revision ? { revision: projectLink(value.revision) } : {}),
      ...(value.outcomeLink
        ? { outcomeLink: projectLink(value.outcomeLink) }
        : {}),
    };
  return { kind: 'outcome-link', link: projectLink(value.link) };
}
function projectLink(value: any) {
  return { kind: value.kind, stableId: value.stableId, digest: value.digest };
}
function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
/** A policy revision is opaque; map it to the positive protocol epoch. */
function authorizationEpoch(policyRevision: string) {
  const value = createHash('sha256')
    .update(policyRevision)
    .digest()
    .readUInt32BE(0);
  return value === 0 ? 1 : value;
}
