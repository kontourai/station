import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConnectionAttemptResult,
  ConnectionSupervisor,
} from '../core/ConnectionSupervisor';

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ConnectionSupervisor — AC1: state transitions', () => {
  it('goes available -> connecting -> connected on a successful attempt', async () => {
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({ ok: true }),
    );
    const supervisor = new ConnectionSupervisor({ attempt });

    expect(supervisor.getSnapshot().state).toBe('available');
    supervisor.connect();
    expect(supervisor.getSnapshot().state).toBe('connecting');

    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );
    expect(supervisor.getSnapshot().sync).toBe('ok');
    expect(attempt).toHaveBeenCalledOnce();
  });

  it('goes available -> connecting -> backoff on a transient failure', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({
        ok: false,
        classification: 'transient',
        reason: 'unreachable',
      }),
    );
    const supervisor = new ConnectionSupervisor({
      attempt,
      jitterRatio: 0,
      random: () => 0,
    });

    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('backoff'),
    );
    expect(supervisor.getSnapshot().retryCount).toBe(1);
    expect(supervisor.getSnapshot().failureReason).toBe('unreachable');
  });

  it('goes blocked on a terminal (401/403-style) failure and never retries until an external signal', async () => {
    vi.useFakeTimers();
    let shouldFail = true;
    const attempt = vi.fn(async (): Promise<ConnectionAttemptResult> => {
      if (shouldFail) {
        return {
          ok: false,
          classification: 'terminal',
          reason: 'authentication-failed',
        };
      }
      return { ok: true };
    });
    const supervisor = new ConnectionSupervisor({
      attempt,
      jitterRatio: 0,
      random: () => 0,
    });

    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('blocked'),
    );
    expect(supervisor.getSnapshot().failureReason).toBe(
      'authentication-failed',
    );
    expect(attempt).toHaveBeenCalledOnce();

    // No auto-retry: advance far past every ladder rung. Still exactly one call.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(attempt).toHaveBeenCalledOnce();
    expect(supervisor.getSnapshot().state).toBe('blocked');

    // wakeup alone must NOT wake a blocked supervisor (never hot-loop on auth).
    supervisor.reportWakeup();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledOnce();
    expect(supervisor.getSnapshot().state).toBe('blocked');

    // credentialChanged is one of the three signals that DOES wake it.
    shouldFail = false;
    supervisor.reportCredentialChanged();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(supervisor.getSnapshot().retryCount).toBe(0);
  });

  it('wakes a blocked supervisor via retryRequested (manual retry)', async () => {
    let shouldFail = true;
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> =>
        shouldFail
          ? {
              ok: false,
              classification: 'terminal',
              reason: 'authentication-failed',
            }
          : { ok: true },
    );
    const supervisor = new ConnectionSupervisor({ attempt });
    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('blocked'),
    );

    shouldFail = false;
    supervisor.retry();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );
  });

  it('wakes a blocked supervisor via networkChanged(online: true)', async () => {
    let shouldFail = true;
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> =>
        shouldFail
          ? {
              ok: false,
              classification: 'terminal',
              reason: 'authentication-failed',
            }
          : { ok: true },
    );
    const supervisor = new ConnectionSupervisor({ attempt });
    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('blocked'),
    );

    shouldFail = false;
    supervisor.reportNetworkChange(true);
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );
  });

  it('goes offline immediately on networkChanged(false) and resumes on networkChanged(true)', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({ ok: true }),
    );
    const supervisor = new ConnectionSupervisor({ attempt });
    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );

    supervisor.reportNetworkChange(false);
    expect(supervisor.getSnapshot().state).toBe('offline');

    supervisor.reportNetworkChange(true);
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('disconnectRequested returns to available and cancels a pending retry', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({
        ok: false,
        classification: 'transient',
      }),
    );
    const supervisor = new ConnectionSupervisor({
      attempt,
      jitterRatio: 0,
      random: () => 0,
    });
    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('backoff'),
    );

    supervisor.disconnect();
    expect(supervisor.getSnapshot().state).toBe('available');
    expect(supervisor.getSnapshot().retryCount).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledOnce(); // the cancelled timer never fired
  });
});

