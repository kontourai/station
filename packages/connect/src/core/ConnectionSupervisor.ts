/**
 * Per-environment connection supervisor state machine (station#1094).
 *
 * One owner for connection desired-state and retry policy: a single
 * environment connection is always in exactly one of six explicit states,
 * driven by typed signals rather than ad hoc booleans scattered across
 * hooks. This module is intentionally transport-agnostic — it knows nothing
 * about HTTP, SSE, or WebSockets. A caller supplies one `attempt` function
 * (open the transport and confirm the first handshake/config fetch) and the
 * supervisor owns everything about *when* that function runs again.
 *
 * States:
 * - `available`  — registered, connection not currently wanted.
 * - `connecting` — one attempt is in flight.
 * - `connected`  — the attempt succeeded (transport open AND the first
 *                  handshake/config fetch confirmed). Data-sync health is a
 *                  SEPARATE dimension (see `sync` on the snapshot) — a
 *                  healthy transport with a failed subscription stays
 *                  `connected` with `sync: 'error'`, never regresses to
 *                  `connecting`.
 * - `backoff`    — the last attempt failed transiently; a retry is
 *                  scheduled on the ladder below.
 * - `blocked`    — the last attempt failed terminally (bad credential,
 *                  incompatible protocol/config). No further attempts are
 *                  scheduled — this is the fix for the "hot loop on auth
 *                  failures" problem station#1094 exists to close. Only an
 *                  explicit external signal (`credentialChanged`,
 *                  `retryRequested`, or `networkChanged`) resumes it.
 * - `offline`    — the caller has told the supervisor the device has no
 *                  network. No attempts are made until `networkChanged`
 *                  reports `online: true` again.
 *
 * Single retry owner: on a transient failure the supervisor schedules
 * exactly one retry on a 1s/2s/4s/8s/16s ladder (capped at 16s); the ladder
 * resets to its first rung after `stableMs` (default 30s) of uninterrupted
 * `connected` time. The `attempt` function passed in must not retry
 * internally — it gets exactly one try per tick, and the supervisor is the
 * only thing that ever schedules the next one.
 *
 * Wake probing: while `connected`, a `wakeup` signal (the app/tab became
 * active again, e.g. after laptop sleep) runs a lightweight `probe` — not a
 * full reconnect — to catch a half-dead socket the OS never told us about.
 * A failed probe drops straight back into the normal `connecting` cycle.
 */

export type ConnectionSupervisorState =
  | 'available'
  | 'connecting'
  | 'connected'
  | 'backoff'
  | 'blocked'
  | 'offline';

/**
 * Transient failures (network errors, 5xx, timeouts) are retried on the
 * backoff ladder. Terminal failures (401/403, config/protocol mismatches)
 * never retry automatically — see the `blocked` state above.
 */
export type FailureClassification = 'transient' | 'terminal';

/** Data-sync health is tracked independently of connection state. */
export type SyncStatus = 'idle' | 'ok' | 'error';

export type ConnectionAttemptResult =
  | { ok: true }
  | { ok: false; classification: FailureClassification; reason?: string };

export type ConnectionSupervisorSignal =
  | { type: 'connectRequested' }
  | { type: 'disconnectRequested' }
  | { type: 'retryRequested' }
  | { type: 'networkChanged'; online: boolean }
  | { type: 'wakeup' }
  | { type: 'credentialChanged' }
  | { type: 'attemptSucceeded' }
  | {
      type: 'attemptFailed';
      classification: FailureClassification;
      reason?: string;
    }
  | { type: 'transportClosed' };

export interface ConnectionSupervisorSnapshot {
  state: ConnectionSupervisorState;
  sync: SyncStatus;
  syncDetail?: string;
  /** Number of consecutive transient failures since the last stable connect. */
  retryCount: number;
  /** Epoch ms of the scheduled retry, or null when nothing is scheduled. */
  nextRetryAt: number | null;
  /** Detail from the most recent failed attempt, cleared on success. */
  failureReason?: string;
}

export interface ConnectionSupervisorTelemetryEvent {
  id?: string;
  from: ConnectionSupervisorState;
  to: ConnectionSupervisorState;
  signal: ConnectionSupervisorSignal['type'];
  retryCount: number;
}

