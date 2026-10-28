/**
 * How the runtime composes what an agent schedules for itself (wake-ups) and
 * proposes (scheduled jobs): the person behind a UI request, the fire-time
 * scope decision, the delivery onto the conversation's inbox, the routes and
 * the scheduler's proposal approval. Kept out of `runtime-routes.ts` so the
 * production wiring itself is what the authority tests drive.
 */
import type {
  ConversationAutomation,
  ConversationUsageLimitResume,
} from '@kontourai/station-contracts/agent-schedule';
import type { RunSummary } from '@kontourai/station-contracts/runs';
import type {
  SchedulerAutomationTarget,
  SchedulerJob,
  SchedulerLogEntry,
} from '@kontourai/station-contracts/scheduler';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { Context } from 'hono';
import type {
  AutomationJobAdmission,
  AutomationTargetAdmission,
  JobProposalApproval,
} from '../../routes/operations/scheduler.js';
import {
  type AgentScheduleActor,
  type AgentSchedulePerson,
  type AgentScheduleRoutesDeps,
  createJobProposalApproval,
} from '../../routes/orchestration/agent-schedule.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
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
  /**
   * The automations whose runs land in a conversation. Absent (hosted, no
   * scheduler): the chat's schedule lists none.
   */
  conversationAutomations?(
    conversationId: string,
  ): Promise<readonly ConversationAutomation[]>;
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
  /** The scheduler create/edit routes' rule for a job `target`. */
  readonly admitAutomationTarget: AutomationTargetAdmission;
  /** The scheduler routes' rule for acting on a job with a stored target. */
  readonly admitAutomationJob: AutomationJobAdmission;
  readonly mayReadAutomationRun: (
    c: Context,
    job: SchedulerJob,
    run: Pick<SchedulerLogEntry, 'jobId' | 'runTarget'>,
  ) => boolean;
  readonly mayReadAutomationJob: (
    c: Context,
    job: import('@kontourai/station-contracts/scheduler').SchedulerJob,
  ) => boolean;
  scheduleRunReadFilter(
    c: Context,
    jobs: readonly SchedulerJob[],
  ): (run: RunSummary) => boolean;
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

const TARGET_OUT_OF_SCOPE = {
  ok: false,
  status: 403,
  code: 'automation_target_out_of_scope',
  error: 'An agent may only run an automation in its own conversation.',
} as const;

/**
 * Who may point an automation at a conversation, and as whom its runs act.
 *
 * - An agent's request (Station's internal principal): only its own
 *   conversation, and its runs act as the agent's dispatch actor (its user,
 *   owner attribution and principal), never stronger. A dedicated
 *   conversation is a person's choice. The guard's
 *   `automation-target-stays-in-own-conversation` rule refuses the same
 *   first; this repeats it at the route.
 * - A person: one who may send to the conversation now, the same rule the
 *   inbox applies again when each run is placed. Its runs act as the person.
 */
function admitAutomationTargetFor(
  deps: Pick<AgentScheduleCompositionDeps, 'dispatchActor'>,
  person: (c: Context) => AgentSchedulePerson | undefined,
): AutomationTargetAdmission {
  return (c, target: SchedulerAutomationTarget) => {
    if (requestMayBeAnAgent(c.req.raw)) {
      const authority = stationControlRequestAuthority(c.req.raw);
      if (authority?.kind !== 'caller') return TARGET_OUT_OF_SCOPE;
      const own = authority.caller.conversationId ?? authority.caller.sessionId;
      if (target.kind !== 'conversation' || target.conversationId !== own)
        return TARGET_OUT_OF_SCOPE;
      const actor = deps.dispatchActor(c);
      return {
        ok: true,
        createdBy: {
          userId: actor.userId,
          ...(actor.principal ? { principal: actor.principal } : {}),
          ...(actor.ownerAttribution
            ? { ownerAttribution: actor.ownerAttribution }
            : {}),
        },
      };
    }
    const requester = person(c);
    if (!requester)
      return {
        ok: false,
        status: 403,
        code: 'automation_target_person_required',
        error: 'Sign in again to choose where this automation runs.',
      };
    if (
      target.kind === 'conversation' &&
      !requester.mayMutate(target.conversationId)
    )
      return {
        ok: false,
        status: 404,
        code: 'automation_target_not_found',
        error: 'Conversation not found.',
      };
    return { ok: true, createdBy: { userId: requester.userId } };
  };
}

/**
 * Who may edit, run, enable, disable or delete an existing automation that
 * targets a conversation, decided on its STORED target: its runs act as the
 * stored creator there, so a change by anyone who could not send to that
 * conversation would put words in someone else's chat.
 *
 * - An agent: only an automation targeting its own conversation (never a
 *   dedicated one, which is a person's).
 * - A person: one who may send to the target conversation now; for a
 *   dedicated target whose conversation has not started yet, only its
 *   creator.
 */