describe('ConnectionSupervisor — AC2: backoff ladder + stability reset', () => {
  it('walks the 1/2/4/8/16s ladder and caps at 16s', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({
        ok: false,
        classification: 'transient',
      }),
    );
    const supervisor = new ConnectionSupervisor({
      attempt,
      jitterRatio: 0,
      random: () => 0,
    });
    supervisor.connect();

    const ladder = [1000, 2000, 4000, 8000, 16000, 16000, 16000];
    for (let rung = 0; rung < ladder.length; rung++) {
      await vi.waitFor(() =>
        expect(supervisor.getSnapshot().state).toBe('backoff'),
      );
      expect(attempt).toHaveBeenCalledTimes(rung + 1);
      expect(supervisor.getSnapshot().retryCount).toBe(rung + 1);
      await vi.advanceTimersByTimeAsync(ladder[rung]);
    }
    // One more failed attempt fired at the final (capped) rung.
    await vi.waitFor(() =>
      expect(attempt).toHaveBeenCalledTimes(ladder.length + 1),
    );
  });

  it('applies jitter within the configured ratio around each rung', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({
        ok: false,
        classification: 'transient',
      }),
    );
    const supervisor = new ConnectionSupervisor({
      attempt,
      jitterRatio: 0.5,
      random: () => 1, // max jitter: delay = base * (1 - 0.5 + 1*0.5*2) = base * 1.5
      now: () => 0,
    });
    supervisor.connect();
    // Deterministic microtask flush instead of `vi.waitFor` here — waitFor's
    // own fake-timer-aware polling can itself advance the clock by an
    // unknown amount, which would corrupt the precise-ms assertions below.
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.getSnapshot().state).toBe('backoff');
    // rung 1 base is 1000ms; max jitter multiplier is 1.5 -> 1500ms.
    expect(supervisor.getSnapshot().nextRetryAt).toBe(1500);
    await vi.advanceTimersByTimeAsync(1499);
    expect(attempt).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(2));
  });

  it('resets the ladder to its first rung after stableMs of connected time', async () => {
    vi.useFakeTimers();
    let fail = true;
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> =>
        fail ? { ok: false, classification: 'transient' } : { ok: true },
    );
    const supervisor = new ConnectionSupervisor({
      attempt,
      jitterRatio: 0,
      random: () => 0,
      stableMs: 5_000,
    });
    supervisor.connect();

    // Fail twice to build up retryCount, then let the third attempt succeed.
    await vi.waitFor(() => expect(supervisor.getSnapshot().retryCount).toBe(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(supervisor.getSnapshot().retryCount).toBe(2));
    fail = false;
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );
    // Ladder count is only cleared after stableMs of uninterrupted connection.
    expect(supervisor.getSnapshot().retryCount).toBe(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(supervisor.getSnapshot().retryCount).toBe(0);
    expect(supervisor.getSnapshot().state).toBe('connected');

    // A fresh failure after the reset starts back at the first (1s) rung.
    fail = true;
    supervisor.reportTransportClosed();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('backoff'),
    );
    expect(supervisor.getSnapshot().retryCount).toBe(1);
    expect(supervisor.getSnapshot().nextRetryAt).not.toBeNull();
  });

  it('does not reset the ladder if the connection drops before stableMs elapses', async () => {
    vi.useFakeTimers();
    let fail = true;
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> =>
        fail ? { ok: false, classification: 'transient' } : { ok: true },
    );
    const supervisor = new ConnectionSupervisor({
      attempt,
      jitterRatio: 0,
      random: () => 0,
      stableMs: 5_000,
    });
    supervisor.connect();
    await vi.waitFor(() => expect(supervisor.getSnapshot().retryCount).toBe(1));
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );

    // Drops again well before the 5s stability window elapses.
    fail = true;
    await vi.advanceTimersByTimeAsync(2000);
    supervisor.reportTransportClosed();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('backoff'),
    );
    // retryCount continues from 1 (not reset to 0), so the next rung is 2s not 1s.
    expect(supervisor.getSnapshot().retryCount).toBe(2);
  });
});

