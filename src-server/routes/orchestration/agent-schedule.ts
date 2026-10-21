/**
 * The REST side of `schedule_wake_up`, `list_wake_ups`, `cancel_wake_up` and
 * `propose_job`, and the person's own reads and actions on them in the chat.
 * Mounted under `/api/orchestration`.
 *
 * Agent leaves (`/station-control/...`): only Station's own station-control
 * tool code calls them, so a request the runtime boundary did not accept as
 * Station's internal principal gets a 404. The conversation is the VERIFIED
 * caller's own, as the central authority guard bound it to the request; a
 * body never chooses it. The guard also refuses, before this route runs, a
 * body or a wake-up id that names another conversation
 * (`wake-up-stays-in-own-conversation`); this route checks the same again.
 *
 * Person leaves (`/agent-schedule/:conversationId/...`): no station-control
 * tool maps them, so the guard refuses an agent's internal token outright,
 * and each one refuses a request that may be an agent's besides. Approving a
 * job proposal is not here: the scheduler's own create route does it
 * (`routes/operations/scheduler.ts`), under the person's credential.
 *
 * A wake-up from a caller the scope rule refuses only because its session
 * runs unconfined (`host`) is not refused: it is recorded `needs_approval`
 * and the person approves or declines it here.
 */
import {
  AGENT_JOB_PROPOSAL_MAX_OPEN_PER_CONVERSATION,
  AGENT_SCHEDULE_RATE_WINDOW_MS,
  AGENT_WAKE_UP_MAX_CREATED_PER_WINDOW,
  AGENT_WAKE_UP_MAX_HORIZON_MS,
  AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION,
  AGENT_WAKE_UP_MIN_DELAY_MS,
  AGENT_WAKE_UP_NOTE_MAX_CHARS,
  type AgentJobProposalJob,
  type AgentJobProposalRefusalCode,
  type AgentWakeUpFailureCode,
  type AgentWakeUpRefusalCode,
  type AgentWakeUpState,
  CONVERSATION_SCHEDULED_JOBS_LIMIT,
  type ConversationAgentSchedule,
  type ConversationUsageLimitResume,
  jobMatchesProposal,
} from '@kontourai/station-contracts/agent-schedule';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import type {
  StationControlDispatchScope,
  StationControlResolvedDispatchTarget,
} from '../../runtime/mcp/station-control-dispatch-scope.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import {
  type AgentScheduleStore,
  type AgentWakeUpDelivery,
  publicJobProposal,
  publicWakeUp,
} from '../../services/orchestration/agent-schedule.js';
import type { StartOwnerAttribution } from '../../services/orchestration/session-owner-attribution.js';
import {
  type StationControlPolicyCaller,
  stationControlOutOfScopeRefusal,
  stationControlRefusal,
  stationControlRefusalBody,
  stationControlScopeRefusal,
} from '../../tools/station-control-policy.js';
import type { JobProposalApproval } from '../operations/scheduler.js';
import { addJobSchema } from '../schemas/schema-definitions/scheduler.js';

const MAX_BODY_BYTES = 16 * 1024;
const NO_STORE = { 'Cache-Control': 'no-store' };

/** Fixed copy an agent relays; each says what to do instead. */
export const WAKE_UP_REFUSAL_COPY: Record<AgentWakeUpRefusalCode, string> = {
  wake_up_too_soon: `Pick a time at least ${AGENT_WAKE_UP_MIN_DELAY_MS / 60_000} minute from now.`,
  wake_up_too_far: `Pick a time within ${AGENT_WAKE_UP_MAX_HORIZON_MS / 3_600_000} hours. For later or repeating work, use propose_job.`,
  wake_up_limit_reached: `This chat already has ${AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION} check-backs waiting. Cancel one first.`,
  wake_up_note_too_long: `Keep the note to ${AGENT_WAKE_UP_NOTE_MAX_CHARS} characters or fewer.`,
  wake_up_rate_limited: `This chat scheduled ${AGENT_WAKE_UP_MAX_CREATED_PER_WINDOW} check-backs in the last ${AGENT_SCHEDULE_RATE_WINDOW_MS / 3_600_000} hour. Try again later.`,
  wake_up_unavailable: "Check-backs aren't available on this Station.",
};

