import type { EngineId } from '@kontourai/station-contracts/provider';
import type {
  ProviderAdapterShape,
  ProviderSendTurnInput,
} from '../../providers/adapter-shape.js';
import { composeAmbientTurnText } from '../../utils/ambient-context.js';
import type { EventStore } from './event-store.js';
// Type-only import back into the service module: erased at runtime, so no
// import cycle exists.
import type { OrchestrationService } from './orchestration-service.js';
import {
  createRecoveryDispatchAdapter,
  type RecoveryDispatchAdapter,
  type RecoveryDispatchReplay,
} from './recovery-dispatch-adapter.js';

export interface CredentialProfileRecoveryDeps {
  /**
   * The service's PUBLIC dispatch — never a lower-level send: it carries
   * the initialize() latch (T9), so the first recovery replay after boot
   * still latches exactly as it did in-service.
   */
  // Derived from the service's own dispatch return for a sendTurn command.
  dispatchSendTurn: (
    replay: RecoveryDispatchReplay,
  ) => ReturnType<OrchestrationService['dispatch']>;
  providerAcceptsResponse: (provider: EngineId) => boolean;
  /**
   * Recovery-compensation interrupt. Adapter resolution and both
   * adapter-currency asserts stay on the service, where the registry and
   * the thread index live — collapsed to one dep on purpose.
   */
  interruptRecoveredTurn: (input: {
    threadId: string;
    turnId?: string;
  }) => Promise<void>;
  /**
   * C6e stays on the service (slice-7 plan §8): of its 147 lines the only
   * credential-specific content is threading `credentialProfileRef` into
   * the start input — the rest is the service's generic session-start
   * capability.
   */
  restartProviderSession: (input: {
    threadId: string;
    signal: AbortSignal;
    modelId?: string;
    credentialProfileRef?: string;
  }) => Promise<{
    adapter: ProviderAdapterShape;
    armedInternalStopTurnId?: string;
  }>;
  reportRedispatchFailed: (
    threadId: string,
    turnId: string | undefined,
    provider: EngineId,
  ) => void;
  onTurnDispatched: (input: {
    provider: string;
    threadId: string;
    turnId: string;
    prompt: string;
  }) => void;
  forgetCoalescedThread: (threadId: string) => void;
  /**
   * The ONE foreign write that stays raw by design: `quarantinedThreads`
   * is deliberately excluded from `forgetThreadState` (its docblock says
   * so), and the add must sit between the coalescer forget and
   * `stopSession` — the ordering is documented at the call site.
   */
  markThreadQuarantined: (threadId: string) => void;
  sessionAdapterFor: (threadId: string) => ProviderAdapterShape | undefined;
  loadedProviderFor: (threadId: string) => EngineId | undefined;
  providerForThread: (threadId: string) => EngineId | undefined;
  /**
   * The slice-2 teardown seam. The divergent-flag declaration
   * ({ policyThreads, flowBoundThreads }) is written literally at the ctor
   * seam in orchestration-service.ts — the slice-2 source invariant scans
   * only that file and pins all six flagged call sites there.
   */
  forgetThreadState: (threadId: string) => void;
  markSessionClosed: EventStore['markSessionClosed'];
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
}

/**
 * Credential-profile recovery, orchestration-side execution half (epic
 * archive#4024, archive#4174): the C6 cluster from the seam map, PARTIALLY
 * extracted — `restartCredentialProfileProviderSession` stays on the
 * service as the `restartProviderSession` dep (it is generic session-start
 * machinery, not recovery policy). This module owns the restart loop-guard
 * set one-way (nothing outside can write it) and the four policy methods.
 * NOTE the near-twin divergence: `recoverSessions.quarantineSession` (C16)
 * shares three of quarantine's four steps but declares different teardown
 * flags and never calls `markSessionClosed` — a reviewed, still-unconverged
 * difference; do not unify casually.
 */
export class CredentialProfileRecovery {
  private readonly restartingThreads = new Set<string>();

  constructor(private readonly deps: CredentialProfileRecoveryDeps) {}