describe('ConnectionSupervisor — AC3: wake probe detects a half-dead connection', () => {
  it('stays connected when a wakeup probe succeeds', async () => {
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({ ok: true }),
    );
    const probe = vi.fn(async () => true);
    const supervisor = new ConnectionSupervisor({ attempt, probe });
    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );

    supervisor.reportWakeup();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    expect(supervisor.getSnapshot().state).toBe('connected');
    expect(attempt).toHaveBeenCalledOnce(); // no full reconnect needed
  });

  it('drops back into the reconnect cycle when a wakeup probe fails on a socket that never told us it closed', async () => {
    // Simulates a laptop-sleep half-dead socket: the transport object itself
    // never fired a close event (so `transportClosed` was never reported),
    // but a lightweight liveness probe against it fails.
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({ ok: true }),
    );
    const probe = vi.fn(async () => false); // socket looks open, probe fails
    const supervisor = new ConnectionSupervisor({ attempt, probe });
    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );

    supervisor.reportWakeup();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );
    // The failed probe triggered a full reattempt, which this stub always
    // succeeds — the observable proof is the second `attempt` call.
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('defaults the probe to re-running attempt when no probe is supplied', async () => {
    // 1st call: the initial connect. 2nd call: used AS the wake probe (only
    // its `.ok` is consulted). 3rd call: the real reattempt startCycle()
    // fires once that probe-via-attempt call reports failure.
    const attempt = vi
      .fn<(signal: AbortSignal) => Promise<ConnectionAttemptResult>>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, classification: 'transient' })
      .mockResolvedValueOnce({ ok: false, classification: 'transient' });
    const supervisor = new ConnectionSupervisor({
      attempt,
      jitterRatio: 0,
      random: () => 0,
    });
    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );

    supervisor.reportWakeup();
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('backoff'),
    );
    expect(supervisor.getSnapshot().retryCount).toBe(1);
  });

  it('ignores a stale probe result if the connection already moved on', async () => {
    const probeGate = deferred<boolean>();
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({ ok: true }),
    );
    const probe = vi.fn(() => probeGate.promise);
    const supervisor = new ConnectionSupervisor({ attempt, probe });
    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );

    supervisor.reportWakeup();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    // The connection is explicitly torn down before the slow probe resolves.
    supervisor.disconnect();
    probeGate.resolve(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(supervisor.getSnapshot().state).toBe('available');
  });
});

describe('ConnectionSupervisor — sync status is a separate dimension', () => {
  it('lets a healthy connection carry a sync error without leaving `connected`', async () => {
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({ ok: true }),
    );
    const supervisor = new ConnectionSupervisor({ attempt });
    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );
    expect(supervisor.getSnapshot().sync).toBe('ok');

    supervisor.reportSyncStatus('error', 'subscription dropped');
    expect(supervisor.getSnapshot().state).toBe('connected');
    expect(supervisor.getSnapshot().sync).toBe('error');
    expect(supervisor.getSnapshot().syncDetail).toBe('subscription dropped');
    expect(attempt).toHaveBeenCalledOnce(); // reporting sync status never re-attempts
  });
});

