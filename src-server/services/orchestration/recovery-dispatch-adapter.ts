import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type { ConnectionRecoveryIntent } from '@kontourai/station-contracts/connection-recovery';
import type {
  EngineStartAdmissionIntent,
  TurnDispatchOrigin,
} from '@kontourai/station-contracts/runtime-events';

/** Provider execution lives at the orchestration Seam, not in recovery policy. */
export interface RecoveryDispatchAdapter {
  dispatch(input: {
    intent: Readonly<ConnectionRecoveryIntent>;
    replay: RecoveryDispatchReplay;
    credentialProfileRef?: string;
  }): Promise<RecoveryDispatchOutcome>;
  interrupt?(input: { threadId: string; turnId: string }): Promise<void>;
}

/** Content already owned by the canonical source turn; no provider callbacks leak. */
export interface RecoveryDispatchReplay {
  threadId: string;
  input: string;
  /**
   * Dispatchable attachments, not the persisted shape: a replay hands these
   * straight back to a provider, so every one must still have its bytes
   * (archive#3374). The coordinator refuses to replay a turn whose attachment
   * bytes it cannot resolve rather than re-running it with less than the user
   * sent.
   */
  attachments?: ChatAttachmentInput[];
  ambientContext?: string;
  modelId?: string;
  modelOptions?: Record<string, string | number | boolean>;
  recoveryCorrelationId: string;
  signal: AbortSignal;
  /**
   * #4568: who caused the source turn, as this Station recorded it on that
   * turn's `turn.started`. A credential-profile restart derives its
   * engine-start intent from it; it is never sent as turn input.
   */
  dispatchOrigin?: TurnDispatchOrigin;
  resourceAdmissionIntent?: EngineStartAdmissionIntent;
  sourceTurnId?: string;
  sourceClientTurnId?: string;
}

/**
 * Thrown by an execution Adapter for a failure it can prove came before the
 * provider was asked to send anything: the replay was never handed to the
 * provider's send. Every failure after that call stays indeterminate.
 */
export class RecoveryNotSentError extends Error {
  /** False when the failure came before anything stopped or restarted. */
  readonly sessionTouched: boolean;
  constructor(cause: unknown, options: { sessionTouched?: boolean } = {}) {
    // Keeps the underlying message: callers and logs still see why.
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RecoveryNotSentError';
    this.sessionTouched = options.sessionTouched ?? true;
  }
}

const SESSION_UNTOUCHED = Symbol('station.recovery.sessionUntouched');

/**
 * Marks an error a session restart throws before it has stopped or started
 * anything, so recovery does not restore a session that was never disturbed.
 * The error keeps its own class and code.
 */
export function markSessionUntouched<T extends object>(error: T): T {
  Object.defineProperty(error, SESSION_UNTOUCHED, { value: true });
  return error;
}

export function isSessionUntouched(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[SESSION_UNTOUCHED] === true
  );
}

type RecoveryDispatchOutcome =
  /**
   * Definitely not sent. `sessionTouched`: the session restart had begun, so
   * the caller must put the session back before anything else uses it.
   */
  | { kind: 'rejected'; sessionTouched?: true }
  | { kind: 'accepted'; turnId: string }
  | { kind: 'observed'; turnId: string }
  | { kind: 'indeterminate' };

/** Concrete execution facts supplied at external composition. */
interface RecoveryDispatchExecutionAdapter {
  send(replay: RecoveryDispatchReplay): Promise<{ turnId: string } | undefined>;
  restartProfile(
    replay: RecoveryDispatchReplay & { credentialProfileRef: string },
  ): Promise<{ turnId: string } | undefined>;
  providerAcceptsResponse(provider: string): boolean;
  interrupt?(input: { threadId: string; turnId: string }): Promise<void>;
}

/**
 * Classifies the provider fact at the execution Seam.  A returned local turn
 * id is acceptance only for a provider that declares its response durable;
 * every other provider remains merely observed until an event is correlated.
 */
export function createRecoveryDispatchAdapter(
  execution: RecoveryDispatchExecutionAdapter,
): RecoveryDispatchAdapter {
  return {
    dispatch: async ({ intent, replay, credentialProfileRef }) => {
      if (replay.signal.aborted) return { kind: 'rejected' };
      try {
        const result = credentialProfileRef
          ? await execution.restartProfile({ ...replay, credentialProfileRef })
          : await execution.send(replay);
        if (!result) return { kind: 'indeterminate' };
        return execution.providerAcceptsResponse(intent.provider)
          ? { kind: 'accepted', turnId: result.turnId }
          : { kind: 'observed', turnId: result.turnId };
      } catch (error) {
        if (!(error instanceof RecoveryNotSentError))
          return { kind: 'indeterminate' };
        return error.sessionTouched
          ? { kind: 'rejected', sessionTouched: true }
          : { kind: 'rejected' };
      }
    },
    ...(execution.interrupt ? { interrupt: execution.interrupt } : {}),
  };
}