  /** The recovery module's `setRestarting` dep (loop-guard writer). */
  setRestarting(threadId: string, restarting: boolean): void {
    if (restarting) this.restartingThreads.add(threadId);
    else this.restartingThreads.delete(threadId);
  }

  /** The recovery coordinator's `isCredentialRestarting` dep (reader). */
  isRestarting(threadId: string): boolean {
    return this.restartingThreads.has(threadId);
  }

  /**
   * This is the only recovery execution Adapter. Its Interface reports the
   * provider's acknowledgement truthfully: canonical local observation is not
   * acceptance, and a throw after invocation is indeterminate.
   */
  createDispatchAdapter(): RecoveryDispatchAdapter {
    return createRecoveryDispatchAdapter({
      send: async (replay) => {
        const result = await this.deps.dispatchSendTurn(replay);
        return result && 'turnId' in result ? result : undefined;
      },
      restartProfile: (replay) => this.restartRecoverySession(replay),
      providerAcceptsResponse: (provider) =>
        this.deps.providerAcceptsResponse(provider),
      // Recovery compensation has a provider-issued target already. It is
      // not a user Stop: a just-dispatched recovered turn may not yet have
      // persisted `turn.started`, so the user-facing projection fold cannot
      // decide whether this call reaches the provider. No cooperative-stop
      // budget either; recovery must immediately revoke the authority its
      // ledger has already cancelled. The adapter resolution and the
      // adapter-currency asserts live on the service
      // (`interruptRecoveredTurn`), where the registry and thread index are.
      interrupt: ({ threadId, turnId }) =>
        this.deps.interruptRecoveredTurn({ threadId, turnId }),
    });
  }

  /**
   * Restarts one existing provider session under a server-only profile ref.
   * The ref never enters metadata; adapters consume it only to derive their
   * one spawned process environment. Completion is still owned by the
   * recovery coordinator's correlated `turn.completed` boundary.
   */
  async restartRecoverySession(input: {
    threadId: string;
    input: string;
    attachments?: ProviderSendTurnInput['attachments'];
    ambientContext?: string;
    modelId?: string;
    modelOptions?: Record<string, string | number | boolean>;
    recoveryCorrelationId: string;
    signal: AbortSignal;
    credentialProfileRef?: string;
  }): Promise<{ turnId: string }> {
    const { adapter, armedInternalStopTurnId } =
      await this.deps.restartProviderSession(input);
    // archive#3525 fix round FIX 1: the restart above only means the
    // provider process is back up, not that this turn actually redispatches
    // — if sendTurn itself now fails, nothing is retrying, and the armed
    // internal-stop suppression (for the turn `restartCredentialProfileProviderSession`
    // just stopped) must not silently swallow the genuine "needs attention"
    // push for it.
    let result: { turnId: string };
    try {
      // Independent review HIGH-1: this replay used to send `input.input`
      // straight to the adapter, bypassing the same ambientContext choke
      // point `orchestration-service.ts`'s ordinary `sendTurn` dispatch
      // composes through (`composeAmbientSendTurnInput`) — a pending
      // first-turn instructions receipt (station#895 wave C) rides
      // `ambientContext` exactly like ordinary ambient context (timezone,
      // geolocation), so a credential-profile recovery replay of the
      // session's first turn was silently dropping it while the receipt
      // still read 'delivered' (derived from `turn.started` existing, which
      // this call path itself creates). Composing here — the same rule,
      // not a reimplementation the two paths could drift apart on — closes
      // that gap for every recovery replay, first turn or not.
      //
      // Deliberately does NOT stamp FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY
      // (MEDIUM-1) on this dispatch's own `metadata` — safe only because
      // `input.ambientContext` here (when it carries a pending prompt at
      // all) was read off an EARLIER `turn.started`'s own `ambientContext`
      // (`session-recovery-coordinator.ts`'s `buildReplayInput`), an event
      // that already carries the marker from ITS original dispatch; the
      // delegate seam's `events.some(...)` scan finds that entry either
      // way. A replay of a turn that never reached its own `turn.started`
      // in the first place would under-report ('pending' rather than
      // 'delivered') instead of falsely claiming delivery — an accepted,
      // fail-toward-honest gap, not a silent one.
      result = await adapter.sendTurn({
        threadId: input.threadId,
        input: composeAmbientTurnText(input.ambientContext, input.input),
        displayInput: input.input,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.ambientContext
          ? { ambientContext: input.ambientContext }
          : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
        recoveryCorrelationId: input.recoveryCorrelationId,
        signal: input.signal,
      });
    } catch (error) {
      this.deps.reportRedispatchFailed(
        input.threadId,
        armedInternalStopTurnId,
        adapter.provider,
      );
      throw error;
    }
    this.deps.onTurnDispatched({
      provider: adapter.provider,
      threadId: input.threadId,
      turnId: result.turnId,
      prompt: input.input,
    });
    return result;
  }