/**
 * Why an Approve found nothing to approve. `needs_approval` here means its
 * due time passed (approval is only taken before it); `failed` without
 * `not_approved` failed after an earlier approval.
 */
function settledWakeUpCopy(
  state: AgentWakeUpState,
  reasonCode: AgentWakeUpFailureCode | undefined,
): string {
  if (
    state === 'needs_approval' ||
    (state === 'failed' && reasonCode === 'not_approved')
  )
    return 'Its time has passed.';
  if (state === 'failed') return 'It already failed.';
  return `It was already ${state === 'pending' ? 'approved' : state}.`;
}

/** What the agent reads when its check-back waits for the person. */
export const WAKE_UP_NEEDS_APPROVAL_COPY =
  'Waiting for the person to approve it. It is sent only if they do before it is due.';

const JOB_PROPOSAL_REFUSAL_COPY: Record<
  Exclude<AgentJobProposalRefusalCode, 'job_proposal_invalid'>,
  string
> = {
  job_proposal_limit_reached: `This chat already has ${AGENT_JOB_PROPOSAL_MAX_OPEN_PER_CONVERSATION} job proposals waiting. Wait for the person to answer one.`,
  job_proposal_rate_limited:
    'This chat proposed too many jobs in the last hour. Try again later.',
  job_proposal_agent_out_of_scope:
    'That agent is outside this chat’s Project. Name an agent from this Project, or none.',
  job_proposal_unavailable: "Job proposals aren't available on this Station.",
};

const proposalRefusal = (
  c: Context,
  code: keyof typeof JOB_PROPOSAL_REFUSAL_COPY,
  status: 403 | 409 | 503,
) =>
  c.json(
    { success: false, code, error: JOB_PROPOSAL_REFUSAL_COPY[code] },
    status,
    NO_STORE,
  );

const wakeUpBodySchema = z
  .object({
    delayMs: z.number(),
    note: z.string().min(1),
    /** Optional, and only checked: a wake-up always goes to the caller's own conversation. */
    conversationId: z.string().min(1).optional(),
  })
  .strict();

/**
 * The job a proposal names: the scheduler's create body for an ordinary job.
 * What a person must choose themselves (trusting every tool, a provider, a
 * monitor) is not proposable; a body that carries it is refused.
 */
const jobProposalBodySchema = z
  .object({
    name: z.string(),
    schedule: z.unknown(),
    prompt: z.string(),
    agent: z.string().min(1).optional(),
    rationale: z.string().min(1).max(2000).optional(),
  })
  .strict();

export interface AgentScheduleActor {
  readonly userId: string;
  readonly principal?: PrincipalRef;
  readonly ownerAttribution?: StartOwnerAttribution;
}

export interface AgentSchedulePerson {
  readonly userId: string;
  /** Whether this person may read the conversation. */
  mayRead(conversationId: string): boolean;
  /** Whether this person may send to (and so act on) the conversation. */
  mayMutate(conversationId: string): boolean;
}

export interface AgentScheduleRoutesDeps {
  /** True only for Station's own internal principal. */
  isInternalRequest(request: Request): boolean;
  /** The scope rule's records; absent refuses every caller it constrains. */
  scope: StationControlDispatchScope | undefined;
  /** Absent: wake-ups and proposals are unavailable on this Station. */
  store: AgentScheduleStore | undefined;
  delivery: AgentWakeUpDelivery | undefined;
  /** Who a dispatch from this request would act as (`resolveDispatchActor`). */
  dispatchActor(c: Context): AgentScheduleActor;
  /** The person making a UI request, or undefined when it is not current. */
  person(c: Context): AgentSchedulePerson | undefined;
  /** A usage-limit stop in the conversation waiting for its reset, if any. */
  usageLimitResume?(
    conversationId: string,
  ): Promise<ConversationUsageLimitResume | undefined>;
  /**
   * The scope rule's target for the Agent a job proposal names, owned by
   * the caller's owner: its Project (or the global space). `undefined` when
   * Station cannot read the Agent, which refuses.
   */
  jobAgentTarget?(
    agentSlug: string,
    ownerId: string | undefined,
  ): Promise<StationControlResolvedDispatchTarget | undefined>;
  /**
   * A hosted Station: proposals are refused, since the scheduler that
   * would approve them is not offered there.
   */
  hosted?: boolean;
  now?: () => number;
}

