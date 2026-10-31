/**
 * Runs an automation that targets a conversation: one framed Station turn
 * per run, on whatever engine that conversation runs on.
 *
 * The run is queued on the conversation's inbox through the same hand-off a
 * check-back uses (`submitStationFramedTurn`), under the key
 * `scheduler:<runId>`. The inbox waits for a running turn to end, applies
 * the conversation's own permission rule for the recorded creator, and never
 * stores a full-access grant, so the turn runs under the conversation's
 * normal approval mode. A turn that stops for an approval surfaces as needs-
 * you like any other; the run waits for it up to its deadline.
 *
 * A dedicated target has no conversation until its first run, which starts
 * one through the foreground execution seam an inbound webhook uses and
 * records its id on the job. Every later run continues it.
 *
 * The scheduler settles the run from what this returns. Anything that may
 * have reached an engine is `indeterminate`; the scheduler never replays an
 * indeterminate run, and a restart that re-hands the same key gets the
 * inbox's existing entry back, so a run never yields a second turn.
 */
import type { ConversationAutomation } from '@kontourai/station-contracts/agent-schedule';
import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
import { isDeferredRetriableTurnError } from '@kontourai/station-contracts/runtime-events';
import {
  AUTOMATION_RUN_POLICY,
  automationRunClientTurnId,
  automationTargetConversationId,
  type SchedulerAutomationCreator,
  type SchedulerAutomationTarget,
  type SchedulerJob,
} from '@kontourai/station-contracts/scheduler';
import {
  type StationFramedTurnSubmit,
  submitStationFramedTurn,
} from '../orchestration/station-turn-handoff.js';

export type ScheduledConversationRunOutcome =
  | { kind: 'completed'; output: string; conversationId: string }
  | { kind: 'failed'; error: string; conversationId: string }
  | { kind: 'definitely-not-invoked'; error: string }
  | { kind: 'indeterminate'; error: string; conversationId?: string };

export interface ScheduledConversationRunInput {
  readonly jobId: string;
  readonly jobName: string;
  readonly runId: string;
  readonly prompt: string;
  readonly target: SchedulerAutomationTarget;
  readonly createdBy: SchedulerAutomationCreator | undefined;
  /** ISO completion time of the job's last successful run, if any. */
  readonly lastSuccessAt: string | undefined;
  /** Persist the dedicated conversation identity before any engine start. */
  readonly reserveDedicatedConversation?: () => string | undefined;
  /** Record the conversation a dedicated target's first run started. */
  readonly onConversationStarted: (conversationId: string) => void;
  /**
   * The turn is now the conversation's: queued on its inbox, or its
   * dedicated conversation started. Called once; what follows is waiting.
   */
  readonly onHandedOff: () => void;
  readonly signal: AbortSignal;
}

/** What the scheduler calls for a job with a `target`. */
export interface ScheduledConversationRunner {
  run(
    input: ScheduledConversationRunInput,
  ): Promise<ScheduledConversationRunOutcome>;
}

/** How a turn ended, read from its terminal event. */
export type ScheduledTurnTerminal =
  | { kind: 'completed'; summary?: string }
  | { kind: 'failed'; reason: string };

export interface ScheduledConversationRunsPorts {
  submit: StationFramedTurnSubmit;
  /** The reserved conversation has a durable execution lineage. */
  conversationExists?(conversationId: string): boolean;
  /** The inbox entry under a key, as `ThreadInboxDelivery.entry` shows it. */
  entry(
    conversationId: string,
    clientTurnId: string,
  ): ConversationInboxEntry | undefined;
  /** The terminal of one turn in one Session, once it has one. */
  turnTerminal(
    sessionId: string,
    turnId: string,
  ): ScheduledTurnTerminal | undefined;
  /**
   * Start a dedicated target's conversation with its first turn. Throws only
   * when the start was refused before any effect; an uncertain start must
   * throw an error `isIndeterminateStart` recognizes.
   */
  startDedicated(input: {
    conversationId: string;
    agent: string;
    workspace?: Readonly<{ kind: 'project'; projectSlug: string }>;
    message: string;
    clientTurnId: string;
    actor: SchedulerAutomationCreator;
  }): Promise<{ conversationId: string; sessionId: string; turnId: string }>;
  isIndeterminateStart(error: unknown): boolean;
  /** Re-checks while waiting; tests pass a short one. */
  readonly pollMs?: number;
  readonly deadlineMs?: number;
  readonly now?: () => number;
}

