import type { VirtualApplication } from '../../services/connections/virtual-application.js';
import {
  awaitSettlementWithin,
  raceWithSignal,
} from '../../utils/bounded-async.js';

export interface BrokerConnectorLifecycle {
  register(signal: AbortSignal): Promise<unknown>;
  renew(signal: AbortSignal): Promise<unknown>;
  poll(signal: AbortSignal): Promise<unknown>;
  withdraw(signal: AbortSignal): Promise<void>;
}
export interface SelfHostedBrokerRuntimeOptions {
  origin: string;
  configuredOrigin: string;
  application: VirtualApplication;
  connector: BrokerConnectorLifecycle;
  heartbeatMs: number;
  renewMs: number;
  pollMs: number;
  withdrawTimeoutMs?: number;
  operationSettleMs?: number;
}

const DEFAULT_WITHDRAW_TIMEOUT_MS = 5_000;
const DEFAULT_OPERATION_SETTLE_MS = 5_000;

function withCleanupCause(primary: unknown, cleanup: unknown): unknown {
  if (cleanup === undefined || cleanup === primary) return primary;
  if (primary instanceof Error) {
    const combined = new Error(primary.message, { cause: cleanup });
    combined.name = primary.name;
    if (primary.stack !== undefined) combined.stack = primary.stack;
    return combined;
  }
  return primary;
}

