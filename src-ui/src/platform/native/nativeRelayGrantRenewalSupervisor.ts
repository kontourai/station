import type { StationProfile } from '@kontourai/station-contracts';

/** The renderer's active connection pointer, maintained by ConnectionStore. */
const ACTIVE_CONNECTION_KEY = 'station-connect-connections-active';
const HALF_LIFE_FRACTION = 0.5;
const MAX_RENEWAL_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_000, 10_000, 60_000] as const;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export interface NativeRelayGrantRenewalStatus {
  profileName: string;
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
  /** Host-owned revision required by the renewal command. */
  profileRevision: number;
  /** Null means this route has no currently renewable grant. */
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
  subscribeActiveConnection(listener: () => void): () => void;
  get(key: string): string | null;
}

type Timer = ReturnType<typeof setTimeout>;

interface SelectedRoute {
  profile: StationProfile;
  connectionId: string;
  updatedAt: number;
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
}

function selectionFrom(
  storage: NativeRelayRouteProfileStorage,
): SelectedRoute | null {
  const connectionId = storage.get(ACTIVE_CONNECTION_KEY);
  if (!connectionId) return null;
  const profile = storage
    .getRelayRouteProfiles()
    .find(
      (candidate) =>
        `station-profile:${candidate.name.toLowerCase()}` === connectionId,
    );
  if (!profile?.relayRoute) return null;
  return {
    profile,
    connectionId,
    updatedAt: profile.updatedAt,
    brokerOrigin: profile.relayRoute.brokerOrigin,
    stationId: profile.relayRoute.stationId,
    enrollmentId: profile.relayRoute.enrollmentId,
  };
}

function sameSelection(
  left: SelectedRoute | null,
  right: SelectedRoute | null,
): boolean {
  return Boolean(
    left &&
      right &&
      left.connectionId === right.connectionId &&
      left.updatedAt === right.updatedAt &&
      left.brokerOrigin === right.brokerOrigin &&
      left.stationId === right.stationId &&
      left.enrollmentId === right.enrollmentId,
  );
}