export interface ConnectionSupervisorOptions {
  /**
   * Optional label (e.g. environment id) carried through to telemetry only.
   * A registry keyed by this id — one supervisor per environment — is
   * future work (station#1096); this constructor takes plain options so
   * building that registry is a thin wrapper, not a rewrite.
   */
  id?: string;
  /**
   * One connection attempt: open the transport and confirm the first
   * handshake/config fetch. Must settle exactly once per call and must not
   * retry internally — the supervisor is the sole retry owner.
   */
  attempt: (signal: AbortSignal) => Promise<ConnectionAttemptResult>;
  /**
   * Lightweight liveness probe used only from the `connected` state after a
   * `wakeup` signal. Defaults to re-running `attempt` when omitted.
   */
  probe?: (signal: AbortSignal) => Promise<boolean>;
  /** Backoff ladder in ms, one rung per consecutive transient failure. */
  ladderMs?: number[];
  /** Stable-connection duration before the ladder resets to its first rung. */
  stableMs?: number;
  /** Jitter ratio applied to each ladder rung (0..1). Default 0.2. */
  jitterRatio?: number;
  /** Jitter source, defaults to Math.random. Injectable for deterministic tests. */
  random?: () => number;
  /** Clock, defaults to Date.now. Injectable for deterministic tests. */
  now?: () => number;
  telemetry?: (event: ConnectionSupervisorTelemetryEvent) => void;
}

const DEFAULT_LADDER_MS = [1000, 2000, 4000, 8000, 16000];
const DEFAULT_STABLE_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;

export class ConnectionSupervisor {
  private opts: ConnectionSupervisorOptions;
  readonly id: string | undefined;
  private listeners = new Set<() => void>();
  private snapshotValue: ConnectionSupervisorSnapshot = {
    state: 'available',
    sync: 'idle',
    retryCount: 0,
    nextRetryAt: null,
  };
  private online = true;
  private desired = false;
  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every teardown so stale attempt/probe completions are ignored. */
  private generation = 0;

  constructor(options: ConnectionSupervisorOptions) {
    this.opts = options;
    this.id = options.id;
  }

  /** Swap callbacks/tuning without resetting in-flight state (mirrors ConnectionHealthCoordinator). */
  updateOptions(options: ConnectionSupervisorOptions): void {
    this.opts = options;
  }

  getSnapshot = (): ConnectionSupervisorSnapshot => this.snapshotValue;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // ---- public signal entry points ----

  connect = (): void => this.dispatch({ type: 'connectRequested' });
  disconnect = (): void => this.dispatch({ type: 'disconnectRequested' });
  retry = (): void => this.dispatch({ type: 'retryRequested' });
  reportNetworkChange = (online: boolean): void =>
    this.dispatch({ type: 'networkChanged', online });
  reportWakeup = (): void => this.dispatch({ type: 'wakeup' });
  reportCredentialChanged = (): void =>
    this.dispatch({ type: 'credentialChanged' });
  reportTransportClosed = (): void =>
    this.dispatch({ type: 'transportClosed' });

  /**
   * Data-sync health is a separate dimension from connection state — it
   * never feeds back into the state machine. A healthy transport with a
   * failed subscription stays `connected` with `sync: 'error'`.
   */
  reportSyncStatus = (
    sync: Exclude<SyncStatus, 'idle'>,
    detail?: string,
  ): void => {
    this.setState({ sync, syncDetail: detail });
  };

  /**
   * Stops any pending timer/attempt and reports an honest idle snapshot —
   * for unmount cleanup. `teardown()` alone cancels the real timer/attempt,
   * but left the snapshot claiming whatever state it was in (e.g. `backoff`
   * with a live-looking `nextRetryAt` that will now never fire — station#1094
   * review). Mirrors `disconnectRequested`'s snapshot shape without asserting
   * this was a user-initiated disconnect.
   */
  dispose(): void {
    this.desired = false;
    this.teardown();
    this.setState({
      state: 'available',
      retryCount: 0,
      nextRetryAt: null,
      sync: 'idle',
      syncDetail: undefined,
      failureReason: undefined,
    });
  }

  dispatch = (signal: ConnectionSupervisorSignal): void => {
    const from = this.snapshotValue.state;
    this.apply(signal, from);
    const to = this.snapshotValue.state;
    if (to !== from) {
      this.opts.telemetry?.({
        id: this.id,
        from,
        to,
        signal: signal.type,
        retryCount: this.snapshotValue.retryCount,
      });
    }
  };