  async restoreSession(input: {
    threadId: string;
    signal: AbortSignal;
  }): Promise<void> {
    // archive#3525 fix round FIX 1 (secondary instance): this boot-restore
    // path never dispatches a turn afterward, so any internal-stop
    // suppression `restartCredentialProfileProviderSession` armed on its way
    // through here is reported exactly like a failed retry (nothing IS
    // retrying) — benign today only because `adapter.hasSession` is false on
    // a fresh boot (a property of THIS caller, not of the arm site), so do
    // not depend on that staying true.
    const { adapter, armedInternalStopTurnId } =
      await this.deps.restartProviderSession(input);
    this.deps.reportRedispatchFailed(
      input.threadId,
      armedInternalStopTurnId,
      adapter.provider,
    );
  }

  /**
   * Makes a failed-compensation candidate unusable through Station even when
   * the provider refuses to stop. The provider error remains diagnostic, but
   * local routing and persisted resumability are retired fail-closed.
   */
  async quarantineSession(threadId: string): Promise<void> {
    // Text already buffered for this thread was produced BEFORE the decision
    // to quarantine, and the pre-coalescing publish chain had already
    // persisted it. Flushing it here, while the gate below is still open, is
    // what keeps quarantine from retroactively deleting accepted output;
    // once the thread is in `quarantinedThreads`, `publishCanonicalEvent`
    // drops the flushed delta and the text is gone from the durable record
    // with nothing said about it.
    // `forgetThread` rather than `flushThread`: this thread is retiring, so
    // its first-paint marker retires with it.
    this.deps.forgetCoalescedThread(threadId);
    // Install the guard before asking the provider to stop so concurrent
    // dispatch or events cannot rediscover the candidate during a failed
    // termination attempt.
    this.deps.markThreadQuarantined(threadId);

    const adapter = this.deps.sessionAdapterFor(threadId);
    // archive#3476: read the provider BEFORE the live bindings below are
    // deleted, and independently of whether an engine is bound. Boot recovery
    // no longer starts an engine for a restored session, so `sessionAdapters`
    // is empty for exactly the sessions boot reconciliation quarantines —
    // gating the durable close on `adapter` would leave the persisted row
    // `ready` and resumable on the credential binding whose compensation
    // failed, with only the in-memory guard (which dies with the process)
    // standing between it and the next restart.
    const persistedProvider =
      adapter?.provider ??
      this.deps.loadedProviderFor(threadId) ??
      this.deps.providerForThread(threadId);
    if (adapter) {
      try {
        await adapter.stopSession(threadId);
      } catch (error) {
        this.deps.logger.warn(
          'Credential profile recovery session quarantine could not stop the provider process',
          {
            provider: adapter.provider,
            threadId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    // The divergent-flag declaration lives at the ctor seam in
    // orchestration-service.ts (the slice-2 source invariant scans only
    // that file and pins all six flagged call sites there).
    this.deps.forgetThreadState(threadId);
    // Unconditional: `markSessionClosed` closes an existing row on its own
    // when no provider is supplied, and no-ops when there is neither a row nor
    // a provider. Quarantine is fail-closed, so the durable half runs whether
    // or not this process happened to hold an engine.
    this.deps.markSessionClosed(threadId, persistedProvider);
  }
}
