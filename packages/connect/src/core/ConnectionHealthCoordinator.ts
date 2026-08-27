import { classifyConnectionFailure } from './connectionFailureClassification';
import type { EndpointCompatibilityContext } from './environmentProfiles';
import { rankCompatibleEndpoints } from './environmentProfiles';
import type {
  AccessEndpoint,
  ConnectionFailureReason,
  ConnectionStatus,
} from './types';

export interface ConnectionHealthSnapshot {
  status: ConnectionStatus;
  checking: boolean;
  reason: ConnectionFailureReason | null;
  /**
   * Consecutive completed failing probes with this reason — where `timeout`
   * and `unreachable` count as one transient-unreachability family, so an
   * outage alternating between them keeps one accumulating streak.
   */
  failureStreak: number;
  /**
   * True when the most recent failure was classified `terminal` by
   * `classifyConnectionFailure` (station#1094 R2/R4) — a credential
   * problem, not a network blip. While blocked, this coordinator does NOT
   * schedule another automatic retry (the hot-loop-on-auth-failure bug
   * station#1094 exists to close); it stays `status: 'error'` until an
   * explicit external signal calls `trigger()` (manual "Try now", the
   * browser regaining network, or a credential change — see
   * `useConnectionStatus`'s effects).
   */
  blocked: boolean;
  /** Device-local windows that crossed the sustained-failure banner threshold. */
  failureWindows: ReadonlyArray<{
    start: string;
    end: string;
    reason: ConnectionFailureReason;
  }>;
}

export type ConnectionHealthCheckResult =
  | boolean
  | { ok: true; bootId?: string }
  | { ok: false; reason: ConnectionFailureReason };