/**
 * What the agent reads when an automation runs. Station's own words frame
 * it, and the "since" watermark lets a recurring prompt cover only what is
 * new since the last run that succeeded.
 */
export function automationRunMessage(input: {
  jobName: string;
  prompt: string;
  lastSuccessAt: string | undefined;
}): string {
  const since = input.lastSuccessAt
    ? `Last successful run: ${input.lastSuccessAt}. Cover what changed since then.`
    : 'This is its first successful run, or none has succeeded yet.';
  return `[Station] The automation "${input.jobName}" is running. This message is from Station, not the person. ${since}\n\n${input.prompt}`;
}

const DEFAULT_POLL_MS = 1_000;

export class ScheduledConversationRuns implements ScheduledConversationRunner {
  constructor(private readonly ports: ScheduledConversationRunsPorts) {}

  async run(
    input: ScheduledConversationRunInput,
  ): Promise<ScheduledConversationRunOutcome> {
    if (input.signal.aborted)
      return {
        kind: 'definitely-not-invoked',
        error: 'Scheduler is stopping',
      };
    if (!input.createdBy)
      return {
        kind: 'definitely-not-invoked',
        error:
          'This automation has no recorded creator to act as. Recreate it to run it in a conversation.',
      };
    const clientTurnId = automationRunClientTurnId(input.runId);
    const message = automationRunMessage(input);
    const conversationId = input.target.conversationId;
    if (conversationId === undefined) {
      if (input.target.kind !== 'dedicated')
        return {
          kind: 'definitely-not-invoked',
          error: 'Automation target names no conversation',
        };
      return this.startDedicated(input, clientTurnId, message);
    }
    return this.queueExisting(input, conversationId, clientTurnId, message);
  }

  private async queueExisting(
    input: ScheduledConversationRunInput,
    conversationId: string,
    clientTurnId: string,
    message: string,
  ): Promise<ScheduledConversationRunOutcome> {
    if (!input.createdBy)
      return {
        kind: 'definitely-not-invoked',
        error: 'The automation has no recorded creator.',
      };
    let submitted: ReturnType<StationFramedTurnSubmit>;
    try {
      submitted = submitStationFramedTurn(this.ports.submit, {
        conversationId,
        clientTurnId,
        message,
        actor: {
          userId: input.createdBy.userId,
          ...(input.createdBy.ownerAttribution
            ? { attribution: input.createdBy.ownerAttribution }
            : {}),
          ...(input.createdBy.principal
            ? { principal: input.createdBy.principal }
            : {}),
        },
      });
    } catch (error) {
      // The inbox refuses before writing anything (an unreadable
      // conversation, a conflicting digest): nothing was queued.
      return {
        kind: 'definitely-not-invoked',
        error: `Could not queue the run: ${errorText(error)}`,
      };
    }
    if (submitted.outcome === 'not-permitted')
      return {
        kind: 'definitely-not-invoked',
        error:
          'The automation’s creator may no longer send to this conversation.',
      };
    if (submitted.outcome === 'capacity')
      return {
        kind: 'definitely-not-invoked',
        error: `The conversation’s queue is full (${submitted.limit} waiting).`,
      };
    if (submitted.outcome === 'conflict')
      return {
        kind: 'indeterminate',
        error: 'The run key names a different queued message.',
        conversationId,
      };
    input.onHandedOff();
    return this.awaitPlacement(input, conversationId, clientTurnId);
  }

