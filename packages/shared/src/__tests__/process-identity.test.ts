/**
 * station#2904 — `birthProvesReuse`, the single comparison seam for every
 * birth-aware liveness check (findRunning, the shared-home warning, the
 * adopt guard, claimDesktopSidecar).
 *
 * The fail-open branch IS the fix and had zero test power before this file:
 * `lookupProcessBirthFingerprint` returns NULL on any probe failure — never
 * undefined — so the earlier `observed !== undefined` sentinels were
 * tautologies, and a transient `ps` timeout read a LIVE instance as
 * pid-reused. Delete the `observed == null` guard and only the failure-path
 * test here reds; everything else stays green, which is exactly how the
 * defect shipped the first time.
 */
import { describe, expect, test } from 'vitest';
import {
  birthProvesReuse,
  lookupProcessBirthFingerprint,
  lookupProcessBirthFingerprintAsync,
  probeExactProcessIdentity,
  resolveOwnProcessIdentity,
} from '../process-identity.mjs';

describe('birthProvesReuse (station#2904)', () => {
  test('only ESRCH makes the exact-identity liveness probe dead', () => {
    const failure = (code?: string) => () => {
      const error = new Error(
        'injected signal-0 failure',
      ) as NodeJS.ErrnoException;
      if (code) error.code = code;
      throw error;
    };
    expect(probeExactProcessIdentity(42, { kill: failure('ESRCH') })).toEqual({
      state: 'dead',
    });
    expect(probeExactProcessIdentity(42, { kill: failure('EPERM') })).toEqual({
      state: 'unavailable',
    });
    expect(probeExactProcessIdentity(42, { kill: failure() })).toEqual({
      state: 'unavailable',
    });
  });

  test('a probe FAILURE is not proof of reuse — fail-open', () => {
    // The discriminating case. The injected exec throws, the lookup returns
    // null, and null must read as "no proof", never as a mismatch.
    const throwingExec = () => {
      throw new Error('injected ps failure');
    };
    expect(
      birthProvesReuse('Mon Aug 17 13:00:00 2026', process.pid, {
        exec: throwingExec,
      }),
    ).toBe(false);
  });

  test('an EMPTY probe result is not proof of reuse either', () => {
    // `ps` printing nothing for a pid also yields null via `.trim() || null`.
    const emptyExec = () => '';
    expect(
      birthProvesReuse('Mon Aug 17 13:00:00 2026', process.pid, {
        exec: emptyExec,
      }),
    ).toBe(false);
  });

  test('a genuine mismatch IS proof of reuse', () => {
    const observedExec = () => 'Mon Aug 17 13:00:00 2026\n';
    expect(
      birthProvesReuse('Tue Jan  6 01:02:03 2026', process.pid, {
        exec: observedExec,
      }),
    ).toBe(true);
  });

  test('a match is not reuse', () => {
    const observedExec = () => 'Mon Aug 17 13:00:00 2026\n';
    expect(
      birthProvesReuse('Mon Aug 17 13:00:00 2026', process.pid, {
        exec: observedExec,
      }),
    ).toBe(false);
  });

  test('no recorded birth means nothing to prove', () => {
    expect(birthProvesReuse(undefined, process.pid)).toBe(false);
    expect(birthProvesReuse(null, process.pid)).toBe(false);
    expect(birthProvesReuse('', process.pid)).toBe(false);
  });

  test('the real probe is env-pinned: stable for the same live process', () => {
    // The writer/reader skew defense (LC_ALL=C + TZ=UTC): the same live
    // process must fingerprint identically across reads, or every consumer
    // treats a live instance as pid-reused — the lazy-start-competitor
    // hazard this seam exists to prevent.
    const first = lookupProcessBirthFingerprint(process.pid);
    const second = lookupProcessBirthFingerprint(process.pid);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(birthProvesReuse(first, process.pid)).toBe(false);
  });

  test('reads Windows creation time from the process handle with guard-identical precision', () => {
    const canonical = '2026-08-29T16:16:27.1234567Z';
    const exec = vi.fn<
      (
        file: string,
        args: readonly string[],
        options?: Record<string, unknown>,
      ) => string
    >(() => `${canonical}\n`);
    expect(lookupProcessBirthFingerprint(42, { platform: 'win32', exec })).toBe(
      canonical,
    );
    expect(exec).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        '-Command',
        expect.stringMatching(
          /GetProcessById\(42\).*Ticks % 10.*yyyy-MM-ddTHH:mm:ss\.fffffffZ/,
        ),
      ]),
      expect.objectContaining({ encoding: 'utf8', windowsHide: true }),
    );
    expect(exec.mock.calls[0]?.[1]?.join(' ') ?? '').not.toContain(
      'Get-CimInstance',
    );
    expect(
      lookupProcessBirthFingerprint(42, {
        platform: 'win32',
        exec: () => '2026-02-30T16:16:27.1234567Z\n',
      }),
    ).toBeNull();
    expect(
      lookupProcessBirthFingerprint(42, {
        platform: 'win32',
        exec: () => '08/29/2026 16:16:27\n',
      }),
    ).toBeNull();
    expect(
      lookupProcessBirthFingerprint(42, {
        platform: 'win32',
        exec: () => '0000-01-01T00:00:00.0000000Z\n',
      }),
    ).toBeNull();
    expect(
      birthProvesReuse(canonical, 42, {
        platform: 'win32',
        exec: () => '2026-08-29T16:16:27.1234568Z\n',
      }),
    ).toBe(true);
  });

  test('uses the same direct Windows creation-time authority asynchronously', async () => {
    const canonical = '2026-08-29T16:16:27.1234567Z';
    const exec = vi.fn(async () => `${canonical}\n`);
    await expect(
      lookupProcessBirthFingerprintAsync(42, { platform: 'win32', exec }),
    ).resolves.toBe(canonical);
    expect(exec).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        '-Command',
        expect.stringContaining('yyyy-MM-ddTHH:mm:ss.fffffffZ'),
      ]),
      expect.objectContaining({ encoding: 'utf8', windowsHide: true }),
    );
    await expect(
      lookupProcessBirthFingerprintAsync(42, {
        platform: 'win32',
        exec: async () => '0000-01-01T00:00:00.0000000Z\n',
      }),
    ).resolves.toBeNull();
    await expect(
      lookupProcessBirthFingerprintAsync(42, {
        platform: 'win32',
        exec: async () => 'August 29, 2026\n',
      }),
    ).resolves.toBeNull();
  });

  test('own-process publication uses one exact probe and never grants PID-only ownership', () => {
    const lookup = vi.fn(() => '2026-08-29T16:16:27.1234567Z');
    const alive = vi.fn(() => 'alive' as const);
    expect(
      resolveOwnProcessIdentity(42, {
        platform: 'win32',
        lookup,
        alive,
      }),
    ).toEqual({
      state: 'exact',
      identity: { pid: 42, start: '2026-08-29T16:16:27.1234567Z' },
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(alive).toHaveBeenCalledOnce();

    const unavailable = vi.fn(() => null);
    expect(
      resolveOwnProcessIdentity(42, {
        platform: 'win32',
        lookup: unavailable,
        alive: () => 'alive',
      }),
    ).toEqual({ state: 'unavailable' });
    expect(unavailable).toHaveBeenCalledOnce();
  });

  test('gives only own-process publication the larger bounded shell-start budget', () => {
    const canonical = '2026-08-29T16:16:27.1234567Z';
    const exec = vi.fn<
      (
        file: string,
        args: readonly string[],
        options?: Record<string, unknown>,
      ) => string
    >(() => canonical);
    const common = {
      platform: 'win32' as const,
      exec,
      alive: () => 'alive' as const,
    };

    expect(resolveOwnProcessIdentity(42, common).state).toBe('exact');
    expect(exec.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ timeout: 10_000 }),
    );

    expect(probeExactProcessIdentity(42, common).state).toBe('exact');
    expect(exec.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ timeout: 1_500 }),
    );
  });

  test('keeps claimant and reclaim identity probes single-attempt on Windows', () => {
    const lookup = vi.fn(() => null);
    expect(
      probeExactProcessIdentity(42, {
        platform: 'win32',
        lookup,
        alive: () => 'alive',
      }),
    ).toEqual({ state: 'unavailable' });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
