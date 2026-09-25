import {
  FOCUS_PRESENCE_LEASE_MS,
  type FocusSnapshot,
  type FocusState,
  type FocusSurfaceSnapshot,
  type SurfaceId,
} from '@kontourai/station-contracts/presence';

/**
 * Process-local, non-durable focus presence (#2585).
 *
 * A surface is a paired device or a local-operator client session. One
 * device can hold several documents (tabs, the app plus a browser), so each
 * surface keeps its reports per client session and reconciles them on read:
 * one focused tab makes the device focused whatever its other tabs say.
 *
 * Everything is bounded: surfaces, sessions per surface, and the report rate
 * per surface. A report older than the lease reads as absent — a client that
 * closed or froze without saying so stops counting as present on its own.
 */

const FOCUS_SURFACE_CAPACITY = 256;
const FOCUS_SESSIONS_PER_SURFACE_CAPACITY = 16;
/** Debounced changes plus a 60 s heartbeat stay far below this. */
const FOCUS_REPORTS_PER_WINDOW = 30;
const FOCUS_REPORT_WINDOW_MS = 60_000;

const STATE_RANK: Readonly<Record<FocusState, number>> = {
  hidden: 0,
  visible: 1,
  focused: 2,
};

/**
 * Who is reporting, as the route derived it from the authenticated caller.
 * `local` carries the reporting document's client session id because a local
 * operator surface IS that document; a device surface is the whole device.
 */
export type FocusReporter =
  | { readonly kind: 'device'; readonly deviceId: string }
  | { readonly kind: 'local'; readonly clientSessionId: string };

export type FocusReportResult =
  | { readonly accepted: true; readonly surfaceId: SurfaceId }
  | { readonly accepted: false; readonly retryAfterMs: number };

export interface FocusPresenceOptions {
  readonly now?: () => number;
  readonly leaseMs?: number;
  readonly capacity?: number;
  readonly sessionsPerSurface?: number;
  readonly reportsPerWindow?: number;
  readonly reportWindowMs?: number;
}

interface SessionReport {
  state: FocusState;
  reportedAt: number;
}

interface SurfaceRecord {
  readonly sessions: Map<string, SessionReport>;
  lastReportAt: number;
  windowStartedAt: number;
  windowCount: number;
}

export function focusSurfaceId(reporter: FocusReporter): SurfaceId {
  return reporter.kind === 'device'
    ? `device:${reporter.deviceId}`
    : `local:${reporter.clientSessionId}`;
}

export class FocusPresence {
  readonly #surfaces = new Map<SurfaceId, SurfaceRecord>();
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #capacity: number;
  readonly #sessionsPerSurface: number;
  readonly #reportsPerWindow: number;
  readonly #reportWindowMs: number;

  constructor(options: FocusPresenceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? FOCUS_PRESENCE_LEASE_MS;
    this.#capacity = options.capacity ?? FOCUS_SURFACE_CAPACITY;
    this.#sessionsPerSurface =
      options.sessionsPerSurface ?? FOCUS_SESSIONS_PER_SURFACE_CAPACITY;
    this.#reportsPerWindow =
      options.reportsPerWindow ?? FOCUS_REPORTS_PER_WINDOW;
    this.#reportWindowMs = options.reportWindowMs ?? FOCUS_REPORT_WINDOW_MS;
  }

  report(
    reporter: FocusReporter,
    clientSessionId: string,
    state: FocusState,
  ): FocusReportResult {
    const now = this.#now();
    this.#expire(now);
    const surfaceId = focusSurfaceId(reporter);
    let surface = this.#surfaces.get(surfaceId);
    if (surface) {
      if (now - surface.windowStartedAt >= this.#reportWindowMs) {
        surface.windowStartedAt = now;
        surface.windowCount = 0;
      }
      if (surface.windowCount >= this.#reportsPerWindow) {
        return {
          accepted: false,
          retryAfterMs: surface.windowStartedAt + this.#reportWindowMs - now,
        };
      }
    } else {
      if (this.#surfaces.size >= this.#capacity) this.#evictOldestSurface();
      surface = {
        sessions: new Map(),
        lastReportAt: now,
        windowStartedAt: now,
        windowCount: 0,
      };
      this.#surfaces.set(surfaceId, surface);
    }
    surface.windowCount += 1;
    surface.lastReportAt = now;
    if (
      !surface.sessions.has(clientSessionId) &&
      surface.sessions.size >= this.#sessionsPerSurface
    ) {
      evictOldestSession(surface.sessions);
    }
    // Re-insert so Map order stays oldest-report-first for eviction.
    surface.sessions.delete(clientSessionId);
    surface.sessions.set(clientSessionId, { state, reportedAt: now });
    return { accepted: true, surfaceId };
  }

  /** Unexpired surfaces, optionally restricted to `surfaceIds`. */
  snapshot(surfaceIds?: readonly SurfaceId[]): FocusSnapshot {
    this.#expire(this.#now());
    const result = new Map<SurfaceId, FocusSurfaceSnapshot>();
    const ids = surfaceIds ?? [...this.#surfaces.keys()];
    for (const surfaceId of ids) {
      const surface = this.#surfaces.get(surfaceId);
      if (!surface) continue;
      let best: SessionReport | undefined;
      for (const report of surface.sessions.values()) {
        if (
          !best ||
          STATE_RANK[report.state] > STATE_RANK[best.state] ||
          (report.state === best.state && report.reportedAt > best.reportedAt)
        ) {
          best = report;
        }
      }
      if (best) {
        result.set(surfaceId, {
          surfaceId,
          state: best.state,
          reportedAt: best.reportedAt,
        });
      }
    }
    return result;
  }

  isAnyFocused(surfaceIds: readonly SurfaceId[]): boolean {
    for (const entry of this.snapshot(surfaceIds).values()) {
      if (entry.state === 'focused') return true;
    }
    return false;
  }

  #expire(now: number): void {
    const cutoff = now - this.#leaseMs;
    for (const [surfaceId, surface] of this.#surfaces) {
      for (const [sessionId, report] of surface.sessions) {
        if (report.reportedAt <= cutoff) surface.sessions.delete(sessionId);
      }
      if (!surface.sessions.size) this.#surfaces.delete(surfaceId);
    }
  }

  #evictOldestSurface(): void {
    let oldestId: SurfaceId | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [surfaceId, surface] of this.#surfaces) {
      if (surface.lastReportAt < oldestAt) {
        oldestAt = surface.lastReportAt;
        oldestId = surfaceId;
      }
    }
    if (oldestId) this.#surfaces.delete(oldestId);
  }
}

function evictOldestSession(sessions: Map<string, SessionReport>): void {
  const oldest = sessions.keys().next();
  if (!oldest.done) sessions.delete(oldest.value);
}
