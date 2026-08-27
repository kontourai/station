import {
  clearPendingExchange,
  exchangeDevicePairing,
  isTransportFailure,
  type PendingPairingExchange,
} from './devicePairing';

const INITIAL_ATTEMPT_DELAY_MS = 500;
const INITIAL_RETRY_DELAY_MS = 750;
const MAX_RETRY_DELAY_MS = 5_000;
const RATE_LIMITED_RETRY_DELAY_MS = 10_000;

export type PendingPairingProgress =
  | { status: 'waiting-for-approval' }
  | { status: 'waiting-for-connection' };

export type PendingPairingExchangeResult = Awaited<
  ReturnType<typeof exchangeDevicePairing>
>;

export type PendingPairingCompletion =
  | { status: 'paired'; result: PendingPairingExchangeResult }
  | { status: 'post-exchange-failed'; failure: unknown }
  | { status: 'declined' }
  | { status: 'expired' }
  | { status: 'identity-changed' }
  | { status: 'failed' }
  | { status: 'aborted' };

/**
 * The caller-owned part of a completed pairing: durable local persistence,
 * connection validation, or an equivalent commit. It deliberately returns a
 * total outcome so presentation-specific failure copy remains at the caller.
 */
export type CompletePaired = (
  result: PendingPairingExchangeResult,
  context: { signal: AbortSignal },
) => Promise<{ status: 'completed' } | { status: 'failed'; failure: unknown }>;

export interface CompletePendingPairingOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PendingPairingProgress) => void;
  /**
   * The first subscriber for a pending request owns its durable completion.
   * Later subscribers share that completion and must not supply a competing
   * persistence policy for the same request.
   */
  completePaired: CompletePaired;
}

type ExchangePendingPairing = (
  input: PendingPairingExchange & { signal?: AbortSignal },
) => Promise<PendingPairingExchangeResult>;

interface PendingPairingCompletionDependencies {
  clearPending: (
    endpoint: string,
    requestKind: PendingPairingExchange['requestKind'],
  ) => void;
  exchange: ExchangePendingPairing;
  now: () => number;
  waitUntil: (timestamp: number, signal?: AbortSignal) => Promise<boolean>;
}

function waitUntil(timestamp: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onWake);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onWake);
        window.removeEventListener('online', onWake);
      }
    };
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ready);
    };
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(
        () => finish(true),
        Math.max(0, timestamp - Date.now()),
      );
    };
    function onAbort() {
      finish(false);
    }
    function onWake() {
      if (typeof document !== 'undefined' && document.hidden) return;
      // A wake can recover a suspended timer after its floor, but it can never
      // shorten the retry policy established by the previous response.
      schedule();
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onWake);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onWake);
      window.addEventListener('online', onWake);
    }
    schedule();
  });
}