export interface ConnectionHealthCoordinatorOptions {
  endpoints: () => readonly AccessEndpoint[];
  compatibility: () => EndpointCompatibilityContext;
  check: (
    endpoint: AccessEndpoint,
    signal: AbortSignal,
  ) => Promise<ConnectionHealthCheckResult>;
  onSuccess?: (
    endpoint: AccessEndpoint,
    result: { ok: true; bootId?: string },
  ) => void;
  onFailure?: (reason: ConnectionFailureReason) => void;
  pollIntervalMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

const TRANSIENT_UNREACHABILITY_REASONS: ReadonlySet<ConnectionFailureReason> =
  new Set(['timeout', 'unreachable']);

export class ConnectionHealthCoordinator {
  private options: ConnectionHealthCoordinatorOptions;
  private listeners = new Set<() => void>();
  private snapshot: ConnectionHealthSnapshot = {
    status: 'connecting',
    checking: false,
    reason: null,
    failureStreak: 0,
    blocked: false,
    failureWindows: [],
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private windowOpen = false;
  private abortController: AbortController | null = null;
  private inFlight = false;
  private rerunRequested = false;
  private failureCount = 0;

  constructor(options: ConnectionHealthCoordinatorOptions) {
    this.options = options;
  }

  updateOptions(options: ConnectionHealthCoordinatorOptions): void {
    this.options = options;
  }

  getSnapshot = (): ConnectionHealthSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.trigger();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  trigger = (): void => {
    this.clearTimer();
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    void this.run();
  };

  stop(): void {
    this.clearTimer();
    this.abortController?.abort();
    this.abortController = null;
    this.rerunRequested = false;
  }

  private async run(): Promise<void> {
    if (this.listeners.size === 0) return;
    this.inFlight = true;
    const controller = new AbortController();
    this.abortController = controller;
    this.publish({ ...this.snapshot, checking: true });
    const selection = rankCompatibleEndpoints(
      this.options.endpoints(),
      this.options.compatibility(),
    );
    const compatible = selection.endpoints;
    // A managed loopback base is supervised by the native host; the browser
    // must not probe it and must trust the supervisor for liveness.
    if (
      compatible.length > 0 &&
      compatible.every((endpoint) => endpoint.kind === 'managed-loopback')
    ) {
      this.inFlight = false;
      if (this.abortController === controller) this.abortController = null;
      if (controller.signal.aborted || this.listeners.size === 0) return;
      this.failureCount = 0;
      this.publish({
        status: 'connected',
        checking: false,
        reason: null,
        failureStreak: 0,
        blocked: false,
        failureWindows: this.snapshot.failureWindows,
      });
      this.schedule(this.options.pollIntervalMs ?? 10_000);
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.trigger();
      }
      return;
    }
    let connected: AccessEndpoint | null = null;
    let success: { ok: true; bootId?: string } = { ok: true };
    // station#3297: every default in this method used to be 'unreachable',
    // which names a network condition. None of the three had observed one.
    // A run with no compatible endpoint and no classified incompatibility has
    // simply not learned anything yet.
    let reason: ConnectionFailureReason =
      selection.failures.values().next().value ?? 'undetermined';
    for (const endpoint of compatible) {
      try {
        const result = await this.options.check(endpoint, controller.signal);
        if (result === true || (typeof result === 'object' && result.ok)) {
          connected = endpoint;
          success = result === true ? { ok: true } : result;
          break;
        }
        // A bare `false` is a check that failed without saying why — the
        // shape `ConnectionManagerModal`'s own prop doc has warned about
        // since station#1094 ("a reachable Station that rejects the
        // credential answers 401, and reporting that as 'unreachable' sends
        // the user to check an address that is fine"). This is the site that
        // did it. Report the absence of a reason as one.
        reason =
          result === false || typeof result !== 'object'
            ? 'undetermined'
            : result.reason;
      } catch (error) {
        if (controller.signal.aborted) {
          this.inFlight = false;
          return;
        }
        // Both probes catch their own transport failures and return a reason,
        // so anything thrown past them is unrecognized — not evidence of an
        // unreachable host. A timeout is the one exception that identifies
        // itself.
        reason =
          error instanceof DOMException && error.name === 'TimeoutError'
            ? 'timeout'
            : 'undetermined';
      }
    }
    this.inFlight = false;
    if (this.abortController === controller) this.abortController = null;
    if (controller.signal.aborted || this.listeners.size === 0) return;
    if (connected) {
      this.failureCount = 0;
      this.options.onSuccess?.(connected, success);
      this.publish({
        status: 'connected',
        checking: false,
        reason: null,
        failureStreak: 0,
        blocked: false,
        failureWindows: this.closeFailureWindow(),
      });
      this.schedule(this.options.pollIntervalMs ?? 10_000);
    } else {
      this.failureCount += 1;
      this.options.onFailure?.(reason);
      // station#1094 R2/R4: a terminal failure (currently just
      // 'authentication-failed') stops the automatic retry ladder dead —
      // no schedule() call — so this coordinator never hot-loops against a
      // stale credential. It stays put until an explicit external signal
      // reaches trigger() (see the ConnectionHealthSnapshot.blocked doc).
      const blocked = classifyConnectionFailure(reason) === 'terminal';
      // timeout and unreachable are one transient-unreachability family: an
      // outage whose probes alternate between them must accumulate ONE
      // streak, or the banner threshold would reset on every alternation
      // and flicker (sol review of #2630, finding 4).
      const previousReason =
        this.snapshot.status === 'error' ? this.snapshot.reason : null;
      const continuesStreak =
        previousReason !== null &&
        (previousReason === reason ||
          (TRANSIENT_UNREACHABILITY_REASONS.has(previousReason) &&
            TRANSIENT_UNREACHABILITY_REASONS.has(reason)));
      const failureStreak = continuesStreak
        ? this.snapshot.failureStreak + 1
        : 1;
      let failureWindows: Array<{
        start: string;
        end: string;
        reason: ConnectionFailureReason;
      }> = [...this.snapshot.failureWindows];
      if (failureStreak === 3) {
        failureWindows = [
          ...failureWindows,
          {
            start: new Date().toISOString(),
            end: new Date().toISOString(),
            reason,
          },
        ].slice(-20);
        this.windowOpen = true;
      } else if (this.windowOpen) {
        // The outage continues past the threshold: keep the open window's
        // end current so a crash mid-outage still reads a truthful span.
        const last = failureWindows.at(-1);
        if (last)
          failureWindows[failureWindows.length - 1] = {
            ...last,
            end: new Date().toISOString(),
          };
      }
      this.publish({
        status: 'error',
        checking: false,
        reason,
        failureStreak,
        blocked,
        failureWindows,
      });
      if (!blocked) this.schedule(this.retryDelay());
    }
    if (this.rerunRequested) {
      this.rerunRequested = false;
      this.trigger();
    }
  }

  private retryDelay(): number {
    const base = this.options.baseRetryMs ?? 500;
    const cap = this.options.maxRetryMs ?? 10_000;
    const jitter = this.options.jitterRatio ?? 0.2;
    const raw = Math.min(cap, base * 2 ** Math.max(0, this.failureCount - 1));
    const random = this.options.random?.() ?? Math.random();
    return Math.round(raw * (1 - jitter + random * jitter * 2));
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(this.trigger, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private closeFailureWindow(): ReadonlyArray<{
    start: string;
    end: string;
    reason: ConnectionFailureReason;
  }> {
    // Only an OPEN window closes; ordinary successful polling after a
    // recovery must never rewrite a historical window's end (sol review,
    // finding 3).
    if (!this.windowOpen) return this.snapshot.failureWindows;
    this.windowOpen = false;
    const windows = [...this.snapshot.failureWindows];
    const last = windows.at(-1);
    if (last)
      windows[windows.length - 1] = { ...last, end: new Date().toISOString() };
    return windows;
  }

  private publish(snapshot: ConnectionHealthSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
