import type { StationProfile } from '@kontourai/station-contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE,
  type NativeRelayGrantRenewalAdapter,
  type NativeRelayGrantRenewalStatus,
  NativeRelayGrantRenewalSupervisor,
  type NativeRelayRouteProfileStorage,
  type NativeRelayRouteSelection,
} from '../nativeRelayGrantRenewalSupervisor';

const routeIds = {
  Alpha: {
    brokerOrigin: 'https://alpha-broker.example',
    stationId: '11111111-1111-4111-8111-111111111111',
    enrollmentId: '22222222-2222-4222-8222-222222222222',
  },
  Beta: {
    brokerOrigin: 'https://beta-broker.example',
    stationId: '33333333-3333-4333-8333-333333333333',
    enrollmentId: '44444444-4444-4444-8444-444444444444',
  },
};

function profile(name: keyof typeof routeIds, updatedAt = 1): StationProfile {
  return {
    schemaVersion: 1,
    name,
    endpoint: `https://${name.toLowerCase()}.station.example`,
    relayRoute: routeIds[name],
    setupSource: 'manual',
    configurationState: 'unconfigured',
    createdAt: 1,
    updatedAt,
  };
}

function statusFor(
  selection: NativeRelayRouteSelection,
  profileRevision: number,
  grant: NativeRelayGrantRenewalStatus['grant'],
): NativeRelayGrantRenewalStatus {
  return { ...selection, profileRevision, grant };
}

class ProfileStorage implements NativeRelayRouteProfileStorage {
  profiles: readonly StationProfile[] = [];
  private listeners = new Set<() => void>();

  getRelayRouteProfiles(): readonly StationProfile[] {
    return this.profiles;
  }