function errorStatus(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/**
 * Internal construction seam for interface-level tests. It is deliberately
 * absent from the package entrypoint: pairing callers learn only
 * `completePendingPairing`, while this module's own tests can substitute the
 * remote exchange and local clock without exposing either through the external
 * interface.
 */
export function createPendingPairingCompletion(
  overrides: Partial<PendingPairingCompletionDependencies> = {},
): (
  pending: PendingPairingExchange,
  options: CompletePendingPairingOptions,
) => Promise<PendingPairingCompletion> {
  const deps: PendingPairingCompletionDependencies = {
    clearPending: clearPendingExchange,
    exchange: exchangeDevicePairing,
    // Keep this late-bound so fake clocks and host clock substitutions apply
    // after the module has loaded too.
    now: () => Date.now(),
    waitUntil,
    ...overrides,
  };

  type TerminalCompletion = Exclude<
    PendingPairingCompletion,
    { status: 'aborted' }
  >;
  interface Subscriber {
    signal?: AbortSignal;
    onProgress?: (progress: PendingPairingProgress) => void;
    resolve: (completion: PendingPairingCompletion) => void;
    settled: boolean;
    onAbort: () => void;
  }
  interface Flight {
    key: string;
    pending: PendingPairingExchange;
    controller: AbortController;
    completePaired: CompletePaired;
    exchangeSpent: boolean;
    subscribers: Set<Subscriber>;
    progress: PendingPairingProgress['status'] | undefined;
    settled: boolean;
    clearedTerminalRecord: boolean;
  }

  const flights = new Map<string, Flight>();

  // The persisted record is origin-and-kind scoped, but a live flight is more
  // precise: only callers completing the exact bearer request may share it.
  // Keeping the validation and delivery fields in the key avoids letting a
  // caller with materially different pairing semantics inherit another
  // caller's result merely because a request id was reused unexpectedly.
  const flightKey = (pending: PendingPairingExchange) =>
    JSON.stringify([
      pending.endpoint,
      pending.requestKind,
      pending.offerId,
      pending.proof,
      pending.requestId,
      pending.expectedEnvironmentId,
      pending.browserSession,
    ]);

  const clearTerminalRecord = (flight: Flight) => {
    if (flight.clearedTerminalRecord) return;
    flight.clearedTerminalRecord = true;
    // Storage cleanup is best effort, as it is in devicePairing. A storage
    // observer must not turn an already-classified remote outcome into a
    // rejected completion promise.
    try {
      deps.clearPending(flight.pending.endpoint, flight.pending.requestKind);
    } catch {
      // The remote request is terminal even if local persistence is unavailable.
    }
  };

  const notify = (
    subscriber: Subscriber,
    status: PendingPairingProgress['status'],
  ) => {
    if (subscriber.settled || !subscriber.onProgress) return;
    try {
      subscriber.onProgress({ status });
    } catch {
      // Progress observers are presentation-only. One broken observer must not
      // interrupt polling or prevent the other subscribers from seeing it.
    }
  };

  const reportProgress = (
    flight: Flight,
    status: PendingPairingProgress['status'],
  ) => {
    if (flight.progress === status) return;
    flight.progress = status;
    for (const subscriber of flight.subscribers) notify(subscriber, status);
  };

  const settleSubscriber = (
    flight: Flight,
    subscriber: Subscriber,
    completion: PendingPairingCompletion,
  ) => {
    if (subscriber.settled) return;
    subscriber.settled = true;
    subscriber.signal?.removeEventListener('abort', subscriber.onAbort);
    flight.subscribers.delete(subscriber);
    subscriber.resolve(completion);
  };

  const abandonFlightIfUnobserved = (flight: Flight) => {
    if (flight.settled || flight.subscribers.size) return;
    // Retain the keyed flight until its adapter settles. Before exchange an
    // abort preserves the pending proof, but an adapter can ignore abort and
    // resolve later; evicting here would let a new caller run that same proof
    // concurrently. After exchange, the same retention prevents replay of a
    // spent proof while durable completion is still unwinding.
    if (flight.exchangeSpent) {
      // Completion receives this shared signal, but the keyed flight remains
      // available for a late observer until completion itself settles.
      flight.controller.abort();
      return;
    }
    flight.controller.abort();
  };

  const settleFlight = (
    flight: Flight,
    completion: PendingPairingCompletion,
  ) => {
    if (flight.settled) return;
    flight.settled = true;
    if (flights.get(flight.key) === flight) flights.delete(flight.key);
    for (const subscriber of [...flight.subscribers]) {
      settleSubscriber(flight, subscriber, completion);
    }
  };

  const runFlight = async (
    flight: Flight,
  ): Promise<PendingPairingCompletion> => {
    const terminal = (
      completion: TerminalCompletion,
    ): PendingPairingCompletion => {
      clearTerminalRecord(flight);
      return completion;
    };
    let retryDelayMs = INITIAL_RETRY_DELAY_MS;
    let nextAttemptAt = deps.now() + INITIAL_ATTEMPT_DELAY_MS;

    try {
      while (true) {
        if (!(await deps.waitUntil(nextAttemptAt, flight.controller.signal))) {
          return { status: 'aborted' };
        }
        if (flight.controller.signal.aborted) return { status: 'aborted' };
        if (deps.now() >= flight.pending.expiresAt) {
          return terminal({ status: 'expired' });
        }

        try {
          const result = await deps.exchange({
            ...flight.pending,
            signal: flight.controller.signal,
          });
          flight.exchangeSpent = true;
          if (
            flight.pending.expectedEnvironmentId &&
            result.environmentId !== flight.pending.expectedEnvironmentId
          ) {
            return terminal({ status: 'identity-changed' });
          }
          // A successful exchange spends the remote proof. From this point on
          // the persisted request is terminal even if the completion owner is
          // aborted or cannot write locally; do not reclassify it as a live
          // caller abort.
          try {
            const completion = await flight.completePaired(result, {
              signal: flight.controller.signal,
            });
            return terminal(
              completion.status === 'completed'
                ? { status: 'paired', result }
                : {
                    status: 'post-exchange-failed',
                    failure: completion.failure,
                  },
            );
          } catch {
            return terminal({ status: 'post-exchange-failed', failure: null });
          }
        } catch (error) {
          if (flight.controller.signal.aborted) return { status: 'aborted' };

          const status = errorStatus(error);
          const code = errorCode(error);
          let minimumDelayMs = 0;
          if (status === 409) {
            reportProgress(flight, 'waiting-for-approval');
          } else if (status === 429) {
            reportProgress(flight, 'waiting-for-approval');
            minimumDelayMs = RATE_LIMITED_RETRY_DELAY_MS;
          } else if (isTransportFailure(error)) {
            reportProgress(flight, 'waiting-for-connection');
          } else if (status === 403 && code === 'request_denied') {
            return terminal({ status: 'declined' });
          } else if (status === 410 || code === 'offer_expired') {
            return terminal({ status: 'expired' });
          } else {
            return terminal({ status: 'failed' });
          }

          const delayMs = Math.max(retryDelayMs, minimumDelayMs);
          retryDelayMs = Math.min(
            Math.ceil(retryDelayMs * 1.5),
            MAX_RETRY_DELAY_MS,
          );
          nextAttemptAt = deps.now() + delayMs;
        }
      }
    } catch {
      return flight.controller.signal.aborted
        ? { status: 'aborted' }
        : terminal({ status: 'failed' });
    }
  };

  const startFlight = (
    pending: PendingPairingExchange,
    key: string,
    completePaired: CompletePaired,
  ) => {
    const flight: Flight = {
      key,
      pending,
      controller: new AbortController(),
      completePaired,
      exchangeSpent: false,
      subscribers: new Set(),
      progress: undefined,
      settled: false,
      clearedTerminalRecord: false,
    };
    flights.set(key, flight);
    void runFlight(flight)
      .then((completion) => settleFlight(flight, completion))
      .catch(() => settleFlight(flight, { status: 'failed' }));
    return flight;
  };

  const subscribe = (
    flight: Flight,
    options: CompletePendingPairingOptions,
  ) => {
    if (options.signal?.aborted) {
      return Promise.resolve<PendingPairingCompletion>({ status: 'aborted' });
    }
    return new Promise<PendingPairingCompletion>((resolve) => {
      const subscriber: Subscriber = {
        signal: options.signal,
        onProgress: options.onProgress,
        resolve,
        settled: false,
        onAbort: () => {
          settleSubscriber(flight, subscriber, { status: 'aborted' });
          abandonFlightIfUnobserved(flight);
        },
      };
      flight.subscribers.add(subscriber);
      options.signal?.addEventListener('abort', subscriber.onAbort, {
        once: true,
      });
      if (flight.progress) notify(subscriber, flight.progress);
      if (options.signal?.aborted) subscriber.onAbort();
    });
  };

  return (pending, options) => {
    if (options.signal?.aborted) {
      return Promise.resolve<PendingPairingCompletion>({ status: 'aborted' });
    }
    const key = flightKey(pending);
    const existing = flights.get(key);
    // A flight owns its request until its adapter and, if spent, durable
    // completion settle. Callback identity is deliberately not part of the
    // key: the first subscriber owns completion; later callers join it.
    const flight =
      existing ?? startFlight(pending, key, options.completePaired);
    return subscribe(flight, options);
  };
}

/**
 * Complete one already-created, persisted pairing request.
 *
 * The implementation hides exchange polling, the 750 ms exponential retry
 * (capped at 5 seconds), the 10-second rate-limit floor, focus/online wakeups,
 * Station identity validation, and terminal record cleanup. Subscribers to the
 * same pending request share one exchange flight while retaining independent
 * cancellation and progress observers. Abort preserves the pending record only
 * until exchange has not spent the proof; successful exchange makes durable
 * completion and cleanup terminal even if its original subscribers abort.
 */
export const completePendingPairing = createPendingPairingCompletion();
