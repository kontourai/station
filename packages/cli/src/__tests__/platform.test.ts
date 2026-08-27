import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureStableProcessFingerprint,
  createAppShortcut,
  createPathLink,
  fingerprintMatchesRecorded,
  IS_MAC,
  IS_WINDOWS,
  inspectProcessFingerprint,
  killProcessTree,
  sleepSync,
} from '../commands/platform.js';
import {
  reapAllLongRunningFixtureChildren,
  spawnLongRunningFixtureChild,
} from './helpers/longrunning-fixture-child.js';

const fingerprint = (digest: string) => ({
  pid: 41,
  startToken: 'Mon Jul 13 10:00:00 2026',
  commandDigest: digest.repeat(64),
});

describe('inspectProcessFingerprint (station#3049)', () => {
  const psOptions = (exec: ReturnType<typeof vi.fn>) =>
    exec.mock.calls[0][2] as { env: Record<string, string> };

  it('pins locale and timezone on the ps probe', () => {
    // The defect: lstart renders through the caller's locale AND timezone,
    // so the same live process fingerprinted differently between a terminal
    // and launchd — and stopRecord refuses to signal on mismatch.
    const exec = vi.fn(
      () => 'Mon Aug 17 13:00:00 2026 /usr/bin/node dist-server/main.js\n',
    );
    const result = inspectProcessFingerprint(41, { exec: exec as never });
    expect(result?.startToken).toBe('Mon Aug 17 13:00:00 2026');
    expect(psOptions(exec).env.LC_ALL).toBe('C');
    expect(psOptions(exec).env.TZ).toBe('UTC');
  });

  it('parses a space-padded day-of-month', () => {
    const exec = vi.fn(() => 'Mon Aug  7 03:04:05 2026 node server.js\n');
    const result = inspectProcessFingerprint(41, { exec: exec as never });
    expect(result?.startToken).toBe('Mon Aug  7 03:04:05 2026');
  });

  it('fails closed on a shape C-locale ps cannot produce', () => {
    // A German-localized lstart. Both the old slice and the field parse
    // reject THIS shape (no whitespace lands at the 24-char boundary) — the
    // discriminating case is the next test.
    const exec = vi.fn(() => 'Mo 17 Aug 13:00:00 2026 node server.js\n');
    expect(inspectProcessFingerprint(41, { exec: exec as never })).toBeNull();
  });

  it('fails closed even when a localized shape satisfies the fixed-width slice', () => {
    // 23-character localized date + two spaces: the old `.{24}` slice
    // accepted this (whitespace happens to land at the boundary) and
    // returned a wrong-lens token that could only ever mismatch at stop.
    // The field parse recognizes it is not a C-locale shape and returns
    // null — the discriminating case injection C proved missing.
    const exec = vi.fn(() => 'Mo 17 Aug 13:00:00 2026  node server.js\n');
    expect(inspectProcessFingerprint(41, { exec: exec as never })).toBeNull();
  });

  it('real self-probe: C-format token, stable across reads', () => {
    const first = inspectProcessFingerprint(process.pid);
    const second = inspectProcessFingerprint(process.pid);
    expect(first?.startToken).toMatch(
      /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/,
    );
    expect(second).toEqual(first);
  });
});