async function readJson(request: Request): Promise<unknown> {
  const read = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (read.status !== 'ok') return undefined;
  try {
    return JSON.parse(read.body);
  } catch {
    return undefined;
  }
}

export function createAgentScheduleRoutes(deps: AgentScheduleRoutesDeps) {
  const app = new Hono();
  const now = () => deps.now?.() ?? Date.now();

  /** The verified caller's own conversation, or the response refusing it. */
  const callerOf = (
    c: Context,
  ):
    | {
        conversationId: string;
        sessionId: string;
        policy: StationControlPolicyCaller;
      }
    | { refused: Response } => {
    if (!deps.isInternalRequest(c.req.raw))
      return {
        refused: c.json({ error: { code: 'not_found' } }, 404, NO_STORE),
      };
    const authority = stationControlRequestAuthority(c.req.raw);
    if (authority?.kind !== 'caller')
      return {
        refused: c.json(
          stationControlRefusalBody(
            stationControlRefusal('station_control_caller_required'),
          ),
          403,
          NO_STORE,
        ),
      };
    const { caller } = authority;
    return {
      conversationId: caller.conversationId ?? caller.sessionId,
      sessionId: caller.sessionId,
      policy: caller,
    };
  };
  const otherConversation = (c: Context) =>
    c.json(
      stationControlRefusalBody(
        stationControlOutOfScopeRefusal('other-conversation'),
      ),
      403,
      NO_STORE,
    );
  const unavailable = (c: Context) =>
    c.json(
      {
        success: false,
        code: 'wake_up_unavailable',
        error: WAKE_UP_REFUSAL_COPY.wake_up_unavailable,
      },
      503,
      NO_STORE,
    );

  app.post('/station-control/wake-ups', async (c) => {
    const caller = callerOf(c);
    if ('refused' in caller) return caller.refused;
    // A wake-up sends a turn into the caller's own Session later, so it
    // answers the one scope rule a send answers. Owner decision 2026-10-20:
    // a caller refused only because its Session runs `host` (unconfined)
    // asks the person instead, who approves it with one click; any other
    // refusal stands.
    const refusal = stationControlScopeRefusal(
      caller.policy,
      deps.scope?.target({
        kind: 'thread',
        threadId: caller.sessionId,
        remote: false,
      }),
    );
    const needsApproval = refusal?.reason === 'host';
    if (refusal && !needsApproval)
      return c.json(stationControlRefusalBody(refusal), 403, NO_STORE);
    const parsed = wakeUpBodySchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success)
      return c.json(
        {
          success: false,
          error: 'schedule_wake_up needs minutes (a number) and a note.',
        },
        400,
        NO_STORE,
      );
    if (
      parsed.data.conversationId !== undefined &&
      parsed.data.conversationId !== caller.conversationId
    )
      return otherConversation(c);
    if (!deps.delivery) return unavailable(c);
    const actor = deps.dispatchActor(c);
    const result = deps.delivery.schedule({
      conversationId: caller.conversationId,
      sessionId: caller.sessionId,
      actor: {
        userId: actor.userId,
        // A dispatch from an agent always carries an attribution; one that
        // somehow does not replays as the weaker one.
        attribution: actor.ownerAttribution ?? 'unattributed-agent',
        ...(actor.principal ? { principal: actor.principal } : {}),
      },
      caller: caller.policy,
      note: parsed.data.note,
      delayMs: parsed.data.delayMs,
      needsApproval,
    });
    if (result.outcome === 'refused')
      return c.json(
        {
          success: false,
          code: result.code,
          error: WAKE_UP_REFUSAL_COPY[result.code],
        },
        result.code === 'wake_up_unavailable' ? 503 : 409,
        NO_STORE,
      );
    return c.json(
      {
        success: true,
        data: result.wakeUp,
        ...(needsApproval ? { message: WAKE_UP_NEEDS_APPROVAL_COPY } : {}),
      },
      200,
      NO_STORE,
    );
  });

  app.get('/station-control/wake-ups', (c) => {
    const caller = callerOf(c);
    if ('refused' in caller) return caller.refused;
    if (!deps.store) return unavailable(c);
    return c.json(
      {
        success: true,
        data: deps.store
          .pendingWakeUps(caller.conversationId)
          .map(publicWakeUp),
      },
      200,
      NO_STORE,
    );
  });

  app.delete('/station-control/wake-ups/:wakeUpId', (c) => {
    const caller = callerOf(c);
    if ('refused' in caller) return caller.refused;
    if (!deps.store || !deps.delivery) return unavailable(c);
    const record = deps.store.wakeUp(c.req.param('wakeUpId'));
    // Another conversation's wake-up reads exactly like one that does not
    // exist.
    if (!record || record.conversationId !== caller.conversationId)
      return otherConversation(c);
    const canceled = deps.delivery.cancel(record.id, 'agent');
    return c.json({ success: true, data: { canceled } }, 200, NO_STORE);
  });

  app.post('/station-control/job-proposals', async (c) => {
    const caller = callerOf(c);
    if ('refused' in caller) return caller.refused;
    // Nobody could approve it here: the scheduler is not offered hosted.
    if (!deps.store || deps.hosted)
      return proposalRefusal(c, 'job_proposal_unavailable', 503);
    const raw = await readJson(c.req.raw);
    const parsed = jobProposalBodySchema.safeParse(raw);
    // The scheduler's own validation decides whether the job itself is one
    // it would create (name, schedule, prompt bounds).
    const job = parsed.success
      ? addJobSchema.safeParse({
          name: parsed.data.name,
          schedule: parsed.data.schedule,
          prompt: parsed.data.prompt,
          ...(parsed.data.agent ? { agent: parsed.data.agent } : {}),
        })
      : undefined;
    if (!parsed.success || !job?.success || !job.data.schedule)
      return c.json(
        {
          success: false,
          code: 'job_proposal_invalid',
          error:
            'propose_job needs a name (lowercase letters, digits, hyphens), a schedule (cron, every or at) and a prompt.',
        },
        400,
        NO_STORE,
      );
    // The Agent a job runs is decided by the same scope rule a dispatch
    // answers: one outside the caller's Project (or one Station cannot
    // read) is not proposable, so a person is never asked to approve a job
    // that would run an Agent this chat could not reach itself.
    if (job.data.agent) {
      const ownerId = caller.policy.principal?.elevationEligible
        ? caller.policy.principal.id
        : undefined;
      let target: StationControlResolvedDispatchTarget | undefined;
      try {
        target = await deps.jobAgentTarget?.(job.data.agent, ownerId);
      } catch {
        target = undefined;
      }
      if (stationControlScopeRefusal(caller.policy, target))
        return proposalRefusal(c, 'job_proposal_agent_out_of_scope', 403);
    }
    const proposedJob: AgentJobProposalJob = {
      name: job.data.name,
      schedule: job.data.schedule as AgentJobProposalJob['schedule'],
      prompt: job.data.prompt,
      ...(job.data.agent ? { agent: job.data.agent } : {}),
    };
    const result = deps.store.insertJobProposal({
      conversationId: caller.conversationId,
      sessionId: caller.sessionId,
      job: proposedJob,
      ...(parsed.data.rationale ? { rationale: parsed.data.rationale } : {}),
      now: now(),
    });
    if (result.outcome === 'limit-reached')
      return proposalRefusal(c, 'job_proposal_limit_reached', 409);
    if (result.outcome === 'rate-limited')
      return proposalRefusal(c, 'job_proposal_rate_limited', 409);
    // The agent learns only what it proposed and that a person decides.
    return c.json(
      {
        success: true,
        data: { id: result.proposal.id, state: result.proposal.state },
      },
      200,
      NO_STORE,
    );
  });

  // ── the person's own view and actions ───────────────────────────────────

  /** The person behind a UI request, or the response refusing it. */
  const personFor = (
    c: Context,
    conversationId: string,
    need: 'read' | 'mutate',
  ): AgentSchedulePerson | Response => {
    if (requestMayBeAnAgent(c.req.raw))
      return c.json(
        { success: false, code: 'person-approval-required' },
        403,
        NO_STORE,
      );
    const person = deps.person(c);
    if (
      !person ||
      !(need === 'read'
        ? person.mayRead(conversationId)
        : person.mayMutate(conversationId))
    )
      return c.json({ success: false, error: 'Not found' }, 404, NO_STORE);
    return person;
  };

  app.get('/agent-schedule/:conversationId', async (c) => {
    const conversationId = c.req.param('conversationId');
    const person = personFor(c, conversationId, 'read');
    if (person instanceof Response) return person;
    let usageLimitResume: ConversationUsageLimitResume | undefined;
    try {
      usageLimitResume = await deps.usageLimitResume?.(conversationId);
    } catch {
      // The banner reads the stop itself; this list just leaves it out.
      usageLimitResume = undefined;
    }
    const data: ConversationAgentSchedule = {
      wakeUps:
        deps.store?.pendingWakeUps(conversationId).map(publicWakeUp) ?? [],
      jobProposals:
        deps.store?.openJobProposals(conversationId).map(publicJobProposal) ??
        [],
      jobs:
        deps.store?.approvedJobs(
          conversationId,
          CONVERSATION_SCHEDULED_JOBS_LIMIT,
        ) ?? [],
      ...(usageLimitResume ? { usageLimitResume } : {}),
    };
    return c.json({ success: true, data }, 200, NO_STORE);
  });

  /** The conversation's wake-up a person's request names, or a 404. */
  const personWakeUp = (c: Context) => {
    const conversationId = c.req.param('conversationId') ?? '';
    const person = personFor(c, conversationId, 'mutate');
    if (person instanceof Response) return person;
    const record = deps.store?.wakeUp(c.req.param('wakeUpId') ?? '');
    if (!record || record.conversationId !== conversationId || !deps.delivery)
      return c.json({ success: false, error: 'Not found' }, 404, NO_STORE);
    return { person, record, delivery: deps.delivery };
  };

  // Cancel and Decline are the same act: the wake-up will not be sent.
  const cancelByPerson = (c: Context) => {
    const found = personWakeUp(c);
    if (found instanceof Response) return found;
    return c.json(
      {
        success: true,
        data: { canceled: found.delivery.cancel(found.record.id, 'person') },
      },
      200,
      NO_STORE,
    );
  };
  app.post(
    '/agent-schedule/:conversationId/wake-ups/:wakeUpId/cancel',
    cancelByPerson,
  );
  app.post(
    '/agent-schedule/:conversationId/wake-ups/:wakeUpId/decline',
    cancelByPerson,
  );

  /**
   * A person approves a check-back an unconfined session's agent asked for.
   * The person gate is propose_job's: a request that may be an agent's is
   * refused, and one from a person who may not send here reads as missing.
   */
  app.post(
    '/agent-schedule/:conversationId/wake-ups/:wakeUpId/approve',
    (c) => {
      const found = personWakeUp(c);
      if (found instanceof Response) return found;
      const result = found.delivery.approve(
        found.record.id,
        found.person.userId,
      );
      if (result.outcome === 'unavailable')
        return c.json(
          {
            success: false,
            code: 'wake_up_unavailable',
            error: WAKE_UP_REFUSAL_COPY.wake_up_unavailable,
          },
          503,
          NO_STORE,
        );
      if (result.outcome === 'settled')
        return c.json(
          {
            success: false,
            code: 'wake_up_settled',
            error: settledWakeUpCopy(result.state, result.reasonCode),
          },
          409,
          NO_STORE,
        );
      return c.json({ success: true, data: result.wakeUp }, 200, NO_STORE);
    },
  );

  app.post(
    '/agent-schedule/:conversationId/job-proposals/:proposalId/decline',
    (c) => {
      const conversationId = c.req.param('conversationId');
      const person = personFor(c, conversationId, 'mutate');
      if (person instanceof Response) return person;
      const record = deps.store?.jobProposal(c.req.param('proposalId'));
      if (!record || record.conversationId !== conversationId)
        return c.json({ success: false, error: 'Not found' }, 404, NO_STORE);
      // Only from `open`: an Approve that already claimed it wins.
      const declined = deps.store!.transitionJobProposal(
        record.id,
        'open',
        'declined',
        person.userId,
        now(),
      );
      return c.json({ success: true, data: { declined } }, 200, NO_STORE);
    },
  );

  return app;
}