  private async startDedicated(
    input: ScheduledConversationRunInput,
    clientTurnId: string,
    message: string,
  ): Promise<ScheduledConversationRunOutcome> {
    const target = input.target as Extract<
      SchedulerAutomationTarget,
      { kind: 'dedicated' }
    >;
    let started: Awaited<
      ReturnType<ScheduledConversationRunsPorts['startDedicated']>
    >;
    let conversationId: string | undefined;
    try {
      conversationId = input.reserveDedicatedConversation?.();
      if (!conversationId)
        return {
          kind: 'definitely-not-invoked',
          error: 'Could not reserve the automation conversation.',
        };
      if (!this.ports.conversationExists)
        return {
          kind: 'definitely-not-invoked',
          error: 'Could not verify the automation conversation.',
        };
      if (this.ports.conversationExists(conversationId)) {
        input.onConversationStarted(conversationId);
        return this.queueExisting(input, conversationId, clientTurnId, message);
      }
      started = await this.ports.startDedicated({
        conversationId,
        agent: target.agent,
        ...(target.workspace ? { workspace: target.workspace } : {}),
        message,
        clientTurnId,
        actor: input.createdBy!,
      });
    } catch (error) {
      if (this.ports.isIndeterminateStart(error))
        return {
          kind: 'indeterminate',
          error: 'Starting the automation’s conversation may have begun.',
        };
      return {
        kind: 'definitely-not-invoked',
        error: `Could not start the automation’s conversation: ${errorText(error)}`,
      };
    }
    if (started.conversationId !== conversationId)
      return {
        kind: 'indeterminate',
        error: 'The started conversation did not match its reserved identity.',
        conversationId: started.conversationId,
      };
    try {
      input.onConversationStarted(started.conversationId);
    } catch {
      // The durable reservation keeps later runs on this conversation.
    }
    input.onHandedOff();
    return this.awaitTurn(
      input,
      started.conversationId,
      started.sessionId,
      started.turnId,
    );
  }

  private async awaitPlacement(
    input: ScheduledConversationRunInput,
    conversationId: string,
    clientTurnId: string,
  ): Promise<ScheduledConversationRunOutcome> {
    const deadline = this.now() + this.deadlineMs();
    for (;;) {
      const entry = this.ports.entry(conversationId, clientTurnId);
      if (entry?.state === 'sent' && entry.sessionId && entry.turnId)
        return this.awaitTurn(
          input,
          conversationId,
          entry.sessionId,
          entry.turnId,
          deadline,
        );
      if (entry?.state === 'refused')
        return {
          kind: 'definitely-not-invoked',
          error: entry.reason ?? 'Station could not send this run.',
        };
      if (entry?.state === 'cancelled' && !entry.turnId)
        return {
          kind: 'definitely-not-invoked',
          error: 'The queued run was withdrawn before it was sent.',
        };
      if (entry?.state === 'unconfirmed' || entry?.state === 'cancelled')
        return {
          kind: 'indeterminate',
          error: 'The run may have been sent; open the conversation to check.',
          conversationId,
        };
      const waited = await this.wait(input.signal, deadline);
      if (waited !== 'again')
        return {
          kind: 'indeterminate',
          error:
            waited === 'stopped'
              ? 'Scheduler stopped while the run waited in the conversation’s queue.'
              : 'The run was still waiting in the conversation’s queue at its deadline.',
          conversationId,
        };
    }
  }

  private async awaitTurn(
    input: ScheduledConversationRunInput,
    conversationId: string,
    sessionId: string,
    turnId: string,
    deadline = this.now() + this.deadlineMs(),
  ): Promise<ScheduledConversationRunOutcome> {
    const output = JSON.stringify({ conversationId, sessionId, turnId });
    for (;;) {
      const terminal = this.ports.turnTerminal(sessionId, turnId);
      if (terminal?.kind === 'completed')
        return { kind: 'completed', output, conversationId };
      if (terminal?.kind === 'failed')
        return { kind: 'failed', error: terminal.reason, conversationId };
      const waited = await this.wait(input.signal, deadline);
      if (waited !== 'again')
        return {
          kind: 'indeterminate',
          error:
            waited === 'stopped'
              ? 'Scheduler stopped while the run’s turn was still running.'
              : 'The run’s turn was still running at its deadline; it continues in the conversation.',
          conversationId,
        };
    }
  }

