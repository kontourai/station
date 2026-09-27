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

const recorded = vi.hoisted(() => ({ runners: [] as unknown[] }));
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
    assertWindowsPathsTrusted: record,
    ensureWindowsDirectoriesTrusted: record,
    hardenWindowsPathsTrusted: record,
  };
});

import { readDesktopCompanion } from '../commands/desktop-companion.js';
import { ensureProfileStoreGenesis } from '../commands/profile-store.js';
import { createTriageRunDirectory } from '../commands/triage.js';
import { runWindowsTrustCommand } from '../commands/windows-path-trust.js';

const makeTempDir = trackTempDirs();
const temporaryDirectory = () => makeTempDir('station-trust-callers-');

afterEach(() => {
  recorded.runners = [];
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

  it('desktop companion registration', () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, 'runtime'));
    writeFileSync(join(home, 'runtime', 'desktop-companion.json'), '{}');
    // The trust check is the Windows branch of the registration read.
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    expect(() => readDesktopCompanion(home)).toThrow(Stop);
    expect(recorded.runners).toEqual([runWindowsTrustCommand]);
  });
});