/** The fields an approval body may carry: exactly the proposed job's. */
const APPROVABLE_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'schedule',
  'prompt',
  'agent',
]);

/**
 * The scheduler create route's approval of a job proposal. A person's own
 * request (never one that may be an agent's) that may act on the proposal's
 * conversation, naming a proposal still open, with a body that is exactly
 * the proposed job and nothing more. Admission CLAIMS the proposal
 * (`open` -> `approving`, one conditional UPDATE), so a Decline after it
 * changes nothing; the route then creates the job and `commit`s
 * (`approved`), or `revert`s to `open` if creating it failed.
 */
export function createJobProposalApproval(deps: {
  store: AgentScheduleStore | undefined;
  person(c: Context): AgentSchedulePerson | undefined;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  now?: () => number;
}): JobProposalApproval {
  return {
    admit(c, proposalId, body) {
      if (requestMayBeAnAgent(c.req.raw))
        return {
          ok: false,
          status: 403,
          code: 'person-approval-required',
          error: 'Only a person can approve a job proposal.',
        };
      const notFound = {
        ok: false,
        status: 404,
        code: 'job_proposal_not_found',
        error: 'Job proposal not found',
      } as const;
      const proposal = deps.store?.jobProposal(proposalId);
      if (!proposal) return notFound;
      const person = deps.person(c);
      if (!person?.mayMutate(proposal.conversationId)) return notFound;
      if (proposal.state !== 'open')
        return {
          ok: false,
          status: 409,
          code: 'job_proposal_settled',
          error: `This proposal was already ${proposal.state}.`,
        };
      const extra = Object.keys(body).some(
        (key) => body[key] !== undefined && !APPROVABLE_FIELDS.has(key),
      );
      if (extra || !jobMatchesProposal(proposal.job, body))
        return {
          ok: false,
          status: 409,
          code: 'job_proposal_mismatch',
          error: 'That is not the job the agent proposed.',
        };
      const store = deps.store!;
      const at = () => deps.now?.() ?? Date.now();
      if (
        !store.transitionJobProposal(
          proposal.id,
          'open',
          'approving',
          person.userId,
          at(),
        )
      ) {
        const state = store.jobProposalState(proposal.id);
        return {
          ok: false,
          status: 409,
          code: 'job_proposal_settled',
          error:
            state === 'approving'
              ? 'This proposal is already being approved.'
              : `This proposal was already ${state ?? 'removed'}.`,
        };
      }
      return {
        ok: true,
        commit: () => {
          // The job exists now. A claim reopened underneath it (startup
          // reopens claims older than the process) is still this approval.
          const committed =
            store.transitionJobProposal(
              proposal.id,
              'approving',
              'approved',
              person.userId,
              at(),
            ) ||
            store.transitionJobProposal(
              proposal.id,
              'open',
              'approved',
              person.userId,
              at(),
            );
          if (!committed)
            deps.logger?.warn('approved job proposal could not be recorded', {
              proposalId: proposal.id,
              state: store.jobProposalState(proposal.id) ?? 'removed',
            });
        },
        revert: () => {
          store.transitionJobProposal(
            proposal.id,
            'approving',
            'open',
            null,
            at(),
          );
        },
      };
    },
  };
}