// station#1094 review round: FSM races and honesty gaps found by independent
// review, closed here with fault-injection-style coverage.
describe('ConnectionSupervisor — mid-flight signal races', () => {
  it('restarts the attempt when credentialChanged arrives mid-connecting, ignoring the stale in-flight result', async () => {
    // Both attempts are gated by hand so the interleaving is fully
    // deterministic — no reliance on `vi.waitFor`'s own timing.
    const first = deferred<ConnectionAttemptResult>();
    const second = deferred<ConnectionAttemptResult>();
    let callCount = 0;
    const attempt = vi.fn((): Promise<ConnectionAttemptResult> => {
      callCount += 1;
      return callCount === 1 ? first.promise : second.promise;
    });
    const supervisor = new ConnectionSupervisor({ attempt });

    supervisor.connect();
    expect(supervisor.getSnapshot().state).toBe('connecting');
    expect(attempt).toHaveBeenCalledOnce();

    supervisor.reportCredentialChanged();
    // startCycle() calls `attempt` synchronously, so the fresh attempt is
    // already in flight the instant this returns — no await needed.
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(supervisor.getSnapshot().state).toBe('connecting');

    // The STALE first attempt now resolves with a terminal (401-style)
    // failure. If it were not superseded, this would incorrectly block the
    // supervisor even though a fresh, successful attempt is already in flight.
    first.resolve({
      ok: false,
      classification: 'terminal',
      reason: 'authentication-failed',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(supervisor.getSnapshot().state).toBe('connecting');
    expect(supervisor.getSnapshot().failureReason).toBeUndefined();

    // The fresh (second) attempt is free to resolve normally.
    second.resolve({ ok: true });
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );
  });

  it('disconnectRequested mid-connecting aborts and ignores the in-flight result', async () => {
    const gate = deferred<ConnectionAttemptResult>();
    const attempt = vi.fn(() => gate.promise);
    const supervisor = new ConnectionSupervisor({ attempt });

    supervisor.connect();
    expect(supervisor.getSnapshot().state).toBe('connecting');

    supervisor.disconnect();
    expect(supervisor.getSnapshot().state).toBe('available');

    gate.resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(supervisor.getSnapshot().state).toBe('available');
    expect(attempt).toHaveBeenCalledOnce();
  });

  it('networkChanged(false) mid-connecting aborts, goes offline immediately, and ignores the in-flight result', async () => {
    const gate = deferred<ConnectionAttemptResult>();
    const attempt = vi.fn(() => gate.promise);
    const supervisor = new ConnectionSupervisor({ attempt });

    supervisor.connect();
    expect(supervisor.getSnapshot().state).toBe('connecting');

    supervisor.reportNetworkChange(false);
    expect(supervisor.getSnapshot().state).toBe('offline');

    gate.resolve({
      ok: false,
      classification: 'terminal',
      reason: 'authentication-failed',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(supervisor.getSnapshot().state).toBe('offline');
    expect(attempt).toHaveBeenCalledOnce();
  });
});

describe('ConnectionSupervisor — attempt rejection is treated as transient', () => {
  it('backs off (not blocked) when the attempt promise rejects', async () => {
    vi.useFakeTimers();
    const attempt = vi
      .fn<(signal: AbortSignal) => Promise<ConnectionAttemptResult>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ ok: true });
    const supervisor = new ConnectionSupervisor({
      attempt,
      jitterRatio: 0,
      random: () => 0,
    });

    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('backoff'),
    );
    expect(supervisor.getSnapshot().failureReason).toBe('boom');
    expect(supervisor.getSnapshot().retryCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('connected'),
    );
  });
});

describe('ConnectionSupervisor — dispose() snapshot honesty', () => {
  it('reports an idle snapshot (not a live-looking backoff) after dispose, and the cancelled retry never fires', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({
        ok: false,
        classification: 'transient',
      }),
    );
    const supervisor = new ConnectionSupervisor({
      attempt,
      jitterRatio: 0,
      random: () => 0,
    });

    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('backoff'),
    );
    expect(supervisor.getSnapshot().nextRetryAt).not.toBeNull();

    supervisor.dispose();
    expect(supervisor.getSnapshot().state).toBe('available');
    expect(supervisor.getSnapshot().nextRetryAt).toBeNull();
    expect(supervisor.getSnapshot().failureReason).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledOnce(); // the cancelled timer never fired
  });

  it('reports an idle snapshot after dispose from `blocked`', async () => {
    const attempt = vi.fn(
      async (): Promise<ConnectionAttemptResult> => ({
        ok: false,
        classification: 'terminal',
        reason: 'authentication-failed',
      }),
    );
    const supervisor = new ConnectionSupervisor({ attempt });
    supervisor.connect();
    await vi.waitFor(() =>
      expect(supervisor.getSnapshot().state).toBe('blocked'),
    );

    supervisor.dispose();
    expect(supervisor.getSnapshot().state).toBe('available');
    expect(supervisor.getSnapshot().failureReason).toBeUndefined();
  });
});