describe('fingerprintMatchesRecorded (station#3049)', () => {
  const recorded = {
    pid: 41,
    startToken: 'Sun Aug 17 06:00:00 2026',
    commandDigest: 'd'.repeat(64),
  };

  it('matches field-wise without consulting the legacy probe', () => {
    const legacyInspect = vi.fn();
    expect(
      fingerprintMatchesRecorded({ ...recorded }, recorded, { legacyInspect }),
    ).toBe(true);
    expect(legacyInspect).not.toHaveBeenCalled();
  });

  it('accepts a record written by a pre-pin CLI via the legacy lens', () => {
    // The migration case: the record captured lstart under the recorder's
    // TZ (six hours off), the pinned observation disagrees — but the legacy
    // probe of the SAME pid reproduces the recorded token, and the
    // env-independent command digest agrees. Without this, upgrading
    // strands every running pre-upgrade instance unstoppable.
    const pinnedObservation = {
      ...recorded,
      startToken: 'Sun Aug 17 12:00:00 2026',
    };
    const legacyInspect = vi.fn(() => ({ ...recorded }));
    expect(
      fingerprintMatchesRecorded(pinnedObservation, recorded, {
        legacyInspect,
      }),
    ).toBe(true);
    expect(legacyInspect).toHaveBeenCalledWith(41);
  });

  it('refuses when neither lens matches (genuine pid reuse)', () => {
    const pinnedObservation = {
      ...recorded,
      startToken: 'Sun Aug 17 12:00:00 2026',
      commandDigest: 'e'.repeat(64),
    };
    const legacyInspect = vi.fn(() => ({
      ...recorded,
      startToken: 'Tue Jan  6 01:02:03 2026',
      commandDigest: 'e'.repeat(64),
    }));
    expect(
      fingerprintMatchesRecorded(pinnedObservation, recorded, {
        legacyInspect,
      }),
    ).toBe(false);
  });

  it('never matches through null observations', () => {
    const legacyInspect = vi.fn(() => null);
    expect(fingerprintMatchesRecorded(null, recorded, { legacyInspect })).toBe(
      false,
    );
    expect(
      fingerprintMatchesRecorded({ ...recorded }, null, { legacyInspect }),
    ).toBe(false);
  });
});

describe('captureStableProcessFingerprint', () => {
  it('waits through a transient pre-exec command before returning', () => {
    let elapsed = 0;
    const inspect = vi.fn(() =>
      elapsed < 40 ? fingerprint('a') : fingerprint('b'),
    );

    const result = captureStableProcessFingerprint(41, {
      inspect,
      intervalMs: 20,
      now: () => elapsed,
      sleep: (ms) => {
        elapsed += ms;
      },
      stableMs: 100,
      timeoutMs: 500,
    });

    expect(result).toEqual(fingerprint('b'));
    expect(elapsed).toBe(140);
    expect(inspect).toHaveBeenCalledTimes(8);
  });

  it('returns a fingerprint only after the complete settling window', () => {
    let elapsed = 0;
    const stable = fingerprint('c');

    const result = captureStableProcessFingerprint(41, {
      inspect: () => stable,
      intervalMs: 25,
      now: () => elapsed,
      sleep: (ms) => {
        elapsed += ms;
      },
      stableMs: 100,
      timeoutMs: 500,
    });

    expect(result).toEqual(stable);
    expect(elapsed).toBe(100);
  });

  it('fails closed when the process identity never settles', () => {
    let elapsed = 0;
    let generation = 0;

    const result = captureStableProcessFingerprint(41, {
      inspect: () => fingerprint(generation++ % 2 === 0 ? 'd' : 'e'),
      intervalMs: 20,
      now: () => elapsed,
      sleep: (ms) => {
        elapsed += ms;
      },
      stableMs: 100,
      timeoutMs: 120,
    });

    expect(result).toBeNull();
    expect(elapsed).toBe(120);
  });

  it('fails closed within its observation budget when the clock stalls', () => {
    // station#1712: the settling window and the deadline are both wall-clock
    // differences, so a clock that stops advancing makes both unreachable.
    // Keep the clock stalled just beyond the expected budget, then advance it.
    // Without the budget the old loop still terminates, but returns the stable
    // fingerprint and exceeds the pinned observation count. That makes the
    // negative control actionable instead of hanging the entire test worker.
    const sleep = vi.fn();
    const inspect = vi.fn(() => fingerprint('f'));
    let nowCalls = 0;
    const observationBudget = Math.ceil(2_000 / 20) + 2;

    const result = captureStableProcessFingerprint(41, {
      inspect,
      intervalMs: 20,
      now: () => {
        nowCalls += 1;
        return nowCalls <= observationBudget + 1 ? 90_000 : 92_001;
      },
      sleep,
      stableMs: 100,
      timeoutMs: 2_000,
    });

    expect(result).toBeNull();
    // Bounded, and bounded by the configured window rather than by luck.
    expect(inspect.mock.calls.length).toBeLessThanOrEqual(observationBudget);
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(observationBudget);
    expect(nowCalls).toBeLessThanOrEqual(observationBudget + 1);
  });
});

// ─── sleepSync ────────────────────────────────────────────────────────────────

