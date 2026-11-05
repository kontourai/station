/**
 * #4512: continuing unattended work a Station restart cut off.
 *
 * After boot, interrupted-turn recovery settles each turn the restart
 * interrupted (`InterruptedTurnRecovery.recoveredTurns`: banner written,
 * boundary resolved). Behind the `continue-unattended-after-restart`
 * preview, this hands one continuation turn for each such turn whose
 * recorded origin (`turn.started.dispatchOrigin`) is `task-dispatch` or
 * `delegation` to the conversation's inbox, oldest Task first.
 *
 * It never continues an interactive, Automation or unknown-origin turn
 * (Automations keep their own recovery), a turn that was itself a restart
 * continuation, a Session that has moved on, or a Task that is done,
 * canceled or blocked. Recovery only drains this Station's own turn
 * boundaries, so a Session mirrored from another Station is never one.
 *
 * Exactly once: the inbox key is the person's Continue key for the same
 * interruption (`turnInterruptedContinueClientTurnId(boundaryId)`), so the
 * inbox and the turn ledger admit one continuation per interrupted turn,
 * whoever sends it and however often. A second restart finds the original
 * boundary already resolved and reports it no more; an interrupted
 * continuation carries the Continue key and is skipped.
 *
 * The entry is `automaticBackground`, so a start it needs is admitted as
 * queued background work and waits for engine-start capacity in the inbox.
 */
import {
  CLIENT_ORIGIN_VERSION,
  type ClientOrigin,
  UNKNOWN_CLIENT_REPORTED_ORIGIN,
} from '@kontourai/station-contracts/client-origin';
import {
  type TurnDispatchOrigin,
  turnDispatchOrigin,
} from '@kontourai/station-contracts/runtime-events';
import type { TaskStatus } from '@kontourai/station-contracts/task-graph';
import {
  turnInterruptedContinueBoundaryId,
  turnInterruptedContinueClientTurnId,
} from '@kontourai/station-shared/conversation-message';
import { TURN_INTERRUPTED_CONTINUE_PROMPT } from '@kontourai/station-shared/runtime-event-projection';
import type { EventStore } from './event-store.js';
import type { RecoveredInterruptedTurn } from './interrupted-turn-recovery.js';
import type {
  ThreadInboxPayload,
  ThreadInboxSubmission,
} from './thread-inbox.js';

/** Origins this path continues. */
const CONTINUED_ORIGINS: ReadonlySet<TurnDispatchOrigin> = new Set([
  'task-dispatch',
  'delegation',
]);

/** Task states nothing should be continued in. */
const CLOSED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'done',
  'canceled',
  'blocked',
]);

/** Station's own continuation: not a person's words. */
const RESTART_CONTINUATION_CLIENT_ORIGIN: ClientOrigin = Object.freeze({
  version: CLIENT_ORIGIN_VERSION,
  actor: Object.freeze({ kind: 'internal' as const }),
  reported: UNKNOWN_CLIENT_REPORTED_ORIGIN,
});

export type RestartContinuationSkip =
  | 'no-turn'
  | 'origin'
  | 'continuation'
  | 'moved-on'
  | 'task-unavailable'
  | 'task-closed'
  | 'no-owner';

export type RestartContinuationOutcome =
  | {
      readonly kind: 'queued';
      readonly threadId: string;
      readonly conversationId: string;
      readonly clientTurnId: string;
    }
  | {
      readonly kind: 'skipped';
      readonly threadId: string;
      readonly reason: RestartContinuationSkip;
    }
  | {
      readonly kind: 'failed';
      readonly threadId: string;
      readonly reason:
        | Exclude<ThreadInboxSubmission['outcome'], 'queued'>
        | 'error';
    };

