import type { StationProfile } from '@kontourai/station-contracts';

const HALF_LIFE_FRACTION = 0.5;
const MAX_RENEWAL_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_000, 10_000, 60_000] as const;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
export const MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE = 64;

export interface NativeRelayGrantRenewalStatus {
  profileName: string;
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
  profileRevision: number;
  grant: { expiresAt: number; lifetimeMs: number } | null;
}

export interface NativeRelayRouteSelection {
  profileName: string;
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
}

/** Injected boundary that keeps host DTO parsing outside the supervisor. */
export interface NativeRelayGrantRenewalAdapter {
  status(
    selection: NativeRelayRouteSelection,
  ): Promise<NativeRelayGrantRenewalStatus>;
  renew(input: {
    selection: NativeRelayRouteSelection;
    expectedProfileRevision: number;
  }): Promise<{ expiresAt: number; lifetimeMs: number }>;
}

export interface NativeRelayRouteProfileStorage {
  getRelayRouteProfiles(): readonly StationProfile[];
  subscribeRelayRouteProfiles(listener: () => void): () => void;
}

export interface NativeRelayGrantRenewalIssue {
  kind: 'route-limit';
  routeCount: number;
  maxRoutes: number;
}

type Timer = ReturnType<typeof setTimeout>;
type WorkKind = 'status' | 'renew';

interface RouteEntry {
  key: string;
  fingerprint: string;
  selection: NativeRelayRouteSelection;
  generation: number;
  profileUpdatedAt: number;
  profileRevision?: number;
  expiresAt?: number;
  lifetimeMs?: number;
  retryKey?: string;
  retryCount: number;
  nextAt?: number;
  nextKind?: WorkKind;
}

interface RefreshWaiter {
  promise: Promise<void>;
  resolve: () => void;
}

function connectionId(profile: StationProfile): string {
  return `station-profile:${profile.name.toLowerCase()}`;
}

function routeFingerprint(profile: StationProfile): string | null {
  if (!profile.relayRoute) return null;
  return [
    profile.name.toLowerCase(),
    profile.updatedAt,
    profile.relayRoute.brokerOrigin,
    profile.relayRoute.stationId,
    profile.relayRoute.enrollmentId,
  ].join('\u0000');
}

function routeSelection(profile: StationProfile): NativeRelayRouteSelection {
  if (!profile.relayRoute)
    throw new Error('Native relay route profile is required.');
  return {
    profileName: profile.name,
    brokerOrigin: profile.relayRoute.brokerOrigin,
    stationId: profile.relayRoute.stationId,
    enrollmentId: profile.relayRoute.enrollmentId,
  };
}

function validStatus(
  value: NativeRelayGrantRenewalStatus,
  expected: NativeRelayRouteSelection,
): boolean {
  return (
    value.profileName === expected.profileName &&
    value.brokerOrigin === expected.brokerOrigin &&
    value.stationId === expected.stationId &&
    value.enrollmentId === expected.enrollmentId &&
    Number.isSafeInteger(value.profileRevision) &&
    value.profileRevision > 0 &&
    (value.grant === null ||
      (Number.isSafeInteger(value.grant.expiresAt) &&
        value.grant.expiresAt > 0 &&
        Number.isSafeInteger(value.grant.lifetimeMs) &&
        value.grant.lifetimeMs > 0))
  );
}

/**
 * Supervises every saved relay route independently of ConnectionStore. It
 * renews only routes whose host status already proves a single grant exists;
 * this coordinator never redeems or approves a route.
 */
export class NativeRelayGrantRenewalSupervisor {
  private started = false;
  private timer: Timer | undefined;
  private unsubscribeProfiles: (() => void) | undefined;
  private readonly routes = new Map<string, RouteEntry>();
  private nextGeneration = 0;
  private fairCursor: string | undefined;
  private processing: Promise<void> | undefined;
  private refreshRequested = false;
  private refreshWaiter: RefreshWaiter | undefined;
  private issue: NativeRelayGrantRenewalIssue | undefined;

