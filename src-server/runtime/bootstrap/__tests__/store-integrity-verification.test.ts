// @vitest-environment node

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  corruptionMarkerPath,
  readCorruptionMarker,
} from '@kontourai/station-shared/sqlite-corruption-marker';
import type { StoreIntegrityResult } from '@kontourai/station-shared/sqlite-store-integrity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The counter is mocked so its ATTRIBUTES are observable. `source` is what
 * lets archive#3219 ask "how much of the corruption we saw did the schedule
 * find, versus an ordinary query?" — and a dimension nothing asserts is a
 * dimension that quietly stops being set.
 */
vi.mock('../../../telemetry/metrics.js', () => ({
  orchestrationStoreCorruptionObserved: { add: vi.fn() },
}));

import { orchestrationStoreCorruptionObserved } from '../../../telemetry/metrics.js';
import { shutdownRuntimeServices } from '../runtime-shutdown.js';
import {
  STORE_INTEGRITY_PROBE_TIMEOUT_MS,
  STORE_INTEGRITY_VERIFICATION_INTERVAL_MS,
  type StoreIntegrityProbeOutcome,
  startStoreIntegrityVerification,
} from '../store-integrity-verification.js';

/**
 * archive#3218. What this file has to hold is narrower than "the probe
 * works": the probe's own verdicts are proven against real corrupt bytes at
 * the process boundary in `src-server/tools/__tests__/`. Here the question is
 * what the RUNTIME does with a verdict — and the expensive mistake is acting
 * on one that was never reached. A marker quarantines a user's history, so
 * every path that is not "I looked and the bytes are bad" must leave the home
 * untouched.
 */

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Waits for the probe to have been consumed, not for a particular log line.
 * Keying the wait on the reaction under test would make a test that asserts
 * "nothing happened" pass by timing out on its own precondition.
 */
