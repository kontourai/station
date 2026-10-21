/**
 * How the runtime composes what an agent schedules for itself (wake-ups) and
 * proposes (scheduled jobs): the person behind a UI request, the fire-time
 * scope decision, the delivery onto the conversation's inbox, the routes and
 * the scheduler's proposal approval. Kept out of `runtime-routes.ts` so the
 * production wiring itself is what the authority tests drive.
 */
import type { ConversationUsageLimitResume } from '@kontourai/station-contracts/agent-schedule';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { Context } from 'hono';
import type { JobProposalApproval } from '../../routes/operations/scheduler.js';
import {
  type AgentScheduleActor,
  type AgentSchedulePerson,
  type AgentScheduleRoutesDeps,
  createJobProposalApproval,
} from '../../routes/orchestration/agent-schedule.js';
import {
  type AgentScheduleStore,
  AgentWakeUpDelivery,
  type WakeUpRecord,
} from '../../services/orchestration/agent-schedule.js';
import type { SessionReadScope } from '../../services/orchestration/orchestration-service.js';
import type { ThreadInboxDelivery } from '../../services/orchestration/thread-inbox.js';
import { stationControlScopeRefusal } from '../../tools/station-control-policy.js';
import type {
  StationControlDispatchScope,
  StationControlResolvedDispatchTarget,
} from '../mcp/station-control-dispatch-scope.js';

/** The orchestration reads the composition needs, and nothing else. */
export interface AgentScheduleOrchestrationReads {
  canUserReadConversation(
    conversationId: string,
    authority: SessionReadScope,
  ): boolean;
  canUserMutateSession(
    threadId: string,
    userId: string | undefined,
    tenant: TenantExecutionContext | undefined,
  ): boolean;
  currentConversationSessionId(conversationId: string): string;
  readUsageLimitRecovery(threadId: string): Promise<
    | {
        readonly outcome: string;
        readonly dueAt?: string;
        readonly autoResume?: boolean;
      }
    | null
    | undefined
  >;
}

export interface AgentScheduleCompositionDeps {
  readonly store: AgentScheduleStore | undefined;
  /** Absent (hosted, or it could not start): check-backs are unavailable. */
  readonly threadInbox: Pick<ThreadInboxDelivery, 'submit'> | undefined;
  readonly scope: StationControlDispatchScope | undefined;
  readonly orchestration: AgentScheduleOrchestrationReads;
  /** A hosted Station: no scheduler, so no proposals. */
  readonly hosted: boolean;
  isInternalRequest(request: Request): boolean;
  /** The request's principal is current (not revoked or signed out). */
  isRequestPrincipalCurrent(request: Request): boolean;
  /** The person's user id for a current UI request. */
  requestUserId(c: Context): string;
  readAuthorityFor(c: Context, userId: string): SessionReadScope;
  tenantFor(c: Context): TenantExecutionContext | undefined;
  /** Who a dispatch from this request would act as (`resolveDispatchActor`). */
  dispatchActor(c: Context): AgentScheduleActor;
  /** The Project an Agent belongs to (`undefined`: global); throws when none. */
  agentProject(agentSlug: string): Promise<string | undefined>;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  now?: () => number;
}

/** The conversation a recorded wake-up belongs to; the guard's read. */
export function agentWakeUpConversation(
  store: AgentScheduleStore | undefined,
  wakeUpId: string,
): string | undefined {
  return store?.wakeUp(wakeUpId)?.conversationId;
}

export interface AgentScheduleComposition {
  /** What `createAgentScheduleRoutes` is mounted with. */
  readonly routeDeps: AgentScheduleRoutesDeps;
  readonly jobProposals: JobProposalApproval;
  readonly delivery: AgentWakeUpDelivery | undefined;
  /** For the guard's `wake-up-stays-in-own-conversation` rule. */
  wakeUpConversation(wakeUpId: string): string | undefined;
  person(c: Context): AgentSchedulePerson | undefined;
}

/**
 * The scope rule decided again when a wake-up fires, for the conversation
 * as it is now and the caller as it was recorded. A person's approval
 * answers the `host` refusal it was approved for; anything else refuses.
 */
export function admitWakeUpAtFire(
  scope: StationControlDispatchScope | undefined,
  record: WakeUpRecord,
): boolean {
  if (!record.caller) return false;
  const refusal = stationControlScopeRefusal(
    record.caller,
    scope?.target({
      kind: 'conversation',
      conversationId: record.conversationId,
      remote: false,
    }),
  );
  if (!refusal) return true;
  return refusal.reason === 'host' && record.approvedBy !== undefined;
}

export function composeAgentSchedule(
  deps: AgentScheduleCompositionDeps,
): AgentScheduleComposition {
  const person = (c: Context): AgentSchedulePerson | undefined => {
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return undefined;
    const userId = deps.requestUserId(c);
    const readAuthority = deps.readAuthorityFor(c, userId);
    const tenant = deps.tenantFor(c);
    const service = deps.orchestration;
    return {
      userId,
      // The conversation, not one Session of it: every Session of its
      // lineage must be readable.
      mayRead: (conversationId) =>
        service.canUserReadConversation(conversationId, readAuthority),
      mayMutate: (conversationId) =>
        service.canUserMutateSession(
          service.currentConversationSessionId(conversationId),
          userId,
          tenant,
        ),
    };
  };
  const inbox = deps.threadInbox;
  const delivery =
    inbox && deps.store
      ? new AgentWakeUpDelivery({
          store: deps.store,
          admit: (record) => admitWakeUpAtFire(deps.scope, record),
          submit: (input) => inbox.submit(input),
          logger: deps.logger,
          ...(deps.now ? { now: deps.now } : {}),
        })
      : undefined;
  const jobAgentTarget = async (
    agentSlug: string,
    ownerId: string | undefined,
  ): Promise<StationControlResolvedDispatchTarget | undefined> => {
    if (ownerId === undefined) return undefined;
    const project = await deps.agentProject(agentSlug);
    if (project === undefined)
      return { ownerId, scope: { kind: 'global' }, host: false, remote: false };
    return deps.scope?.target({
      kind: 'new',
      ownerId,
      projectSlug: project,
      remote: false,
    });
  };
  const routeDeps: AgentScheduleRoutesDeps = {
    isInternalRequest: deps.isInternalRequest,
    scope: deps.scope,
    store: deps.store,
    delivery,
    dispatchActor: deps.dispatchActor,
    person,
    jobAgentTarget,
    hosted: deps.hosted,
    // The conversation's current Session's stop, when it waits for a known
    // reset; the same projection the usage-limit banner reads.
    usageLimitResume: async (
      conversationId,
    ): Promise<ConversationUsageLimitResume | undefined> => {
      const threadId =
        deps.orchestration.currentConversationSessionId(conversationId);
      const recovery =
        await deps.orchestration.readUsageLimitRecovery(threadId);
      return recovery?.outcome === 'armed' && recovery.dueAt
        ? {
            threadId,
            dueAt: recovery.dueAt,
            autoResume: recovery.autoResume === true,
          }
        : undefined;
    },
    ...(deps.now ? { now: deps.now } : {}),
  };
  return {
    routeDeps,
    delivery,
    person,
    jobProposals: createJobProposalApproval({
      store: deps.hosted ? undefined : deps.store,
      person,
      ...(deps.now ? { now: deps.now } : {}),
    }),
    wakeUpConversation: (wakeUpId) =>
      agentWakeUpConversation(deps.store, wakeUpId),
  };
}
