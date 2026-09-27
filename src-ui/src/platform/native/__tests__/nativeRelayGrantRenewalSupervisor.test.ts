import type { StationProfile } from '@kontourai/station-contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type NativeRelayGrantRenewalAdapter,
  NativeRelayGrantRenewalSupervisor,
  type NativeRelayRouteProfileStorage,
} from '../nativeRelayGrantRenewalSupervisor';

const route = {
  brokerOrigin: 'https://broker.example',
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
};
const profile = (updatedAt = 1): StationProfile => ({
  schemaVersion: 1,
  name: 'Home Station',
  endpoint: 'https://station.example',
  relayRoute: route,
  setupSource: 'manual',
  configurationState: 'unconfigured',
  createdAt: 1,
  updatedAt,
});

class ProfileStorage implements NativeRelayRouteProfileStorage {
  profiles: readonly StationProfile[] = [profile()];
  active = 'station-profile:home station';
  private listeners = new Set<() => void>();
  private selectionListeners = new Set<() => void>();

  getRelayRouteProfiles(): readonly StationProfile[] {
    return this.profiles;
  }

  subscribeRelayRouteProfiles(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeActiveConnection(listener: () => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  get(key: string): string | null {
    return key === 'station-connect-connections-active' ? this.active : null;
  }

  publish(profiles: readonly StationProfile[], active = this.active): void {
    const selectionChanged = active !== this.active;
    this.profiles = profiles;
    this.active = active;
    for (const listener of this.listeners) listener();
    if (selectionChanged) {
      for (const listener of this.selectionListeners) listener();
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('native relay grant renewal supervisor', () => {
  let storage: ProfileStorage;
  let adapter: NativeRelayGrantRenewalAdapter;
  let events: EventTarget;
  let renew: ReturnType<typeof vi.fn<NativeRelayGrantRenewalAdapter['renew']>>;
  let status: ReturnType<
    typeof vi.fn<NativeRelayGrantRenewalAdapter['status']>
  >;
  let visible: boolean;
  let supervisor: NativeRelayGrantRenewalSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_900_000_000_000);
    storage = new ProfileStorage();
    events = new EventTarget();
    visible = true;
    status = vi
      .fn<NativeRelayGrantRenewalAdapter['status']>()
      .mockResolvedValue({
        profileName: 'Home Station',
        ...route,
        profileRevision: 7,
        grant: { expiresAt: Date.now() + 100_000, lifetimeMs: 100_000 },
      });
    renew = vi
      .fn<NativeRelayGrantRenewalAdapter['renew']>()
      .mockImplementation(async () => ({
        expiresAt: Date.now() + 100_000,
        lifetimeMs: 100_000,
      }));
    adapter = { status, renew };
    supervisor = new NativeRelayGrantRenewalSupervisor(
      storage,
      adapter,
      events as unknown as Pick<
        Window,
        'addEventListener' | 'removeEventListener'
      >,
      Date.now,
      () => visible,
      events as unknown as Pick<
        Document,
        'addEventListener' | 'removeEventListener'
      >,
    );
  });

  afterEach(() => {
    supervisor.stop();
    vi.useRealTimers();
  });

  test('schedules renewal at grant half-life, not at expiry', async () => {
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledWith({
      profileName: 'Home Station',
      ...route,
    });
    expect(renew).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(49_999);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledWith({
      selection: { profileName: 'Home Station', ...route },
      expectedProfileRevision: 7,
    });
  });

  test.each(['online', 'focus', 'pageshow', 'visibilitychange'])(
    'a visible %s wake rechecks status and renews a route already past half-life',
    async (eventName) => {
      visible = false;
      status.mockResolvedValue({
        profileName: 'Home Station',
        ...route,
        profileRevision: 7,
        grant: { expiresAt: Date.now() + 40_000, lifetimeMs: 100_000 },
      });
      supervisor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(renew).not.toHaveBeenCalled();

      visible = true;
      events.dispatchEvent(new Event(eventName));
      await vi.advanceTimersByTimeAsync(0);
      expect(renew).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    [
      'switch',
      (store: ProfileStorage) =>
        store.publish([profile()], 'station-profile:other'),
    ],
    ['removal', (store: ProfileStorage) => store.publish([], '')],
    ['revision change', (store: ProfileStorage) => store.publish([profile(2)])],
  ])(
    'does not renew after a pending status becomes stale through %s',
    async (_name, mutate) => {
      const pending = deferred<Awaited<ReturnType<typeof adapter.status>>>();
      status.mockReturnValueOnce(pending.promise);
      supervisor.start();
      mutate(storage);
      pending.resolve({
        profileName: 'Home Station',
        ...route,
        profileRevision: 7,
        grant: { expiresAt: Date.now() + 1_000, lifetimeMs: 1_000 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(renew).not.toHaveBeenCalled();
    },
  );

  test('bounds retry attempts for a persistently failing renewal', async () => {
    status.mockResolvedValue({
      profileName: 'Home Station',
      ...route,
      profileRevision: 7,
      grant: { expiresAt: Date.now() + 10_000, lifetimeMs: 10_000 },
    });
    renew.mockRejectedValue(new Error('temporary host failure'));
    supervisor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(4);
  });

  test('refresh observes a newly redeemed grant after an earlier no-grant status', async () => {
    status
      .mockResolvedValueOnce({
        profileName: 'Home Station',
        ...route,
        profileRevision: 7,
        grant: null,
      })
      .mockResolvedValueOnce({
        profileName: 'Home Station',
        ...route,
        profileRevision: 7,
        grant: { expiresAt: Date.now() + 40_000, lifetimeMs: 100_000 },
      });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).not.toHaveBeenCalled();

    await supervisor.refresh();

    expect(status).toHaveBeenCalledTimes(2);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  test('coalesces refresh during an in-flight no-grant status and observes the redeemed grant afterward', async () => {
    const pending = deferred<Awaited<ReturnType<typeof adapter.status>>>();
    status.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      profileName: 'Home Station',
      ...route,
      profileRevision: 7,
      grant: { expiresAt: Date.now() + 100_000, lifetimeMs: 100_000 },
    });
    supervisor.start();
    const firstRefresh = supervisor.refresh();
    const secondRefresh = supervisor.refresh();
    expect(status).toHaveBeenCalledTimes(1);

    pending.resolve({
      profileName: 'Home Station',
      ...route,
      profileRevision: 7,
      grant: null,
    });
    await Promise.all([firstRefresh, secondRefresh]);

    expect(status).toHaveBeenCalledTimes(2);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(49_999);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(1);
  });
});