  private apply(
    signal: ConnectionSupervisorSignal,
    from: ConnectionSupervisorState,
  ): void {
    switch (signal.type) {
      case 'connectRequested':
        this.desired = true;
        if (from === 'connecting' || from === 'connected') return;
        this.startCycle();
        return;

      case 'disconnectRequested':
        this.desired = false;
        this.teardown();
        this.setState({
          state: 'available',
          retryCount: 0,
          nextRetryAt: null,
          sync: 'idle',
          syncDetail: undefined,
          failureReason: undefined,
        });
        return;

      case 'retryRequested':
        if (from === 'backoff' || from === 'blocked') this.startCycle();
        return;

      case 'wakeup':
        if (from === 'connected') this.startWakeProbe();
        else if (from === 'backoff') this.startCycle();
        // 'blocked' is deliberately NOT woken by `wakeup` alone — only
        // credentialChanged/retryRequested/networkChanged escape it, so a
        // recurring app-active event can never turn into a hot loop on a
        // terminal auth failure.
        return;

      case 'credentialChanged':
        if (from === 'blocked') {
          this.setState({ retryCount: 0 });
          this.startCycle();
        } else if (from === 'backoff' || from === 'connecting') {
          // `connecting` case (station#1094 review): an attempt already in
          // flight was almost certainly built with the stale credential.
          // startCycle() tears down first — bumping the generation aborts
          // that in-flight attempt's controller and invalidates its eventual
          // result (the `myGeneration !== this.generation` guard below), so
          // a late resolve/reject can never clobber the fresh attempt this
          // starts with the new credential.
          this.startCycle();
        }
        return;

      case 'networkChanged':
        this.online = signal.online;
        if (!signal.online) {
          if (this.desired && from !== 'blocked' && from !== 'offline') {
            this.teardown();
            this.setState({
              state: 'offline',
              nextRetryAt: null,
              sync: 'idle',
            });
          }
        } else if (this.desired && (from === 'offline' || from === 'blocked')) {
          this.startCycle();
        }
        return;

      case 'transportClosed':
        if (from === 'connected') {
          this.clearStabilityTimer();
          this.startCycle();
        }
        return;

      case 'attemptSucceeded':
        if (from !== 'connecting') return;
        this.controller = null;
        this.setState({
          state: 'connected',
          sync: 'ok',
          syncDetail: undefined,
          nextRetryAt: null,
          failureReason: undefined,
        });
        this.armStabilityTimer();
        return;

      case 'attemptFailed':
        if (from !== 'connecting') return;
        this.controller = null;
        this.onAttemptFailed(signal.classification, signal.reason);
        return;

      default:
        return;
    }
  }

  private onAttemptFailed(
    classification: FailureClassification,
    reason: string | undefined,
  ): void {
    if (classification === 'terminal') {
      this.setState({
        state: 'blocked',
        nextRetryAt: null,
        sync: 'idle',
        failureReason: reason,
      });
      return;
    }
    const nextCount = this.snapshotValue.retryCount + 1;
    const ladder = this.opts.ladderMs ?? DEFAULT_LADDER_MS;
    const base = ladder[Math.min(nextCount - 1, ladder.length - 1)];
    const jitterRatio = this.opts.jitterRatio ?? DEFAULT_JITTER_RATIO;
    const random = this.opts.random?.() ?? Math.random();
    const delay = Math.round(
      base * (1 - jitterRatio + random * jitterRatio * 2),
    );
    const now = this.opts.now?.() ?? Date.now();
    this.setState({
      state: 'backoff',
      retryCount: nextCount,
      nextRetryAt: now + delay,
      sync: 'idle',
      failureReason: reason,
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.desired) this.startCycle();
    }, delay);
  }

  private startCycle(): void {
    this.teardown();
    if (!this.online) {
      this.setState({ state: 'offline', nextRetryAt: null, sync: 'idle' });
      return;
    }
    this.setState({ state: 'connecting', nextRetryAt: null, sync: 'idle' });
    const myGeneration = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.opts.attempt(controller.signal).then(
      (result) => {
        if (myGeneration !== this.generation) return; // superseded
        if (result.ok) this.dispatch({ type: 'attemptSucceeded' });
        else {
          this.dispatch({
            type: 'attemptFailed',
            classification: result.classification,
            reason: result.reason,
          });
        }
      },
      (error: unknown) => {
        if (myGeneration !== this.generation || controller.signal.aborted)
          return;
        // An unclassified rejection is treated as transient — never
        // silently escalate an unexpected throw into a permanent block.
        this.dispatch({
          type: 'attemptFailed',
          classification: 'transient',
          reason: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  private startWakeProbe(): void {
    const probeFn =
      this.opts.probe ??
      ((signal: AbortSignal) => this.opts.attempt(signal).then((r) => r.ok));
    const controller = new AbortController();
    const generationAtStart = this.generation;
    const stillLive = () =>
      this.generation === generationAtStart &&
      this.snapshotValue.state === 'connected';
    probeFn(controller.signal).then(
      (ok) => {
        if (!stillLive()) return; // raced by a disconnect/transportClosed/etc.
        if (!ok) this.startCycle();
      },
      () => {
        if (!stillLive()) return;
        this.startCycle();
      },
    );
  }

  private armStabilityTimer(): void {
    this.clearStabilityTimer();
    const stableMs = this.opts.stableMs ?? DEFAULT_STABLE_MS;
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      if (this.snapshotValue.state === 'connected') {
        this.setState({ retryCount: 0 });
      }
    }, stableMs);
  }

  private teardown(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.clearRetryTimer();
    this.clearStabilityTimer();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = null;
  }

  private setState(patch: Partial<ConnectionSupervisorSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    for (const listener of this.listeners) listener();
  }
}
