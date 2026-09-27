/**
 * #2805 — every CLI caller of the Windows trust operations runs them through
 * the one shared runner (and so its cold-host budget), not a private
 * spawnSync with its own timeout or none. Each trust operation is replaced by
 * a recorder that captures the runner it was handed and stops the caller.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const recorded = vi.hoisted(() => ({
  runners: [] as unknown[],
  // Stands in for the shared runner: records the budget, spawns nothing.
  shared: vi.fn((_command: string, _args: string[], _options?: unknown) => ({
    status: 0,
    stdout: '{"trusted":true}',
  })),
}));
class Stop extends Error {}

vi.mock('../commands/windows-path-trust.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../commands/windows-path-trust.js')>();
  const record = (run: unknown) => {
    recorded.runners.push(run);
    throw new Stop('recorded');
  };
  return {
    ...actual,
    runWindowsTrustCommand: recorded.shared,
    assertWindowsPathsTrusted: record,
    ensureWindowsDirectoriesTrusted: record,
    hardenWindowsPathsTrusted: record,
  };
});

import {
  DESKTOP_COMPANION_TRUST_TIMEOUT_MS,
  readDesktopCompanion,
} from '../commands/desktop-companion.js';
import { ensureProfileStoreGenesis } from '../commands/profile-store.js';
import { createTriageRunDirectory } from '../commands/triage.js';
import { runWindowsTrustCommand } from '../commands/windows-path-trust.js';

const makeTempDir = trackTempDirs();
const temporaryDirectory = () => makeTempDir('station-trust-callers-');

afterEach(() => {
  recorded.runners = [];
  recorded.shared.mockClear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('CLI Windows trust callers use the shared runner (#2805)', () => {
  it('profile store genesis', () => {
    expect(() => ensureProfileStoreGenesis(temporaryDirectory())).toThrow(Stop);
    expect(recorded.runners).toEqual([runWindowsTrustCommand]);
  });

  it('triage storage', () => {
    vi.stubEnv('STATION_ROOT', temporaryDirectory());
    expect(() => createTriageRunDirectory()).toThrow(Stop);
    expect(recorded.runners).toEqual([runWindowsTrustCommand]);
  });

  it('desktop companion registration, on its short per-tick budget', () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, 'runtime'));
    writeFileSync(join(home, 'runtime', 'desktop-companion.json'), '{}');
    // The trust check is the Windows branch of the registration read.
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    expect(() => readDesktopCompanion(home)).toThrow(Stop);
    expect(recorded.runners).toHaveLength(1);
    // The supervisor reads this every 5s tick: the shared runner, with a
    // 10s budget in place of the 120s cold-host default the operation asks for.
    expect(DESKTOP_COMPANION_TRUST_TIMEOUT_MS).toBe(10_000);
    const run = recorded.runners[0] as (
      command: string,
      args: string[],
      options?: { timeout: number },
    ) => unknown;
    run('powershell.exe', ['-NoProfile'], { timeout: 120_000 });
    expect(recorded.shared.mock.calls).toEqual([
      ['powershell.exe', ['-NoProfile'], { timeout: 10_000 }],
    ]);
  });
});