export interface RestartContinuationPorts {
  /** The preview's current choice, read once per boot pass. */
  enabled(): boolean;
  readonly eventStore: Pick<
    EventStore,
    | 'listEventsByMethods'
    | 'conversationForSession'
    | 'readProjectTaskRoomExecutionBinding'
  >;
  currentConversationSessionId(conversationId: string): string;
  sessionRecordedOwnerId(threadId: string): string | undefined;
  readTask(
    taskId: string,
  ): { readonly status: TaskStatus; readonly createdAt: string } | null;
  submit(input: {
    readonly conversationId: string;
    readonly clientTurnId: string;
    readonly payload: ThreadInboxPayload;
  }): ThreadInboxSubmission;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

interface Candidate {
  readonly turn: RecoveredInterruptedTurn;
  readonly conversationId: string;
  readonly owner: string;
  readonly origin: TurnDispatchOrigin;
  /** Oldest first: the Task's creation, else the interrupted turn's start. */
  readonly order: string;
}

/**
 * The inbox entry that continues one interrupted turn: the person's Continue
 * key and note, sent as the Session's owner with Station's own origin.
 */
export function restartContinuationEntry(input: {
  readonly conversationId: string;
  readonly boundaryId: string;
  readonly owner: string;
  readonly origin: TurnDispatchOrigin;
}): {
  readonly conversationId: string;
  readonly clientTurnId: string;
  readonly payload: ThreadInboxPayload;
} {
  return {
    conversationId: input.conversationId,
    clientTurnId: turnInterruptedContinueClientTurnId(input.boundaryId),
    payload: {
      message: TURN_INTERRUPTED_CONTINUE_PROMPT,
      actor: { userId: input.owner },
      clientOrigin: RESTART_CONTINUATION_CLIENT_ORIGIN,
      automaticBackground: true,
      dispatchOrigin: input.origin,
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class RestartContinuation {
  constructor(private readonly ports: RestartContinuationPorts) {}

  /** Continue the turns one boot's recovery settled; never throws. */
  continueRecovered(
    turns: readonly RecoveredInterruptedTurn[],
  ): RestartContinuationOutcome[] {
    if (turns.length === 0) return [];
    let enabled = false;
    try {
      enabled = this.ports.enabled();
    } catch {
      enabled = false;
    }
    if (!enabled) return [];
    const outcomes: RestartContinuationOutcome[] = [];
    const candidates: Candidate[] = [];
    for (const turn of turns) {
      try {
        const decided = this.candidate(turn);
        if ('reason' in decided) outcomes.push(decided);
        else candidates.push(decided);
      } catch (error) {
        this.warn(turn, error);
        outcomes.push({
          kind: 'failed',
          threadId: turn.threadId,
          reason: 'error',
        });
      }
    }
    candidates.sort((left, right) =>
      left.order < right.order ? -1 : left.order > right.order ? 1 : 0,
    );
    for (const candidate of candidates) outcomes.push(this.submit(candidate));
    return outcomes;
  }

  private candidate(
    turn: RecoveredInterruptedTurn,
  ): Candidate | Extract<RestartContinuationOutcome, { kind: 'skipped' }> {
    const skip = (reason: RestartContinuationSkip) =>
      ({ kind: 'skipped', threadId: turn.threadId, reason }) as const;
    const starts = this.ports.eventStore
      .listEventsByMethods(turn.threadId, ['turn.started'])
      .map((event) => record(event.payload))
      .filter((payload): payload is Record<string, unknown> => !!payload);
    const own = starts.find((payload) => payload.turnId === turn.turnId);
    if (!own) return skip('no-turn');
    const origin = turnDispatchOrigin(own);
    if (!CONTINUED_ORIGINS.has(origin)) return skip('origin');
    if (
      turnInterruptedContinueBoundaryId(
        typeof own.clientTurnId === 'string' ? own.clientTurnId : undefined,
      ) !== undefined
    )
      return skip('continuation');
    if (starts.at(-1)?.turnId !== turn.turnId) return skip('moved-on');
    const conversationId =
      this.ports.eventStore.conversationForSession(turn.threadId)
        ?.conversationId ?? turn.threadId;
    if (
      this.ports.currentConversationSessionId(conversationId) !== turn.threadId
    )
      return skip('moved-on');
    const binding = this.ports.eventStore.readProjectTaskRoomExecutionBinding(
      turn.threadId,
    );
    const task = binding ? this.ports.readTask(binding.taskId) : undefined;
    if (binding && !task) return skip('task-unavailable');
    if (task && CLOSED_TASK_STATUSES.has(task.status))
      return skip('task-closed');
    const owner = this.ports.sessionRecordedOwnerId(turn.threadId);
    if (!owner) return skip('no-owner');
    return {
      turn,
      conversationId,
      owner,
      origin,
      order:
        task?.createdAt ??
        (typeof own.createdAt === 'string' ? own.createdAt : ''),
    };
  }

  private submit(candidate: Candidate): RestartContinuationOutcome {
    const { turn } = candidate;
    const entry = restartContinuationEntry({
      conversationId: candidate.conversationId,
      boundaryId: turn.boundaryId,
      owner: candidate.owner,
      origin: candidate.origin,
    });
    const { clientTurnId } = entry;
    try {
      const submitted = this.ports.submit(entry);
      if (submitted.outcome !== 'queued') {
        this.ports.logger.warn('restart continuation was not queued', {
          threadId: turn.threadId,
          outcome: submitted.outcome,
        });
        return {
          kind: 'failed',
          threadId: turn.threadId,
          reason: submitted.outcome,
        };
      }
      return {
        kind: 'queued',
        threadId: turn.threadId,
        conversationId: candidate.conversationId,
        clientTurnId,
      };
    } catch (error) {
      this.warn(turn, error);
      return { kind: 'failed', threadId: turn.threadId, reason: 'error' };
    }
  }

  private warn(turn: RecoveredInterruptedTurn, error: unknown): void {
    this.ports.logger.warn('restart continuation failed', {
      threadId: turn.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