  private readonly onWake = () => {
    if (this.isVisible()) void this.refresh();
  };
  private readonly onProfilesChanged = () => this.reconcileProfiles();

  constructor(
    private readonly storage: NativeRelayRouteProfileStorage,
    private readonly adapter: NativeRelayGrantRenewalAdapter,
    private readonly events:
      | Pick<Window, 'addEventListener' | 'removeEventListener'>
      | undefined = typeof window === 'undefined' ? undefined : window,
    private readonly now: () => number = Date.now,
    private readonly isVisible: () => boolean = () =>
      typeof document === 'undefined' || document.visibilityState === 'visible',
    private readonly visibilityEvents:
      | Pick<Document, 'addEventListener' | 'removeEventListener'>
      | undefined = typeof document === 'undefined' ? undefined : document,
    private readonly onIssue: (
      issue: NativeRelayGrantRenewalIssue | null,
    ) => void = () => undefined,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeProfiles = this.storage.subscribeRelayRouteProfiles(
      this.onProfilesChanged,
    );
    this.events?.addEventListener('online', this.onWake);
    this.events?.addEventListener('focus', this.onWake);
    this.events?.addEventListener('pageshow', this.onWake);
    this.visibilityEvents?.addEventListener('visibilitychange', this.onWake);
    this.reconcileProfiles();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clearTimer();
    this.unsubscribeProfiles?.();
    this.unsubscribeProfiles = undefined;
    this.events?.removeEventListener('online', this.onWake);
    this.events?.removeEventListener('focus', this.onWake);
    this.events?.removeEventListener('pageshow', this.onWake);
    this.visibilityEvents?.removeEventListener('visibilitychange', this.onWake);
    this.routes.clear();
    this.refreshRequested = false;
    this.resolveRefreshWaiter();
  }

  getIssue(): NativeRelayGrantRenewalIssue | null {
    return this.issue ?? null;
  }

