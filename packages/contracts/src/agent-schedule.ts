/**
 * What an agent may schedule for itself, and what it may only propose.
 *
 * - A wake-up (`schedule_wake_up`): one follow-up turn into the calling
 *   agent's OWN conversation at a later time, sent with that conversation's
 *   existing permissions. Any verified caller may schedule one; the server
 *   reads the conversation from the verified caller, never from the request.
 * - A job proposal (`propose_job`): a scheduled job an agent whose
 *   credential cannot create one asks a person to approve. Approving creates
 *   the job through the ordinary scheduler route under the person's own
 *   credential; declining records that it was declined.
 *
 * Bounds are refusals, never truncation: a value over its limit is refused
 * with a code the agent can act on.
 */

/** The furthest ahead a wake-up may be scheduled: one day. */
export const AGENT_WAKE_UP_MAX_HORIZON_MS = 24 * 60 * 60 * 1000;
/**
 * The soonest a wake-up may be scheduled: one minute. It keeps an agent that
 * reschedules itself each time it wakes from looping turns back to back.
 */
export const AGENT_WAKE_UP_MIN_DELAY_MS = 60 * 1000;
/** Wake-ups one conversation may have waiting at once. */
export const AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION = 3;
/** The longest note a wake-up carries back into the conversation. */
export const AGENT_WAKE_UP_NOTE_MAX_CHARS = 1000;
/** Open job proposals one conversation may have at once. */
export const AGENT_JOB_PROPOSAL_MAX_OPEN_PER_CONVERSATION = 3;

export type AgentWakeUpState = 'pending' | 'sent' | 'canceled' | 'failed';

export interface AgentWakeUp {
  readonly id: string;
  readonly conversationId: string;
  /** ISO time it is due. */
  readonly dueAt: string;
  readonly note: string;
  readonly state: AgentWakeUpState;
  /** Who canceled it, when it was. */
  readonly canceledBy?: 'agent' | 'person';
  /** Why a `failed` wake-up was not sent. */
  readonly reasonCode?: AgentWakeUpFailureCode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AgentWakeUpFailureCode =
  /** The conversation would no longer accept a turn from its recorded sender. */
  | 'not_permitted'
  /** The conversation's inbox was full. */
  | 'capacity'
  /** Station was not running when it was due, and is now over a day late. */
  | 'expired'
  /** The send itself failed. */
  | 'send_failed';

/** Why Station refused to schedule a wake-up. */
export type AgentWakeUpRefusalCode =
  | 'wake_up_too_soon'
  | 'wake_up_too_far'
  | 'wake_up_limit_reached'
  | 'wake_up_note_too_long'
  | 'wake_up_unavailable';

/** The job a proposal asks for: the scheduler's own create body, minus what a person must choose. */
export interface AgentJobProposalJob {
  readonly name: string;
  readonly schedule:
    | {
        readonly kind: 'cron';
        readonly expr: string;
        readonly timezone?: string;
      }
    | { readonly kind: 'every'; readonly everyMs: number }
    | {
        readonly kind: 'at';
        readonly timeMs: number;
        readonly deleteAfterRun?: boolean;
      };
  readonly prompt: string;
  readonly agent?: string;
}

export type AgentJobProposalState = 'open' | 'approved' | 'declined';

export interface AgentJobProposal {
  readonly id: string;
  readonly conversationId: string;
  readonly job: AgentJobProposalJob;
  /** Why the agent wants it, in its own words. */
  readonly rationale?: string;
  readonly state: AgentJobProposalState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A job a person created by approving a proposal from this conversation. */
export interface ConversationScheduledJob {
  readonly proposalId: string;
  /** The scheduler job's name; the job itself is read from the scheduler. */
  readonly name: string;
}

/** A usage-limit stop in this conversation waiting for its reset. */
export interface ConversationUsageLimitResume {
  /** The Session the stop belongs to (the usage-limit routes' `:threadId`). */
  readonly threadId: string;
  readonly dueAt: string;
  /** Whether Station will resume it at `dueAt` on its own. */
  readonly autoResume: boolean;
}

/** A conversation's agent-scheduled items, as the chat shows them. */
export interface ConversationAgentSchedule {
  readonly wakeUps: readonly AgentWakeUp[];
  readonly jobProposals: readonly AgentJobProposal[];
  readonly jobs: readonly ConversationScheduledJob[];
  readonly usageLimitResume?: ConversationUsageLimitResume;
}

/** How many approved jobs a conversation's schedule lists. */
export const CONVERSATION_SCHEDULED_JOBS_LIMIT = 20;

export type AgentJobProposalRefusalCode =
  | 'job_proposal_limit_reached'
  | 'job_proposal_invalid';

/**
 * Whether a scheduler create body asks for exactly the job a proposal named.
 * The scheduler route approves a proposal only when it does, so a person's
 * Approve cannot be replayed onto a different job.
 */
export function jobMatchesProposal(
  job: AgentJobProposalJob,
  body: {
    readonly name?: unknown;
    readonly schedule?: unknown;
    readonly prompt?: unknown;
    readonly agent?: unknown;
  },
): boolean {
  return (
    body.name === job.name &&
    body.prompt === job.prompt &&
    (body.agent ?? undefined) === (job.agent ?? undefined) &&
    canonical(body.schedule) === canonical(job.schedule)
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}