export class SelfHostedBrokerRuntime {
  readonly #abort = new AbortController();
  readonly #withdrawTimeoutMs: number;
  readonly #operationSettleMs: number;
  #start: Promise<void> | undefined;
  #shutdown: Promise<void> | undefined;
  #loop: Promise<void> | undefined;
  #withdraw: Promise<void> | undefined;
  #autoWithdraw: Promise<void> | undefined;
  #failure: unknown;
  #hasFailure = false;
  #shutdownRequested = false;
  #detachApplicationAbort: (() => void) | undefined;
  constructor(private readonly options: SelfHostedBrokerRuntimeOptions) {
    if (
      new URL(options.origin).origin !== options.origin ||
      new URL(options.configuredOrigin).origin !== options.configuredOrigin
    )
      throw new Error('broker_runtime_origin_mismatch');
    for (const value of [options.heartbeatMs, options.renewMs, options.pollMs])
      if (!Number.isSafeInteger(value) || value < 1_000 || value > 86_400_000)
        throw new Error('broker_runtime_interval_invalid');
    if (options.heartbeatMs > 30_000)
      throw new Error('broker_runtime_heartbeat_too_slow');
    for (const value of [options.withdrawTimeoutMs, options.operationSettleMs])
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000)
      )
        throw new Error('broker_runtime_bound_invalid');
    if (options.application.signal.aborted)
      throw new Error('broker_runtime_application_unavailable');
    this.#withdrawTimeoutMs =
      options.withdrawTimeoutMs ?? DEFAULT_WITHDRAW_TIMEOUT_MS;
    this.#operationSettleMs =
      options.operationSettleMs ?? DEFAULT_OPERATION_SETTLE_MS;
  }
  start() {
    return (this.#start ??= (async () => {
      if (this.#shutdownRequested) throw this.#abortReason();
      this.#linkApplicationAbort();
      try {
        const registration = this.options.connector.register(
          this.#abort.signal,
        );
        await this.#joinAbortable(
          registration,
          'broker_runtime_register_unsettled',
        );
        if (this.#abort.signal.aborted) throw this.#abortReason();
        // The loop settles independently: its rejection handler records the
        // failure and retires automatically, so start() returns once the
        // initial registration is confirmed.
        this.#loop = this.#run().then(
          () => {
            this.#unlinkApplicationAbort();
          },
          (error: unknown) => {
            this.#unlinkApplicationAbort();
            this.#recordFailure(error);
            this.#abort.abort(error);
            this.#retireAutomatically();
          },
        );
      } catch (error) {
        this.#unlinkApplicationAbort();
        if (!this.#abort.signal.aborted) this.#abort.abort(error);
        let withdrawError: unknown;
        try {
          await this.#requestWithdraw();
        } catch (cleanupError) {
          withdrawError = cleanupError;
        }
        throw withCleanupCause(error, withdrawError);
      }
    })());
  }
  async #run() {
    let heartbeat = Date.now() + this.options.heartbeatMs,
      renew = Date.now() + this.options.renewMs,
      poll = 0;
    while (
      !this.#abort.signal.aborted &&
      !this.options.application.signal.aborted
    ) {
      const now = Date.now();
      if (now >= heartbeat) {
        await this.#joinAbortable(
          this.options.connector.register(this.#abort.signal),
          'broker_runtime_heartbeat_unsettled',
        );
        heartbeat = Date.now() + this.options.heartbeatMs;
      }
      if (now >= renew) {
        await this.#joinAbortable(
          this.options.connector.renew(this.#abort.signal),
          'broker_runtime_renew_unsettled',
        );
        renew = Date.now() + this.options.renewMs;
      }
      if (now >= poll) {
        await this.#joinAbortable(
          this.options.connector.poll(this.#abort.signal),
          'broker_runtime_poll_unsettled',
        );
        poll = Date.now() + this.options.pollMs;
      }
      if (this.#abort.signal.aborted || this.options.application.signal.aborted)
        break;
      await this.#sleep();
    }
  }
  shutdown() {
    return (this.#shutdown ??= (async () => {
      this.#shutdownRequested = true;
      if (!this.#abort.signal.aborted)
        this.#abort.abort(new Error('broker_runtime_shutdown'));
      // Join startup and the background loop without adopting their errors:
      // start() reports its own failure to its caller, and the background
      // failure is reported below from the recorded value. Joining here only
      // guarantees the in-flight work actually settled before withdrawal.
      await this.#start?.then(
        () => undefined,
        () => undefined,
      );
      await this.#loop?.then(
        () => undefined,
        () => undefined,
      );
      this.#unlinkApplicationAbort();
      let withdrawError: unknown;
      let withdrawFailed = false;
      try {
        await this.#requestWithdraw();
      } catch (error) {
        withdrawError = error;
        withdrawFailed = true;
      }
      if (this.#hasFailure)
        throw withCleanupCause(
          this.#failure,
          withdrawFailed ? withdrawError : undefined,
        );
      if (withdrawFailed) throw withdrawError;
    })());
  }
  #linkApplicationAbort(): void {
    const applicationSignal = this.options.application.signal;
    if (applicationSignal.aborted) {
      if (!this.#abort.signal.aborted)
        this.#abort.abort(applicationSignal.reason);
      return;
    }
    const onApplicationAbort = () => {
      this.#abort.abort(applicationSignal.reason);
    };
    applicationSignal.addEventListener('abort', onApplicationAbort, {
      once: true,
    });
    this.#detachApplicationAbort = () => {
      applicationSignal.removeEventListener('abort', onApplicationAbort);
      this.#detachApplicationAbort = undefined;
    };
  }
  #unlinkApplicationAbort(): void {
    this.#detachApplicationAbort?.();
  }
  #recordFailure(error: unknown): void {
    if (!this.#hasFailure) {
      this.#hasFailure = true;
      this.#failure = error;
    }
  }
  #retireAutomatically(): void {
    // A background failure retires the registration immediately instead of
    // waiting for an external shutdown. The shared memoized withdrawal keeps
    // this to exactly one attempt; shutdown() joins the same promise.
    this.#autoWithdraw = this.#requestWithdraw().then(
      () => undefined,
      () => undefined,
    );
    void this.#autoWithdraw;
  }
  #requestWithdraw(): Promise<void> {
    return (this.#withdraw ??= (async () => {
      // One shared deadline both notifies the connector and bounds our wait,
      // so an ignored signal cannot stall retirement forever.
      const bound = AbortSignal.timeout(this.#withdrawTimeoutMs);
      const operation = this.options.connector.withdraw(bound);
      try {
        await raceWithSignal(operation, bound);
      } catch (error) {
        // The signal alone proves nothing about an operation that ignores
        // it: require the withdrawal itself to settle within a bound and
        // report an unconfirmed cleanup as a failure.
        const settled = await awaitSettlementWithin(
          operation,
          this.#operationSettleMs,
        );
        if (!settled)
          throw new Error('broker_runtime_withdraw_unconfirmed', {
            cause: error,
          });
        throw error;
      }
    })());
  }
  async #joinAbortable(
    operation: Promise<unknown>,
    unsettledCode: string,
  ): Promise<unknown> {
    try {
      return await raceWithSignal(operation, this.#abort.signal);
    } catch (error) {
      const settled = await awaitSettlementWithin(
        operation,
        this.#operationSettleMs,
      );
      if (!settled) throw new Error(unsettledCode, { cause: error });
      throw error;
    }
  }
  #sleep(): Promise<void> {
    const owned = this.#abort.signal;
    const applicationSignal = this.options.application.signal;
    if (owned.aborted || applicationSignal.aborted) return Promise.resolve();
    const delay = Math.min(
      this.options.heartbeatMs,
      this.options.renewMs,
      this.options.pollMs,
    );
    return new Promise<void>((resolve) => {
      const timer = setTimeout(onWake, delay);
      function onWake(): void {
        cleanup();
        resolve();
      }
      function onAbort(): void {
        cleanup();
        resolve();
      }
      function cleanup(): void {
        clearTimeout(timer);
        owned.removeEventListener('abort', onAbort);
        applicationSignal.removeEventListener('abort', onAbort);
      }
      owned.addEventListener('abort', onAbort, { once: true });
      applicationSignal.addEventListener('abort', onAbort, { once: true });
    });
  }
  #abortReason(): unknown {
    const reason = this.#abort.signal.reason;
    if (reason !== undefined && reason !== null) return reason;
    return new Error('broker_runtime_shutdown');
  }
}
