import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionHealthCoordinator } from '../core/ConnectionHealthCoordinator';
import { createAccessEndpoint } from '../core/environmentProfiles';

afterEach(() => vi.useRealTimers());

describe('ConnectionHealthCoordinator', () => {
  it('tracks consecutive failures by reason and resets the streak after success', async () => {
    vi.useFakeTimers();
    const endpoint = createAccessEndpoint('https://station.example.test');
    const check = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [endpoint],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check,
      baseRetryMs: 1,
      jitterRatio: 0,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot()).toMatchObject({
        reason: 'timeout',
        failureStreak: 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot()).toMatchObject({
        reason: 'timeout',
        failureStreak: 2,
      }),
    );
    await vi.advanceTimersByTimeAsync(2);
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot()).toMatchObject({
        status: 'connected',
        failureStreak: 0,
      }),
    );
    coordinator.trigger();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot()).toMatchObject({
        reason: 'timeout',
        failureStreak: 1,
      }),
    );
    unsubscribe();
  });

  it('accumulates one streak across alternating timeout and unreachable probes', async () => {
    // sol review of #2630, finding 4: timeout and unreachable are one
    // transient-unreachability family — alternation must not reset the
    // streak or the banner threshold could never be reached in a real
    // outage whose classification oscillates.
    vi.useFakeTimers();
    const endpoint = createAccessEndpoint('https://station.example.test');
    const check = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
      .mockResolvedValueOnce({ ok: false, reason: 'unreachable' })
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [endpoint],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check,
      baseRetryMs: 1,
      jitterRatio: 0,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot()).toMatchObject({
        reason: 'timeout',
        failureStreak: 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot()).toMatchObject({
        reason: 'unreachable',
        failureStreak: 2,
      }),
    );
    await vi.advanceTimersByTimeAsync(2);
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot()).toMatchObject({
        reason: 'timeout',
        failureStreak: 3,
      }),
    );
    unsubscribe();
  });

  it('closes a failure window on recovery and never rewrites it afterwards (sol finding 3)', async () => {
    vi.useFakeTimers();
    const endpoint = createAccessEndpoint('https://station.example.test');
    const check = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
      .mockResolvedValue(true);
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [endpoint],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check,
      baseRetryMs: 1,
      jitterRatio: 0,
      pollIntervalMs: 5,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().failureStreak).toBe(3),
    );
    expect(coordinator.getSnapshot().failureWindows.length).toBe(1);

    await vi.advanceTimersByTimeAsync(3);
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().status).toBe('connected'),
    );
    const closedEnd = coordinator.getSnapshot().failureWindows[0].end;

    // Ordinary healthy polling after recovery must not move the closed
    // window's end.
    await vi.advanceTimersByTimeAsync(25);
    expect(coordinator.getSnapshot().failureWindows.length).toBe(1);
    expect(coordinator.getSnapshot().failureWindows[0].end).toBe(closedEnd);
    unsubscribe();
  });

  it('shares one in-flight check among subscribers and reconnects with backoff', async () => {
    vi.useFakeTimers();
    const endpoint = createAccessEndpoint('https://station.example.test');
    const check = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [endpoint],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check,
      baseRetryMs: 100,
      jitterRatio: 0,
    });
    const unsubscribeA = coordinator.subscribe(vi.fn());
    const unsubscribeB = coordinator.subscribe(vi.fn());

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().status).toBe('error'),
    );
    expect(check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().status).toBe('connected'),
    );
    expect(check).toHaveBeenCalledTimes(2);
    unsubscribeA();
    unsubscribeB();
  });

  it('never probes a managed-loopback endpoint and trusts the supervisor', async () => {
    const managed = createAccessEndpoint('http://127.0.0.1:3142', {
      kind: 'managed-loopback',
    });
    const check = vi.fn().mockResolvedValue(false);
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [managed],
      compatibility: () => ({ clientProtocol: 'http:', online: true }),
      check,
      onSuccess,
      onFailure,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().status).toBe('connected'),
    );
    expect(check).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().reason).toBeNull();
    unsubscribe();
  });

  it('skips mixed-content LAN and selects compatible tailnet HTTPS', async () => {
    const lan = createAccessEndpoint('http://192.168.1.20:3141', {
      priority: 1,
    });
    const tailnet = createAccessEndpoint(
      'https://station.example-tailnet.ts.net',
      { priority: 2 },
    );
    const onSuccess = vi.fn();
    const check = vi.fn().mockResolvedValue(true);
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [lan, tailnet],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check,
      onSuccess,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().status).toBe('connected'),
    );
    expect(check).toHaveBeenCalledOnce();
    expect(check.mock.calls[0][0]).toEqual(tailnet);
    expect(onSuccess).toHaveBeenCalledWith(tailnet, { ok: true });
    unsubscribe();
  });

  it('does not issue a request while the client is offline', async () => {
    const endpoint = createAccessEndpoint('https://station.example.test');
    const check = vi.fn();
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [endpoint],
      compatibility: () => ({ clientProtocol: 'https:', online: false }),
      check,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().reason).toBe('offline'),
    );
    expect(check).not.toHaveBeenCalled();
    unsubscribe();
  });

  // station#1094 R4/AC4: the first adopter. Existing status/reason/checking
  // behavior above is unchanged (regression proof); `blocked` is additive.
  it('blocks on an authentication-failed reason and stops scheduling automatic retries', async () => {
    vi.useFakeTimers();
    const endpoint = createAccessEndpoint('https://station.example.test');
    const check = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'authentication-failed',
    });
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [endpoint],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check,
      baseRetryMs: 100,
      jitterRatio: 0,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().blocked).toBe(true),
    );
    expect(coordinator.getSnapshot().status).toBe('error');
    expect(coordinator.getSnapshot().reason).toBe('authentication-failed');
    expect(check).toHaveBeenCalledOnce();

    // No hot loop: advance far past every backoff rung and the poll
    // interval. Still exactly one check.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(check).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().blocked).toBe(true);

    unsubscribe();
  });

  it('resumes a blocked coordinator on an explicit trigger() (manual retry / credential change / online)', async () => {
    let credentialFixed = false;
    const endpoint = createAccessEndpoint('https://station.example.test');
    const check = vi
      .fn()
      .mockImplementation(async () =>
        credentialFixed ? true : { ok: false, reason: 'authentication-failed' },
      );
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [endpoint],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().blocked).toBe(true),
    );

    credentialFixed = true;
    coordinator.trigger();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().status).toBe('connected'),
    );
    expect(coordinator.getSnapshot().blocked).toBe(false);
    expect(check).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('still schedules ordinary automatic retries for a non-terminal (unreachable) reason', async () => {
    vi.useFakeTimers();
    const endpoint = createAccessEndpoint('https://station.example.test');
    const check = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [endpoint],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check,
      baseRetryMs: 100,
      jitterRatio: 0,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().status).toBe('error'),
    );
    expect(coordinator.getSnapshot().blocked).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().status).toBe('connected'),
    );
    expect(check).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('cancels cleanly when the final subscriber leaves during a check', async () => {
    let resolve!: (value: boolean) => void;
    const pending = new Promise<boolean>((done) => {
      resolve = done;
    });
    const endpoint = createAccessEndpoint('https://station.example.test');
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [endpoint],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check: async () => pending,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());

    unsubscribe();
    resolve(true);
    await pending;
    await Promise.resolve();
    expect(coordinator.getSnapshot().status).toBe('connecting');
  });

  it('records only sustained failure windows and bounds their history', async () => {
    const endpoint = createAccessEndpoint('https://station.example.test');
    const check = vi.fn().mockResolvedValue(false);
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [endpoint],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check,
      baseRetryMs: 60_000,
      maxRetryMs: 60_000,
      jitterRatio: 0,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().failureStreak).toBe(1),
    );
    coordinator.trigger();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().failureStreak).toBe(2),
    );
    expect(coordinator.getSnapshot().failureWindows).toHaveLength(0);
    coordinator.trigger();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().failureStreak).toBe(3),
    );
    expect(coordinator.getSnapshot().failureWindows).toHaveLength(1);
    expect(coordinator.getSnapshot().failureWindows.length).toBeLessThanOrEqual(
      20,
    );
    unsubscribe();
  });
});