  /** Recheck every saved route, including after explicit grant redemption. */
  refresh(): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.refreshRequested = true;
    if (!this.refreshWaiter) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => (resolve = done));
      this.refreshWaiter = { promise, resolve };
    }
    // Mark the refresh before reconciliation can start the pump. Otherwise a
    // due cached renewal can run ahead of the fresh host status observation.
    this.reconcileProfiles(false);
    if (this.issue) return this.refreshWaiter?.promise ?? Promise.resolve();
    this.startPumpIfNeeded();
    return this.refreshWaiter.promise;
  }

  private reconcileProfiles(triggerRefresh = true): void {
    if (!this.started) return;
    const profiles = this.storage.getRelayRouteProfiles();
    if (profiles.length > MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE) {
      const changed =
        this.issue?.routeCount !== profiles.length ||
        this.issue?.maxRoutes !== MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE;
      this.issue = {
        kind: 'route-limit',
        routeCount: profiles.length,
        maxRoutes: MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE,
      };
      this.routes.clear();
      this.refreshRequested = false;
      this.clearTimer();
      if (changed) this.onIssue(this.issue);
      this.resolveRefreshWaiter();
      return;
    }

    if (this.issue) {
      this.issue = undefined;
      this.onIssue(null);
    }

    const next = new Map<
      string,
      { profile: StationProfile; fingerprint: string }
    >();
    for (const profile of profiles) {
      const fingerprint = routeFingerprint(profile);
      if (fingerprint === null) continue;
      next.set(connectionId(profile), { profile, fingerprint });
    }

    let changed = false;
    for (const [key, entry] of this.routes) {
      if (next.get(key)?.fingerprint !== entry.fingerprint) {
        this.routes.delete(key);
        changed = true;
      }
    }
    for (const [key, { profile, fingerprint }] of next) {
      if (this.routes.has(key)) continue;
      this.routes.set(key, {
        key,
        fingerprint,
        selection: routeSelection(profile),
        generation: ++this.nextGeneration,
        profileUpdatedAt: profile.updatedAt,
        retryCount: 0,
        nextAt: this.now(),
        nextKind: 'status',
      });
      changed = true;
    }
    if (changed && triggerRefresh && this.started) {
      this.refreshRequested = true;
      if (!this.refreshWaiter) {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => (resolve = done));
        this.refreshWaiter = { promise, resolve };
      }
    }
    this.startPumpIfNeeded();
    this.scheduleTimer();
  }

  private startPumpIfNeeded(): void {
    if (
      this.processing ||
      !this.started ||
      !this.isVisible() ||
      this.issue ||
      (!this.refreshRequested && !this.hasDueWork())
    ) {
      return;
    }
    // Publish pump ownership before calling an adapter. A synchronous wake
    // event inside its first status() call must join this pump, not start a
    // second renewal drain before `processing` has been assigned.
    const operation = Promise.resolve().then(() => this.drain());
    this.processing = operation;
    void operation.then(
      () => this.finishPump(operation),
      () => this.finishPump(operation),
    );
  }

  private async drain(): Promise<void> {
    while (this.started && this.isVisible() && !this.issue) {
      if (this.refreshRequested) {
        this.refreshRequested = false;
        for (const entry of this.sortedRoutes()) {
          if (!this.started || !this.isVisible()) break;
          if (!this.isCurrent(entry)) continue;
          await this.observeStatus(entry);
          // Wake events may arrive throughout a long inventory scan. Give a
          // due route one turn after each observation so repeated refreshes
          // cannot postpone renewal indefinitely.
          const due = this.nextFairRoute(this.dueRoutes());
          if (due) {
            this.fairCursor = due.key;
            await this.processDueWork(due);
          }
        }
        continue;
      }
      const due = this.dueRoutes();
      const next = this.nextFairRoute(due);
      if (!next) break;
      this.fairCursor = next.key;
      await this.processDueWork(next);
    }
  }

  private async observeStatus(entry: RouteEntry): Promise<void> {
    try {
      const status = await this.adapter.status(entry.selection);
      if (!this.isCurrent(entry)) return;
      if (!validStatus(status, entry.selection)) {
        this.scheduleFailure(entry, 'status');
        return;
      }
      if (!status.grant) {
        entry.profileRevision = status.profileRevision;
        entry.expiresAt = undefined;
        entry.lifetimeMs = undefined;
        entry.retryKey = undefined;
        entry.retryCount = 0;
        entry.nextAt = undefined;
        entry.nextKind = undefined;
        return;
      }
      const retryKey = `${entry.fingerprint}:${status.profileRevision}:${status.grant.expiresAt}`;
      if (entry.retryKey !== retryKey) {
        entry.retryKey = retryKey;
        entry.retryCount = 0;
      }
      entry.profileRevision = status.profileRevision;
      entry.expiresAt = status.grant.expiresAt;
      entry.lifetimeMs = status.grant.lifetimeMs;
      entry.nextAt = Math.max(
        0,
        status.grant.expiresAt - status.grant.lifetimeMs * HALF_LIFE_FRACTION,
      );
      entry.nextKind = 'renew';
    } catch {
      if (this.isCurrent(entry)) this.scheduleFailure(entry, 'status');
    }
  }

  private async processDueWork(entry: RouteEntry): Promise<void> {
    if (!this.isVisible() || !this.isCurrent(entry) || !entry.nextKind) return;
    if (entry.nextKind === 'status') {
      await this.observeStatus(entry);
      return;
    }
    // Timers can be hours old. A removed, replaced, or revoked grant must be
    // observed from host custody immediately before asking it to renew.
    await this.observeStatus(entry);
    if (
      !this.isVisible() ||
      !this.isCurrent(entry) ||
      entry.nextKind !== 'renew' ||
      entry.nextAt === undefined ||
      entry.nextAt > this.now()
    ) {
      return;
    }
    if (
      entry.profileRevision === undefined ||
      entry.expiresAt === undefined ||
      entry.lifetimeMs === undefined
    ) {
      entry.nextKind = 'status';
      entry.nextAt = this.now();
      return;
    }
    const oldRetryKey = entry.retryKey;
    try {
      const renewed = await this.adapter.renew({
        selection: entry.selection,
        expectedProfileRevision: entry.profileRevision,
      });
      if (!this.isCurrent(entry)) return;
      if (
        !Number.isSafeInteger(renewed?.expiresAt) ||
        renewed.expiresAt <= this.now() ||
        !Number.isSafeInteger(renewed.lifetimeMs) ||
        renewed.lifetimeMs <= 0
      ) {
        throw new Error('Invalid native relay grant renewal receipt.');
      }
      entry.expiresAt = renewed.expiresAt;
      entry.lifetimeMs = renewed.lifetimeMs;
      entry.retryKey = `${entry.fingerprint}:${entry.profileRevision}:${renewed.expiresAt}`;
      entry.retryCount = 0;
      entry.nextAt = Math.max(
        0,
        renewed.expiresAt - renewed.lifetimeMs * HALF_LIFE_FRACTION,
      );
      entry.nextKind = 'renew';
    } catch {
      if (!this.isCurrent(entry)) return;
      entry.retryKey = oldRetryKey;
      this.scheduleFailure(entry, 'status');
    }
  }

  private scheduleFailure(entry: RouteEntry, retryKind: WorkKind): void {
    if (entry.retryCount >= MAX_RENEWAL_ATTEMPTS) {
      entry.nextAt = undefined;
      entry.nextKind = undefined;
      return;
    }
    const delay = RETRY_BACKOFF_MS[entry.retryCount];
    entry.retryCount += 1;
    entry.nextAt = this.now() + delay;
    entry.nextKind = retryKind;
  }

  private dueRoutes(): RouteEntry[] {
    const current = this.now();
    return [...this.routes.values()].filter(
      (entry) => entry.nextAt !== undefined && entry.nextAt <= current,
    );
  }

  private nextFairRoute(due: RouteEntry[]): RouteEntry | undefined {
    if (due.length === 0) return undefined;
    const earliest = Math.min(...due.map((entry) => entry.nextAt!));
    const candidates = due
      .filter((entry) => entry.nextAt === earliest)
      .sort((left, right) => left.key.localeCompare(right.key));
    if (!this.fairCursor) return candidates[0];
    return (
      candidates.find(
        (entry) => entry.key.localeCompare(this.fairCursor!) > 0,
      ) ?? candidates[0]
    );
  }

  private hasDueWork(): boolean {
    return this.dueRoutes().length > 0;
  }

  private sortedRoutes(): RouteEntry[] {
    return [...this.routes.values()].sort((left, right) =>
      left.key.localeCompare(right.key),
    );
  }

  private isCurrent(entry: RouteEntry): boolean {
    if (!this.started || this.routes.get(entry.key) !== entry) return false;
    const profile = this.storage
      .getRelayRouteProfiles()
      .find((candidate) => connectionId(candidate) === entry.key);
    return (
      profile !== undefined && routeFingerprint(profile) === entry.fingerprint
    );
  }

  private finishPump(operation: Promise<void>): void {
    if (this.processing !== operation) return;
    this.processing = undefined;
    if (
      this.started &&
      this.isVisible() &&
      !this.issue &&
      (this.refreshRequested || this.hasDueWork())
    ) {
      this.startPumpIfNeeded();
      return;
    }
    this.scheduleTimer();
    this.resolveRefreshWaiter();
  }

  private scheduleTimer(): void {
    this.clearTimer();
    if (!this.started || this.issue) return;
    const nextAt = [...this.routes.values()]
      .map((entry) => entry.nextAt)
      .filter((value): value is number => value !== undefined)
      .reduce<number | undefined>(
        (earliest, value) =>
          earliest === undefined ? value : Math.min(earliest, value),
        undefined,
      );
    if (nextAt === undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.startPumpIfNeeded();
      },
      Math.min(Math.max(0, nextAt - this.now()), MAX_TIMER_DELAY_MS),
    );
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private resolveRefreshWaiter(): void {
    const waiter = this.refreshWaiter;
    this.refreshWaiter = undefined;
    waiter?.resolve();
  }
}
