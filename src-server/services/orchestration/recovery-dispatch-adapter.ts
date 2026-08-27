import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type { ConnectionRecoveryIntent } from '@kontourai/station-contracts/connection-recovery';

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
   * (station#3374). The coordinator refuses to replay a turn whose attachment
   * bytes it cannot resolve rather than re-running it with less than the user
   * sent.
   */
  attachments?: ChatAttachmentInput[];
  ambientContext?: string;
  modelId?: string;
  modelOptions?: Record<string, string | number | boolean>;
  recoveryCorrelationId: string;
  signal: AbortSignal;
}

export type RecoveryDispatchOutcome =
  | { kind: 'rejected' }
  | { kind: 'accepted'; turnId: string }
  | { kind: 'observed'; turnId: string }
  | { kind: 'indeterminate' };

/** Concrete execution facts supplied at external composition. */
export interface RecoveryDispatchExecutionAdapter {
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
      } catch {
        return { kind: 'indeterminate' };
      }
    },
    ...(execution.interrupt ? { interrupt: execution.interrupt } : {}),
  };
}