/**
 * station#3297 — the coordinator's own half of the reported defect.
 *
 * `ConnectionManagerModal`'s prop doc has warned since station#1094 that "a
 * bare `false` cannot say why a check failed" and that reporting a reachable
 * Station's rejection as 'unreachable' "sends the user to check an address
 * that is fine". This class was the code doing exactly that: three separate
 * paths defaulted to a network reason on evidence that named no network.
 */
describe('ConnectionHealthCoordinator — reasons it did not derive', () => {
  const endpoint = () => createAccessEndpoint('https://station.example.test');

  function coordinatorWith(
    check: (...args: never[]) => unknown,
    endpoints = [endpoint()],
  ) {
    return new ConnectionHealthCoordinator({
      endpoints: () => endpoints,
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check: check as never,
      baseRetryMs: 1,
      jitterRatio: 0,
    });
  }

  it('reports a reason-free `false` as undetermined, never as unreachable', async () => {
    const coordinator = coordinatorWith(vi.fn().mockResolvedValue(false));
    const unsubscribe = coordinator.subscribe(vi.fn());
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot()).toMatchObject({
        status: 'error',
        reason: 'undetermined',
      }),
    );
    unsubscribe();
  });

  it('does not invent a reason when a probe throws something unrecognized', async () => {
    // Both shipped probes catch their own transport failures and return a
    // reason, so anything reaching this catch is a bug, not a dead network.
    const coordinator = coordinatorWith(
      vi.fn().mockRejectedValue(new Error('unexpected')),
    );
    const unsubscribe = coordinator.subscribe(vi.fn());
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot()).toMatchObject({
        status: 'error',
        reason: 'undetermined',
      }),
    );
    unsubscribe();
  });

  it('does not invent a reason when there was no endpoint to attempt', async () => {
    const coordinator = coordinatorWith(vi.fn(), []);
    const unsubscribe = coordinator.subscribe(vi.fn());
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot()).toMatchObject({
        status: 'error',
        reason: 'undetermined',
      }),
    );
    unsubscribe();
  });

  it('still carries a reason the probe DID derive, unchanged', async () => {
    // The fix must not flatten real classifications into 'undetermined'.
    const coordinator = coordinatorWith(
      vi.fn().mockResolvedValue({ ok: false, reason: 'authentication-failed' }),
    );
    const unsubscribe = coordinator.subscribe(vi.fn());
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot()).toMatchObject({
        status: 'error',
        reason: 'authentication-failed',
        blocked: true,
      }),
    );
    unsubscribe();
  });
});
