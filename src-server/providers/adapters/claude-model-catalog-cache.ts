import crypto from 'node:crypto';
import {
  abortError,
  raceWithSignal,
  throwIfAborted,
} from '../../utils/bounded-async.js';

/** Upper bound on the entries one Claude catalog answer carries. */
export const CLAUDE_MODEL_CATALOG_MAX_ENTRIES = 1000;

/**
 * #2482: how long a successful Claude catalog answer is reused. The same
 * window Codex keeps for its own catalog (`CODEX_MODEL_CACHE_TTL_MS`), so the
 * two CLI engines age their pickers identically.
 */
export const CLAUDE_MODEL_CATALOG_TTL_MS = 30 * 1000;
/**
 * #2482: a shared probe must end even when no caller bounds it. Without this,
 * a probe that never answers for a caller that passed no signal would hold the
 * in-flight slot forever, and every later caller would join it instead of
 * spawning its own — worse than the uncached behavior this replaces.
 */
export const CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS = 15 * 1000;

/**
 * #2482: what a Claude catalog answer depends on — the Claude Code executable
 * the probe launches (and its version) and the connection env that routes it
 * (station#2072: a proxy-routed connection lists the proxy's catalog). A
 * change to any of these is a different catalog, never a cache hit.
 *
 * The env is hashed rather than kept verbatim: it can carry credentials, and a
 * cache key has no reason to hold a second copy of them.
 */
export function claudeModelCatalogKey(input: {
  executable: string | null;
  installedVersion: string | null;
  bundledVersion: string | null;
  connectionEnv: Record<string, string> | undefined;
}): string {
  const env = Object.entries(input.connectionEnv ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        input.executable,
        input.installedVersion,
        input.bundledVersion,
        env,
      ]),
    )
    .digest('hex');
}

interface CatalogFlight<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
}

/**
 * #2482: a keyed TTL cache with in-flight single-flight for a catalog whose
 * every read is a whole CLI spawn.
 *
 * - Concurrent readers of one key share one discovery.
 * - Only a discovery that settles successfully and was not aborted is cached;
 *   a failure, a timeout, or a probe every reader abandoned is never served
 *   as an answer.
 * - A reader's own cancellation leaves the shared discovery running for the
 *   others; the discovery is aborted only when its last reader leaves.
 */
export class KeyedCatalogSingleFlight<T> {
  private cached: { key: string; value: T; observedAt: number } | null = null;
  private readonly flights = new Map<string, CatalogFlight<T>>();

  constructor(
    private readonly options: {
      ttlMs: number;
      timeoutMs: number;
      timeoutMessage: string;
    },
  ) {}

  async read(
    key: string,
    discover: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    const cached = this.cached;
    if (
      cached &&
      cached.key === key &&
      Date.now() - cached.observedAt < this.options.ttlMs
    ) {
      return cached.value;
    }
    const flight = this.flights.get(key) ?? this.start(key, discover);
    flight.waiters += 1;
    let released = false;
    const release = (reason?: unknown): boolean => {
      if (released) return false;
      released = true;
      flight.waiters -= 1;
      if (
        flight.waiters > 0 ||
        this.flights.get(key) !== flight ||
        flight.controller.signal.aborted
      ) {
        return false;
      }
      // Retire the flight before it finishes unwinding: a reader arriving
      // in that gap must start a fresh discovery, not join one that is
      // already doomed by a reader that has left.
      this.flights.delete(key);
      flight.controller.abort(reason);
      return true;
    };
    try {
      return await raceWithSignal(flight.promise, signal);
    } catch (error) {
      // The last reader left: abort the discovery and let it close its
      // process before reporting, as the uncached probe did.
      if (signal?.aborted && release(abortError(signal))) {
        await flight.promise.catch(() => undefined);
      }
      throw error;
    } finally {
      release();
    }
  }

  private start(
    key: string,
    discover: (signal: AbortSignal) => Promise<T>,
  ): CatalogFlight<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(this.options.timeoutMessage)),
      this.options.timeoutMs,
    );
    timer.unref?.();
    const promise = discover(controller.signal)
      .then((value) => {
        // A probe that answered after it was abandoned or timed out is not
        // an answer this cache vouches for.
        throwIfAborted(controller.signal);
        this.cached = { key, value, observedAt: Date.now() };
        return value;
      })
      .finally(() => {
        clearTimeout(timer);
        if (this.flights.get(key)?.promise === promise)
          this.flights.delete(key);
      });
    // Readers observe the outcome; this keeps an abandoned flight's rejection
    // from surfacing as unhandled.
    promise.catch(() => undefined);
    const flight: CatalogFlight<T> = { promise, controller, waiters: 0 };
    this.flights.set(key, flight);
    return flight;
  }
}