describe('sleepSync', () => {
  it('keeps its fallback bounded when wall time is frozen', () => {
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      throw new Error('Atomics.wait unavailable');
    });
    // The old wall-clock fallback still terminates under this sequence, but
    // fails the assertion below. Keep the negative control actionable.
    const wallClock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(2);

    try {
      sleepSync(1);
      expect(wallClock).not.toHaveBeenCalled();
    } finally {
      wallClock.mockRestore();
      wait.mockRestore();
    }
  });

  it('blocks for at least the requested duration', () => {
    const start = Date.now();
    sleepSync(200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  it('does not block dramatically longer than requested', () => {
    const start = Date.now();
    sleepSync(100);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('handles 0 ms without hanging', () => {
    const start = Date.now();
    sleepSync(0);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

// ─── killProcessTree ──────────────────────────────────────────────────────────

describe('killProcessTree', () => {
  // Reaps the fixture child on every path -- happy, failed assertion, or
  // timeout -- not just after a passing `killProcessTree` call. See
  // helpers/longrunning-fixture-child.ts for the abnormal-suite-teardown
  // case this also covers (station#1812).
  afterEach(async () => {
    await reapAllLongRunningFixtureChildren();
  });

  it('does not throw when PID does not exist', () => {
    expect(() => killProcessTree(99999)).not.toThrow();
  });

  it('kills a live process', async () => {
    const proc = await spawnLongRunningFixtureChild();
    const pid = proc.pid!;

    expect(() => process.kill(pid, 0)).not.toThrow();

    killProcessTree(pid);

    await new Promise((r) => setTimeout(r, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);
});

// ─── promptYN — logic coverage ───────────────────────────────────────────────

describe('promptYN (answer parsing logic)', () => {
  // The readline interaction is integration-tested manually; here we verify
  // the acceptance logic used inside promptYN.
  const accepts = (raw: string) => raw.trim().toLowerCase() === 'y';

  it('"y" is accepted', () => expect(accepts('y')).toBe(true));
  it('"Y" is accepted', () => expect(accepts('Y')).toBe(true));
  it('"y " with trailing space is accepted', () =>
    expect(accepts('y ')).toBe(true));
  it('"n" is rejected', () => expect(accepts('n')).toBe(false));
  it('"N" is rejected', () => expect(accepts('N')).toBe(false));
  it('empty string is rejected', () => expect(accepts('')).toBe(false));
  it('whitespace-only is rejected', () => expect(accepts('  ')).toBe(false));
  it('"yes" is rejected (must be single y)', () =>
    expect(accepts('yes')).toBe(false));
});

// ─── createPathLink ───────────────────────────────────────────────────────────

describe('createPathLink', () => {
  let tmpDir: string;
  let origAppData: string | undefined;
  let origBinDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'station-link-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origAppData !== undefined) process.env.APPDATA = origAppData;
    else delete process.env.APPDATA;
    if (origBinDir !== undefined) process.env.STATION_BIN_DIR = origBinDir;
    else delete process.env.STATION_BIN_DIR;
  });

  it.runIf(IS_WINDOWS)(
    'Windows: writes station.cmd shim to %APPDATA%\\npm\\',
    () => {
      origAppData = process.env.APPDATA;
      process.env.APPDATA = tmpDir;

      createPathLink('/fake/repo');

      const shim = join(tmpDir, 'npm', 'station.cmd');
      expect(existsSync(shim)).toBe(true);
      const content = readFileSync(shim, 'utf-8');
      expect(content).toContain('@echo off');
      expect(content).toContain('npx tsx');
      expect(content).toContain(
        join('/fake/repo', 'packages', 'cli', 'src', 'cli.ts'),
      );
      expect(content).toContain('%*');
    },
  );

  it.runIf(IS_WINDOWS)(
    'Windows: creates npm bin dir if it does not exist',
    () => {
      origAppData = process.env.APPDATA;
      process.env.APPDATA = tmpDir;

      expect(existsSync(join(tmpDir, 'npm'))).toBe(false);
      createPathLink('/fake/repo');
      expect(existsSync(join(tmpDir, 'npm'))).toBe(true);
    },
  );

  it.runIf(!IS_WINDOWS)(
    'Unix: errors and exits when station script is missing',
    () => {
      origBinDir = process.env.STATION_BIN_DIR;
      process.env.STATION_BIN_DIR = join(tmpDir, 'bin');
      const mockExit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as never);
      const mockErr = vi.spyOn(console, 'error').mockImplementation(() => {});

      createPathLink(tmpDir); // no 'station' file in tmpDir

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
      mockErr.mockRestore();
    },
  );
});

// ─── createAppShortcut ────────────────────────────────────────────────────────

describe('createAppShortcut', () => {
  let tmpDir: string;
  let origApplicationsDir: string | undefined;
  let origLinuxAppsDir: string | undefined;
  let origUiPort: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'station-shortcut-'));
    origUiPort = process.env.STATION_UI_PORT;
    process.env.STATION_UI_PORT = '4321';
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origApplicationsDir !== undefined) {
      process.env.STATION_APPLICATIONS_DIR = origApplicationsDir;
    } else {
      delete process.env.STATION_APPLICATIONS_DIR;
    }
    if (origLinuxAppsDir !== undefined) {
      process.env.STATION_LINUX_APPS_DIR = origLinuxAppsDir;
    } else {
      delete process.env.STATION_LINUX_APPS_DIR;
    }
    if (origUiPort !== undefined) process.env.STATION_UI_PORT = origUiPort;
    else delete process.env.STATION_UI_PORT;
  });

  it.runIf(IS_WINDOWS)(
    'Windows: writes a .bat launcher to the detected desktop',
    () => {
      const desktop = execSync(
        'powershell -NoProfile -Command "[Environment]::GetFolderPath(\'Desktop\')"',
        { encoding: 'utf-8' },
      ).trim();
      const bat = join(desktop, 'Station.bat');
      if (existsSync(bat)) rmSync(bat);

      try {
        createAppShortcut('/test/repo');

        expect(existsSync(bat)).toBe(true);
        const content = readFileSync(bat, 'utf-8');
        expect(content).toContain('@echo off');
        expect(content).toContain('npx tsx');
        expect(content).toContain(
          join('/test/repo', 'packages', 'cli', 'src', 'cli.ts'),
        );
        expect(content).toContain('http://localhost:4321');
      } finally {
        if (existsSync(bat)) rmSync(bat);
      }
    },
  );

  it.runIf(IS_MAC)(
    'macOS: creates .app bundle with Info.plist and launch script',
    () => {
      origApplicationsDir = process.env.STATION_APPLICATIONS_DIR;
      process.env.STATION_APPLICATIONS_DIR = tmpDir;
      const appDir = join(tmpDir, 'Station.app');
      if (existsSync(appDir)) rmSync(appDir, { recursive: true });

      try {
        createAppShortcut('/test/repo');

        expect(existsSync(join(appDir, 'Contents', 'Info.plist'))).toBe(true);
        expect(existsSync(join(appDir, 'Contents', 'MacOS', 'launch'))).toBe(
          true,
        );
        const plist = readFileSync(
          join(appDir, 'Contents', 'Info.plist'),
          'utf-8',
        );
        expect(plist).toContain('com.station.launcher');
        const launch = readFileSync(
          join(appDir, 'Contents', 'MacOS', 'launch'),
          'utf-8',
        );
        expect(launch).toContain('http://localhost:4321');
      } finally {
        if (existsSync(appDir)) rmSync(appDir, { recursive: true });
      }
    },
  );

  it.runIf(!IS_WINDOWS && !IS_MAC)('Linux: creates .desktop entry', () => {
    origLinuxAppsDir = process.env.STATION_LINUX_APPS_DIR;
    process.env.STATION_LINUX_APPS_DIR = tmpDir;
    const desktopDir = tmpDir;
    const desktopFile = join(desktopDir, 'station.desktop');
    if (existsSync(desktopFile)) rmSync(desktopFile);

    try {
      createAppShortcut('/test/repo');

      expect(existsSync(desktopFile)).toBe(true);
      const content = readFileSync(desktopFile, 'utf-8');
      expect(content).toContain('[Desktop Entry]');
      expect(content).toContain('Name=Station');
      expect(content).toContain('http://localhost:4321');
    } finally {
      if (existsSync(desktopFile)) rmSync(desktopFile);
    }
  });
});