async function settleAfter(probe: { mock: { calls: unknown[] } }) {
  await vi.waitFor(() => expect(probe.mock.calls.length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function corruptResult(databasePath: string): StoreIntegrityResult {
  return {
    databasePath,
    verdict: 'corrupt',
    durationMs: 31,
    errcode: 11,
    detail: 'database disk image is malformed',
  };
}

describe('scheduled store integrity verification', () => {
  let dir: string;
  let databasePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'store-integrity-verification-'));
    databasePath = join(dir, 'orchestration.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.mocked(orchestrationStoreCorruptionObserved.add).mockReset();
  });

  test('records the corruption marker on a corrupt verdict', async () => {
    const timers: NodeJS.Timeout[] = [];
    const log = logger();
    startStoreIntegrityVerification({
      timers,
      databasePath,
      logger: log,
      intervalMs: 60_000,
      runProbe: async () => ({ results: [corruptResult(databasePath)] }),
    });

    await vi.waitFor(() =>
      expect(existsSync(corruptionMarkerPath(databasePath))).toBe(true),
    );
    const marker = readCorruptionMarker(databasePath);
    // The same fields the reactive path (archive#3215) records, so both
    // detection paths converge on one consumer rather than one that has to
    // know which half wrote the file.
    expect(marker?.errcode).toBe(11);
    expect(marker?.detail).toBe('database disk image is malformed');
    expect(log.error).toHaveBeenCalled();
    // Both detection paths tag `source`; the reactive one sets 'query'
    // (`event-store.ts`). A counter only one site dimensions is one the other
    // silently aggregates into "unset".
    expect(orchestrationStoreCorruptionObserved.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ errcode: 11, source: 'scheduled-probe' }),
    );
    for (const timer of timers) clearInterval(timer);
  });

  test('a failing counter never costs the marker', async () => {
    // Ordering, proven by breaking the thing that must come second. The
    // marker is the durable record the next start acts on; the counter is
    // telemetry. With the counter first, its throw is caught upstream as
    // "verification failed" and silently costs the marker — which is the
    // defect the reactive path had to fix in `event-store.ts`.
    vi.mocked(orchestrationStoreCorruptionObserved.add).mockImplementationOnce(
      () => {
        throw new Error('metrics instrument missing');
      },
    );
    const timers: NodeJS.Timeout[] = [];
    const log = logger();
    startStoreIntegrityVerification({
      timers,
      databasePath,
      logger: log,
      intervalMs: 60_000,
      runProbe: async () => ({ results: [corruptResult(databasePath)] }),
    });

    await vi.waitFor(() =>
      expect(existsSync(corruptionMarkerPath(databasePath))).toBe(true),
    );
    expect(readCorruptionMarker(databasePath)?.errcode).toBe(11);
    for (const timer of timers) clearInterval(timer);
  });

  test('a healthy store leaves no marker and raises no alarm', async () => {
    // The negative control. Without it, an implementation that recorded on
    // EVERY completed probe would pass the test above and look correct.
    const timers: NodeJS.Timeout[] = [];
    const log = logger();
    const probe = vi.fn(
      async (): Promise<StoreIntegrityProbeOutcome> => ({
        results: [{ databasePath, verdict: 'ok', durationMs: 12 }],
      }),
    );
    startStoreIntegrityVerification({
      timers,
      databasePath,
      logger: log,
      intervalMs: 60_000,
      runProbe: probe,
    });

    await settleAfter(probe);
    expect(existsSync(corruptionMarkerPath(databasePath))).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    for (const timer of timers) clearInterval(timer);
  });

  test('an unreadable store is not treated as a corrupt one', async () => {
    // `unavailable` is a claim about the OBSERVER, not about the bytes. A
    // store Station cannot open — missing, locked by an installer, on a
    // disconnected volume — must never reach the marker, because the marker
    // is what a quarantine acts on.
    const timers: NodeJS.Timeout[] = [];
    const log = logger();
    const probe = vi.fn(async () => ({
      results: [
        {
          databasePath,
          verdict: 'unavailable' as const,
          durationMs: 3,
          detail: 'unable to open database file',
        },
      ],
    }));
    startStoreIntegrityVerification({
      timers,
      databasePath,
      logger: log,
      intervalMs: 60_000,
      runProbe: probe,
    });

    await settleAfter(probe);
    expect(existsSync(corruptionMarkerPath(databasePath))).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    for (const timer of timers) clearInterval(timer);
  });

  test('a probe that produced no verdict records nothing', async () => {
    // The dev/packaging case: no bundled sidecar, so Node exits 1 — the same
    // status the probe uses for `corrupt`. Anything deriving the verdict from
    // the exit code would quarantine a healthy database the first time the
    // bundle went missing.
    const timers: NodeJS.Timeout[] = [];
    const log = logger();
    const probe = vi.fn(async () => ({
      results: [],
      unreadable: 'probe printed no verdict (exit 1)',
    }));
    startStoreIntegrityVerification({
      timers,
      databasePath,
      logger: log,
      intervalMs: 60_000,
      runProbe: probe,
    });

    await settleAfter(probe);
    expect(existsSync(corruptionMarkerPath(databasePath))).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    for (const timer of timers) clearInterval(timer);
  });

  test('a probe that throws never reaches the runtime', async () => {
    const timers: NodeJS.Timeout[] = [];
    const log = logger();
    const probe = vi.fn(async () => {
      throw new Error('spawn EAGAIN');
    });
    expect(() =>
      startStoreIntegrityVerification({
        timers,
        databasePath,
        logger: log,
        intervalMs: 60_000,
        runProbe: probe,
      }),
    ).not.toThrow();

    await settleAfter(probe);
    expect(existsSync(corruptionMarkerPath(databasePath))).toBe(false);
    expect(log.warn).toHaveBeenCalled();
    for (const timer of timers) clearInterval(timer);
  });

  test('a wedged probe is never run twice concurrently', async () => {
    const timers: NodeJS.Timeout[] = [];
    const log = logger();
    let started = 0;
    let release: (() => void) | undefined;
    startStoreIntegrityVerification({
      timers,
      databasePath,
      logger: log,
      intervalMs: 5,
      runProbe: () => {
        started += 1;
        return new Promise<StoreIntegrityProbeOutcome>((resolve) => {
          release = () => resolve({ results: [] });
        });
      },
    });

    await vi.waitFor(() => expect(started).toBe(1));
    // Many interval ticks elapse while the first probe is still pending. The
    // count is what has to hold: keying this on the skip WARNING would make
    // the assertion pass by timing out on the log line rather than by the
    // probe not having been started again.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(started).toBe(1);
    expect(
      log.warn.mock.calls.filter((call) =>
        String(call[0]).includes('previous probe still running'),
      ).length,
    ).toBeGreaterThan(1);

    release?.();
    for (const timer of timers) clearInterval(timer);
  });

  test('refuses a non-positive interval rather than scheduling nothing', () => {
    const timers: NodeJS.Timeout[] = [];
    expect(() =>
      startStoreIntegrityVerification({
        timers,
        databasePath,
        logger: logger(),
        intervalMs: 0,
        runProbe: async () => ({ results: [] }),
      }),
    ).toThrow(/positive integer/);
    expect(timers).toHaveLength(0);
  });
});