  subscribeRelayRouteProfiles(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(profiles: readonly StationProfile[]): void {
    this.profiles = profiles;
    for (const listener of this.listeners) listener();
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
    storage.publish([profile('Alpha')]);
    events = new EventTarget();
    visible = true;
    status = vi
      .fn<NativeRelayGrantRenewalAdapter['status']>()
      .mockImplementation(async (selection) => statusFor(selection, 7, null));
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

  test('renews every saved route serially when one due renewal blocks', async () => {
    storage.publish([profile('Alpha'), profile('Beta')]);
    status.mockImplementation(async (selection) =>
      statusFor(selection, selection.profileName === 'Alpha' ? 7 : 8, {
        expiresAt: Date.now() + 40_000,
        lifetimeMs: 100_000,
      }),
    );
    const firstRenewal = deferred<{
      expiresAt: number;
      lifetimeMs: number;
    }>();
    const renewOrder: string[] = [];
    let activeRenewals = 0;
    let peakRenewals = 0;
    renew.mockImplementation(async ({ selection }) => {
      activeRenewals += 1;
      peakRenewals = Math.max(peakRenewals, activeRenewals);
      renewOrder.push(selection.profileName);
      try {
        if (selection.profileName === 'Alpha')
          return await firstRenewal.promise;
        return { expiresAt: Date.now() + 100_000, lifetimeMs: 100_000 };
      } finally {
        activeRenewals -= 1;
      }
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(status.mock.calls.map(([input]) => input.profileName)).toEqual([
      'Alpha',
      'Alpha',
    ]);
    expect(renewOrder).toEqual(['Alpha']);
    expect(peakRenewals).toBe(1);

    firstRenewal.resolve({
      expiresAt: Date.now() + 100_000,
      lifetimeMs: 100_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(renewOrder).toEqual(['Alpha', 'Beta']);
    expect(peakRenewals).toBe(1);
    expect(
      renew.mock.calls.map(([input]) => input.expectedProfileRevision),
    ).toEqual([7, 8]);
  });

  test('repeated wake scans give a due route a turn before rescanning', async () => {
    storage.publish([profile('Alpha'), profile('Beta')]);
    let alphaScans = 0;
    let scansBeforeBetaRenew = -1;
    let betaExpiry = Date.now() + 40_000;
    status.mockImplementation(async (selection) => {
      if (selection.profileName === 'Alpha') {
        alphaScans += 1;
        if (alphaScans < 8) events.dispatchEvent(new Event('focus'));
        return statusFor(selection, 7, null);
      }
      return statusFor(selection, 8, {
        expiresAt: betaExpiry,
        lifetimeMs: 100_000,
      });
    });
    renew.mockImplementation(async () => {
      if (scansBeforeBetaRenew < 0) scansBeforeBetaRenew = alphaScans;
      betaExpiry = Date.now() + 100_000;
      return { expiresAt: betaExpiry, lifetimeMs: 100_000 };
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(renew).toHaveBeenCalledWith({
      selection: { profileName: 'Beta', ...routeIds.Beta },
      expectedProfileRevision: 8,
    });
    expect(scansBeforeBetaRenew).toBeLessThanOrEqual(2);
  });

  test('cancels queued follow-up for a route removed while its renewal is pending', async () => {
    storage.publish([profile('Alpha'), profile('Beta')]);
    let betaExpiry = Date.now() + 40_000;
    status.mockImplementation(async (selection) =>
      statusFor(selection, selection.profileName === 'Alpha' ? 7 : 8, {
        expiresAt:
          selection.profileName === 'Alpha' ? Date.now() + 40_000 : betaExpiry,
        lifetimeMs: 100_000,
      }),
    );
    const pendingAlpha = deferred<{
      expiresAt: number;
      lifetimeMs: number;
    }>();
    renew.mockImplementation(async ({ selection }) => {
      if (selection.profileName === 'Alpha') return pendingAlpha.promise;
      betaExpiry = Date.now() + 100_000;
      return { expiresAt: betaExpiry, lifetimeMs: 100_000 };
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(1);

    storage.publish([profile('Beta')]);
    pendingAlpha.resolve({
      expiresAt: Date.now() + 100_000,
      lifetimeMs: 100_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(
      renew.mock.calls.map(([input]) => input.selection.profileName),
    ).toEqual(['Alpha', 'Beta']);
    expect(status.mock.calls.map(([input]) => input.profileName)).toEqual([
      'Alpha',
      'Alpha',
      'Beta',
      'Beta',
      'Beta',
    ]);
  });

  test('rechecks after a saved-route revision change and renews with the new host revision', async () => {
    const oldStatus = deferred<NativeRelayGrantRenewalStatus>();
    status
      .mockReturnValueOnce(oldStatus.promise)
      .mockImplementation(async (selection) =>
        statusFor(selection, 8, {
          expiresAt: Date.now() + 40_000,
          lifetimeMs: 100_000,
        }),
      );

    supervisor.start();
    await Promise.resolve();
    storage.publish([profile('Alpha', 2)]);
    oldStatus.resolve(
      statusFor({ profileName: 'Alpha', ...routeIds.Alpha }, 7, {
        expiresAt: Date.now() + 40_000,
        lifetimeMs: 100_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(status).toHaveBeenCalledTimes(4);
    expect(renew).toHaveBeenCalledWith({
      selection: { profileName: 'Alpha', ...routeIds.Alpha },
      expectedProfileRevision: 8,
    });
  });

  test('does not begin renewal or another route status after hiding during a fresh status read', async () => {
    storage.publish([profile('Alpha'), profile('Beta')]);
    const fresh = deferred<NativeRelayGrantRenewalStatus>();
    status
      .mockResolvedValueOnce(
        statusFor({ profileName: 'Alpha', ...routeIds.Alpha }, 7, {
          expiresAt: Date.now() + 40_000,
          lifetimeMs: 100_000,
        }),
      )
      .mockReturnValueOnce(fresh.promise);
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(2);
    visible = false;
    events.dispatchEvent(new Event('visibilitychange'));
    fresh.resolve(
      statusFor({ profileName: 'Alpha', ...routeIds.Alpha }, 7, {
        expiresAt: Date.now() + 40_000,
        lifetimeMs: 100_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(2);
    status.mockImplementation(async (selection) =>
      statusFor(selection, 8, null),
    );
    visible = true;
    events.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      status.mock.calls.slice(2).map(([selection]) => selection.profileName),
    ).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
    expect(renew).not.toHaveBeenCalled();
  });

  test('refuses a status with an invalid host revision', async () => {
    status.mockImplementation(async (selection) =>
      statusFor(selection, 0, {
        expiresAt: Date.now() + 40_000,
        lifetimeMs: 100_000,
      }),
    );
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(renew).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  test('leaves a grantless saved route idle until an explicit refresh or wake', async () => {
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(status).toHaveBeenCalledTimes(1);

    events.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(2);
  });

  test('coalesces refresh during an in-flight no-grant status and observes the redeemed grant afterward', async () => {
    const pending = deferred<NativeRelayGrantRenewalStatus>();
    const redeemedExpiry = Date.now() + 100_000;
    status
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (selection) =>
        statusFor(selection, 7, {
          expiresAt: redeemedExpiry,
          lifetimeMs: 100_000,
        }),
      );
    supervisor.start();
    await Promise.resolve();
    const firstRefresh = supervisor.refresh();
    const secondRefresh = supervisor.refresh();
    expect(status).toHaveBeenCalledTimes(1);

    pending.resolve(
      statusFor({ profileName: 'Alpha', ...routeIds.Alpha }, 7, null),
    );
    await Promise.all([firstRefresh, secondRefresh]);

    expect(status).toHaveBeenCalledTimes(2);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(49_999);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  test('rechecks host status before a due renewal and gives explicit refresh priority over cached work', async () => {
    const expiry = Date.now() + 100_000;
    let revoked = false;
    status.mockImplementation(async (selection) =>
      statusFor(
        selection,
        7,
        revoked ? null : { expiresAt: expiry, lifetimeMs: 100_000 },
      ),
    );
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 50_000);
    revoked = true;
    await supervisor.refresh();
    expect(status).toHaveBeenCalledTimes(2);
    expect(renew).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('keeps per-route renewal retries bounded', async () => {
    const expiry = Date.now() + 40_000;
    status.mockImplementation(async (selection) =>
      statusFor(selection, 7, {
        expiresAt: expiry,
        lifetimeMs: 100_000,
      }),
    );
    renew.mockRejectedValue(new Error('temporary host failure'));
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(renew).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('reports inventory overflow instead of supervising only the first routes', () => {
    const onIssue = vi.fn();
    const tooMany = Array.from(
      { length: MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE + 1 },
      (_, index) => ({
        ...profile('Alpha'),
        name: `Route ${index}`,
        relayRoute: {
          ...routeIds.Alpha,
          stationId: `${index}-station`,
        },
      }),
    );
    storage.publish(tooMany);
    supervisor.stop();
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
      onIssue,
    );

    supervisor.start();

    expect(supervisor.getIssue()).toEqual({
      kind: 'route-limit',
      routeCount: MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE + 1,
      maxRoutes: MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE,
    });
    expect(onIssue).toHaveBeenCalledWith(supervisor.getIssue());
    expect(status).not.toHaveBeenCalled();
  });
});
