import type { VirtualApplication } from '../../services/connections/virtual-application.js';

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
}
export class SelfHostedBrokerRuntime {
  readonly #abort = new AbortController();
  #start: Promise<void> | undefined;
  #shutdown: Promise<void> | undefined;
  #loop: Promise<void> | undefined;
  #failure: unknown;
  constructor(private readonly options: SelfHostedBrokerRuntimeOptions) {
    if (
      new URL(options.origin).origin !== options.origin ||
      options.origin !== options.configuredOrigin
    )
      throw new Error('broker_runtime_origin_mismatch');
    for (const value of [options.heartbeatMs, options.renewMs, options.pollMs])
      if (!Number.isSafeInteger(value) || value < 1_000 || value > 86_400_000)
        throw new Error('broker_runtime_interval_invalid');
    if (options.heartbeatMs > 30_000)
      throw new Error('broker_runtime_heartbeat_too_slow');
    if (options.application.signal.aborted)
      throw new Error('broker_runtime_application_unavailable');
  }
  start() {
    return (this.#start ??= (async () => {
      try {
        await this.options.connector.register(this.#abort.signal);
        this.#loop = this.#run().catch((error) => {
          this.#failure = error;
          this.#abort.abort(error);
        });
      } catch (error) {
        this.#abort.abort(error);
        await this.options.connector
          .withdraw(AbortSignal.timeout(5_000))
          .catch(() => {});
        throw error;
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
        await this.options.connector.register(this.#abort.signal);
        heartbeat = now + this.options.heartbeatMs;
      }
      if (now >= renew) {
        await this.options.connector.renew(this.#abort.signal);
        renew = now + this.options.renewMs;
      }
      if (now >= poll) {
        await this.options.connector.poll(this.#abort.signal);
        poll = now + this.options.pollMs;
      }
      if (this.#abort.signal.aborted || this.options.application.signal.aborted)
        break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          finish,
          Math.min(
            this.options.heartbeatMs,
            this.options.renewMs,
            this.options.pollMs,
          ),
        );
        function finish() {
          clearTimeout(timer);
          thisSignal.removeEventListener('abort', abort);
          applicationSignal.removeEventListener('abort', abort);
          resolve();
        }
        const abort = () => {
          clearTimeout(timer);
          finish();
        };
        const thisSignal = this.#abort.signal,
          applicationSignal = this.options.application.signal;
        thisSignal.addEventListener('abort', abort, { once: true });
        applicationSignal.addEventListener('abort', abort, { once: true });
      });
    }
  }
  shutdown() {
    return (this.#shutdown ??= (async () => {
      this.#abort.abort(new Error('broker_runtime_shutdown'));
      await this.#loop?.catch(() => {});
      await this.options.connector.withdraw(AbortSignal.timeout(5_000));
      if (this.#failure) throw this.#failure;
    })());
  }
}