function admitAutomationJobFor(
  person: (c: Context) => AgentSchedulePerson | undefined,
): AutomationJobAdmission {
  return (c, job) => {
    const conversationId = job.target?.conversationId;
    if (requestMayBeAnAgent(c.req.raw)) {
      const authority = stationControlRequestAuthority(c.req.raw);
      if (authority?.kind !== 'caller') return TARGET_OUT_OF_SCOPE;
      const own = authority.caller.conversationId ?? authority.caller.sessionId;
      return job.target?.kind === 'conversation' && conversationId === own
        ? { ok: true }
        : TARGET_OUT_OF_SCOPE;
    }
    const requester = person(c);
    if (!requester)
      return {
        ok: false,
        status: 403,
        code: 'automation_target_person_required',
        error: 'Sign in again to change this automation.',
      };
    const allowed =
      conversationId !== undefined
        ? requester.mayMutate(conversationId)
        : requester.userId === job.createdBy?.userId;
    return allowed
      ? { ok: true }
      : {
          ok: false,
          status: 404,
          code: 'automation_not_found',
          error: 'Automation not found.',
        };
  };
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
  // Approves a restart cut short are open again, with or without an inbox.
  // Synchronous, before any route is served, and bounded by this start
  // time, so it can never undo an Approve this process claimed.
  if (deps.store) {
    const startedAt = deps.now?.() ?? Date.now();
    try {
      const reopened = deps.store.reopenInterruptedApprovals(
        startedAt,
        startedAt,
      );
      if (reopened > 0)
        deps.logger.warn('reopened job proposals a restart left approving', {
          count: reopened,
        });
    } catch (error) {
      deps.logger.warn('could not reopen interrupted job proposal approvals', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
    ...(deps.conversationAutomations
      ? { conversationAutomations: deps.conversationAutomations }
      : {}),
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
  const composition: AgentScheduleComposition = {
    routeDeps,
    delivery,
    person,
    admitAutomationTarget: admitAutomationTargetFor(deps, person),
    admitAutomationJob: admitAutomationJobFor(person),
    mayReadAutomationJob: (c, job) => {
      if (requestMayBeAnAgent(c.req.raw)) {
        const authority = stationControlRequestAuthority(c.req.raw);
        if (authority?.kind !== 'caller') return false;
        const own =
          authority.caller.conversationId ?? authority.caller.sessionId;
        return (
          !!job.target?.conversationId && job.target.conversationId === own
        );
      }
      const requester = person(c);
      if (!requester) return false;
      if (!job.target) return true;
      return job.target.conversationId
        ? requester.mayRead(job.target.conversationId)
        : requester.userId === job.createdBy?.userId;
    },
    mayReadAutomationRun: (c, job, run) => {
      if (run.jobId && run.jobId !== job.unattendedPrincipal?.jobId)
        return false;
      const isAgent = requestMayBeAnAgent(c.req.raw);
      const requester = isAgent ? undefined : person(c);
      if (run.runTarget === undefined) {
        return (
          !!requester &&
          requester.userId === job.createdBy?.userId &&
          (!job.target ||
            (job.target.conversationId
              ? requester.mayRead(job.target.conversationId)
              : requester.userId === job.createdBy?.userId))
        );
      }
      if (run.runTarget === null) return !!requester;
      const target = run.runTarget;
      if (target.kind !== 'conversation' && target.kind !== 'dedicated')
        return false;
      if (isAgent) {
        const authority = stationControlRequestAuthority(c.req.raw);
        return (
          authority?.kind === 'caller' &&
          !!target.conversationId &&
          target.conversationId ===
            (authority.caller.conversationId ?? authority.caller.sessionId)
        );
      }
      return (
        !!requester &&
        (target.conversationId
          ? requester.mayRead(target.conversationId)
          : requester.userId === job.createdBy?.userId)
      );
    },
    scheduleRunReadFilter: (c, jobs) => (run) =>
      jobs.some(
        (job) =>
          job.name === run.sourceId &&
          job.provider === run.providerId &&
          composition.mayReadAutomationRun(c, job, {
            jobId:
              typeof run.metadata?.jobId === 'string'
                ? run.metadata.jobId
                : undefined,
            runTarget: run.metadata?.runTarget as
              | SchedulerJob['target']
              | null
              | undefined,
          }),
      ),
    jobProposals: createJobProposalApproval({
      store: deps.hosted ? undefined : deps.store,
      person,
      logger: deps.logger,
      ...(deps.now ? { now: deps.now } : {}),
    }),
    wakeUpConversation: (wakeUpId) =>
      agentWakeUpConversation(deps.store, wakeUpId),
  };
  return composition;
}