  private wait(
    signal: AbortSignal,
    deadline: number,
  ): Promise<'again' | 'stopped' | 'deadline'> {
    if (signal.aborted) return Promise.resolve('stopped');
    const remaining = deadline - this.now();
    if (remaining <= 0) return Promise.resolve('deadline');
    return new Promise((resolve) => {
      const finish = (value: 'again' | 'stopped') => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish('stopped');
      const timer = setTimeout(
        () => finish('again'),
        Math.min(this.ports.pollMs ?? DEFAULT_POLL_MS, remaining),
      );
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  private deadlineMs(): number {
    return this.ports.deadlineMs ?? AUTOMATION_RUN_POLICY.turnDeadlineMs;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The events that can end a turn, as the lifecycle fold reads them
 * (`ACTIVE_TURN_FOLD_METHODS`): a completion, an abort, or the
 * `runtime.error` a failed turn ends with (Codex and Claude Code emit one
 * for a failed turn and no completion).
 */
export const SCHEDULED_TURN_TERMINAL_METHODS: readonly string[] = [
  'turn.completed',
  'turn.aborted',
  'runtime.error',
];

/** How many of a turn's terminal-method events `turnTerminal` reads. */
export const SCHEDULED_TURN_TERMINAL_READ_LIMIT = 50;

/** Scan the turn in bounded pages until a terminal or the current end. */
export function readStoredScheduledTurnTerminal(
  store: Pick<
    import('../orchestration/event-store.js').EventStore,
    'listTurnEventsByMethods'
  >,
  sessionId: string,
  turnId: string,
): ScheduledTurnTerminal | undefined {
  let cursor = 0;
  while (true) {
    const rows = store.listTurnEventsByMethods(
      sessionId,
      turnId,
      SCHEDULED_TURN_TERMINAL_METHODS,
      SCHEDULED_TURN_TERMINAL_READ_LIMIT,
      undefined,
      cursor,
    );
    const terminal = readScheduledTurnTerminal(rows.map((row) => row.payload));
    if (terminal) return terminal;
    if (rows.length < SCHEDULED_TURN_TERMINAL_READ_LIMIT) return undefined;
    cursor = rows[rows.length - 1]!.sequence;
  }
}

type TurnTerminalEvent = {
  method?: string;
  finishReason?: string;
  reason?: string;
  message?: string;
  provider?: string;
  retriable?: boolean;
};

/**
 * A turn's outcome from its terminal-method events, oldest first: the first
 * one that decides it. A completion the engine cancelled is not a success; an
 * abort or an engine error is a failure. A Codex error the engine will retry
 * within the same turn (`isDeferredRetriableTurnError`) decides nothing.
 */
export function readScheduledTurnTerminal(
  events: readonly TurnTerminalEvent[],
): ScheduledTurnTerminal | undefined {
  for (const event of events) {
    if (event.method === 'turn.completed')
      return event.finishReason === 'cancelled'
        ? { kind: 'failed', reason: 'The run’s turn was cancelled.' }
        : { kind: 'completed' };
    if (event.method === 'turn.aborted')
      return {
        kind: 'failed',
        reason: `The run’s turn stopped: ${event.reason ?? 'aborted'}.`,
      };
    if (
      event.method === 'runtime.error' &&
      !isDeferredRetriableTurnError(
        event as Parameters<typeof isDeferredRetriableTurnError>[0],
      )
    )
      return {
        kind: 'failed',
        reason: `The engine reported an error: ${event.message ?? 'unknown error'}`,
      };
  }
  return undefined;
}

/**
 * The automations whose runs land in one conversation, for its chat. A
 * dedicated target lands there once its first run recorded the id.
 */
export function conversationAutomationsFrom(
  jobs: readonly SchedulerJob[],
  conversationId: string,
): ConversationAutomation[] {
  return jobs
    .filter(
      (job) => automationTargetConversationId(job.target) === conversationId,
    )
    .map((job) => ({
      name: job.name,
      enabled: job.enabled,
      ...(job.nextRun ? { nextRun: job.nextRun } : {}),
      ...(job.lastRun ? { lastRun: job.lastRun } : {}),
      ...(job.lastSuccessAt ? { lastSuccessAt: job.lastSuccessAt } : {}),
      ...(job.consecutiveFailures === undefined
        ? {}
        : { consecutiveFailures: job.consecutiveFailures }),
    }));
}