function validStatus(
  value: NativeRelayGrantRenewalStatus,
  selected: SelectedRoute,
): boolean {
  return (
    value.profileName === selected.profile.name &&
    value.brokerOrigin === selected.brokerOrigin &&
    value.stationId === selected.stationId &&
    value.enrollmentId === selected.enrollmentId &&
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
 * Renews only the selected saved native relay route. This coordinator owns
 * timers and wake observation; host status and renewal remain injected.
 */
export class NativeRelayGrantRenewalSupervisor {
  private started = false;
  private timer: Timer | undefined;
  private unsubscribeProfiles: (() => void) | undefined;
  private unsubscribeSelection: (() => void) | undefined;
  private generation = 0;
  private selected: SelectedRoute | null = null;
  private inFlight: Promise<void> | undefined;
  private inFlightGeneration: number | undefined;
  private refreshFlight:
    | { generation: number; promise: Promise<void> }
    | undefined;
  private retryKey: string | undefined;
  private retryCount = 0;
  private readonly onWake = () => {
    if (this.isVisible()) void this.observeAndRenew();
  };
  private readonly onProfileChange = () => this.selectionChanged();

  private routeSelection(selected: SelectedRoute): NativeRelayRouteSelection {
    return {
      profileName: selected.profile.name,
      brokerOrigin: selected.brokerOrigin,
      stationId: selected.stationId,
      enrollmentId: selected.enrollmentId,
    };
  }

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
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeProfiles = this.storage.subscribeRelayRouteProfiles(
      this.onProfileChange,
    );
    this.unsubscribeSelection = this.storage.subscribeActiveConnection(
      this.onProfileChange,
    );
    this.events?.addEventListener('online', this.onWake);
    this.events?.addEventListener('focus', this.onWake);
    this.events?.addEventListener('pageshow', this.onWake);
    this.visibilityEvents?.addEventListener('visibilitychange', this.onWake);
    this.selectionChanged();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    this.clearTimer();
    this.unsubscribeProfiles?.();
    this.unsubscribeProfiles = undefined;
    this.unsubscribeSelection?.();
    this.unsubscribeSelection = undefined;
    this.events?.removeEventListener('online', this.onWake);
    this.events?.removeEventListener('focus', this.onWake);
    this.events?.removeEventListener('pageshow', this.onWake);
    this.visibilityEvents?.removeEventListener('visibilitychange', this.onWake);
    this.selected = null;
  }

  /** Re-observe the selected route, including after successful redemption. */
  async refresh(): Promise<void> {
    if (!this.started) return;
    this.selectionChanged();
    const selected = this.selected;
    const generation = this.generation;
    if (!selected) return;
    if (this.refreshFlight?.generation === generation)
      return this.refreshFlight.promise;

    const current =
      this.inFlightGeneration === generation ? this.inFlight : undefined;
    if (!current) return this.observeAndRenew();

    const promise = (async () => {
      await current;
      if (this.isCurrent(selected, generation)) await this.observeAndRenew();
    })();
    this.refreshFlight = { generation, promise };
    try {
      await promise;
    } finally {
      if (this.refreshFlight?.promise === promise)
        this.refreshFlight = undefined;
    }
  }

  private selectionChanged(): void {
    const next = selectionFrom(this.storage);
    if (sameSelection(this.selected, next)) return;
    this.generation += 1;
    this.clearTimer();
    this.selected = next;
    this.retryKey = undefined;
    this.retryCount = 0;
    if (this.started && next) void this.observeAndRenew();
  }

  private isCurrent(selected: SelectedRoute, generation: number): boolean {
    return (
      this.started &&
      generation === this.generation &&
      sameSelection(selected, selectionFrom(this.storage))
    );
  }

  private async observeAndRenew(): Promise<void> {
    if (!this.started || !this.isVisible()) return;
    if (this.inFlight && this.inFlightGeneration === this.generation)
      return this.inFlight;
    const selected = this.selected;
    if (!selected) return;
    const generation = this.generation;
    const operation = this.observeSelected(selected, generation);
    this.inFlight = operation;
    this.inFlightGeneration = generation;
    try {
      await operation;
    } finally {
      if (this.inFlight === operation) {
        this.inFlight = undefined;
        this.inFlightGeneration = undefined;
      }
    }
  }

  private async observeSelected(
    selected: SelectedRoute,
    generation: number,
  ): Promise<void> {
    try {
      const status = await this.adapter.status(this.routeSelection(selected));
      if (!this.isCurrent(selected, generation)) return;
      if (!validStatus(status, selected)) return;
      const grant = status.grant;
      if (!grant) {
        this.clearTimer();
        return;
      }
      const dueAt = grant.expiresAt - grant.lifetimeMs * HALF_LIFE_FRACTION;
      const retryKey = `${selected.connectionId}:${selected.updatedAt}:${status.profileRevision}:${grant.expiresAt}`;
      if (this.retryKey !== retryKey) {
        this.retryKey = retryKey;
        this.retryCount = 0;
      }
      if (this.now() >= dueAt) {
        await this.renewSelected(
          selected,
          generation,
          status.profileRevision,
          retryKey,
        );
        return;
      }
      this.scheduleObservation(Math.max(0, dueAt - this.now()));
    } catch {
      if (this.isCurrent(selected, generation))
        this.scheduleRetry(selected, generation);
    }
  }

  private async renewSelected(
    selected: SelectedRoute,
    generation: number,
    profileRevision: number,
    retryKey: string,
  ): Promise<void> {
    if (!this.isCurrent(selected, generation)) return;
    try {
      const renewed = await this.adapter.renew({
        selection: this.routeSelection(selected),
        expectedProfileRevision: profileRevision,
      });
      if (!this.isCurrent(selected, generation)) return;
      if (
        !Number.isSafeInteger(renewed?.expiresAt) ||
        renewed.expiresAt <= this.now() ||
        !Number.isSafeInteger(renewed.lifetimeMs) ||
        renewed.lifetimeMs <= 0
      ) {
        throw new Error('Invalid native relay grant renewal receipt.');
      }
      this.retryCount = 0;
      this.retryKey = undefined;
      this.scheduleObservation(
        Math.max(
          0,
          renewed.expiresAt -
            renewed.lifetimeMs * HALF_LIFE_FRACTION -
            this.now(),
        ),
      );
    } catch {
      if (!this.isCurrent(selected, generation)) return;
      this.retryKey = retryKey;
      this.scheduleRetry(selected, generation);
    }
  }

  private scheduleRetry(selected: SelectedRoute, generation: number): void {
    if (this.retryCount >= MAX_RENEWAL_ATTEMPTS) return;
    const delay = RETRY_BACKOFF_MS[this.retryCount];
    this.retryCount += 1;
    this.scheduleObservation(delay, selected, generation);
  }

  private scheduleObservation(
    delay: number,
    selected = this.selected,
    generation = this.generation,
  ): void {
    this.clearTimer();
    if (!selected) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (this.isCurrent(selected, generation)) void this.observeAndRenew();
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