describe('the constants that ship', () => {
  test('the schedule is six-hourly and the valve is ten minutes', () => {
    // Literals on purpose. Asserting these against `6 * MS_PER_HOUR` — or
    // against whatever the module logged — is a tautology that moves with the
    // defect: swapping `MS_PER_HOUR` for `MS_PER_MINUTE` turns a six-hourly
    // diagnostic into a per-minute spawn storm and every derived assertion
    // still passes. (Review INJ-D: it did.)
    expect(STORE_INTEGRITY_VERIFICATION_INTERVAL_MS).toBe(21_600_000);
    expect(STORE_INTEGRITY_PROBE_TIMEOUT_MS).toBe(600_000);
    // And the valve must outlast a slow check rather than pre-empt it: a
    // timeout below the interval's own scale would kill healthy probes.
    expect(STORE_INTEGRITY_PROBE_TIMEOUT_MS).toBeLessThan(
      STORE_INTEGRITY_VERIFICATION_INTERVAL_MS,
    );
  });

  test('the shipped interval is the one an unconfigured caller gets', () => {
    // Pins the constant to the DEFAULT. Without this the constant could be
    // correct and unused.
    const timers: NodeJS.Timeout[] = [];
    const log = logger();
    const stop = startStoreIntegrityVerification({
      timers,
      databasePath: join(tmpdir(), 'unconfigured-interval.sqlite'),
      logger: log,
      runProbe: async () => ({ results: [] }),
    });
    try {
      expect(log.debug).toHaveBeenCalledWith(
        'Store integrity verification started',
        expect.objectContaining({ interval: 21_600_000 }),
      );
    } finally {
      stop();
    }
  });
});

describe('the verification timer is owned by the runtime shutdown path', () => {
  let dir: string;
  let databasePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'store-integrity-shutdown-'));
    databasePath = join(dir, 'orchestration.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('shutdownRuntimeServices stops further probes', async () => {
    // Drives the REAL shutdown, not a re-implementation of it. Asserting
    // `timers.length === 1` on its own would pass against a timer nothing
    // ever clears; what has to hold is that the probe stops running.
    const timers: NodeJS.Timeout[] = [];
    const log = logger();
    let probes = 0;
    startStoreIntegrityVerification({
      timers,
      databasePath,
      logger: log,
      intervalMs: 10,
      runProbe: async () => {
        probes += 1;
        return { results: [{ databasePath, verdict: 'ok', durationMs: 1 }] };
      },
    });
    expect(timers).toHaveLength(1);

    await vi.waitFor(() => expect(probes).toBeGreaterThan(2));

    await shutdownRuntimeServices({
      logger: log,
      timers,
      mcpConfigs: new Map(),
      activeAgents: new Map(),
      acpBridge: { shutdown: async () => {} },
      feedbackService: { stop: () => {} },
      voiceService: { stop: async () => {} },
      terminalWsServer: { stop: () => {} },
      terminalService: { dispose: async () => {} },
      configLoader: { dispose: async () => {} },
    });
    expect(timers).toHaveLength(0);

    const settled = probes;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(probes).toBe(settled);
  });
});
