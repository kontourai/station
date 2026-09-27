/**
 * #2675 B1: the REAL helpers and lifecycle modules, loaded from an
 * archive-shaped (or checkout-shaped) working directory, agree on where an
 * instance's lifecycle record lives. lifecycle.test.ts mocks helpers.ts, so
 * this is the test that reaches helpers' own wiring: the code root it derives
 * from the working directory at import, and the home-derived state location
 * every lifecycle reader and writer goes through.
 */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const makeTempDir = trackTempDirs();

// The exact .station-release.json the portable archive builder embeds.
const RELEASE = {
  schemaVersion: 2,
  sha: 'a'.repeat(40),
  ref: 'v0.0.0',
  createdAt: '2026-09-26T00:00:00.000Z',
  channel: 'stable',
  releaseChannel: 'stable',
  prerelease: false,
};

function archiveTree(): string {
  const root = makeTempDir('station-real-archive-');
  writeFileSync(
    join(root, '.station-release.json'),
    `${JSON.stringify(RELEASE, null, 2)}\n`,
  );
  writeFileSync(
    join(root, '.station-prebuilt-archive'),
    'station-prebuilt-archive-v1\n',
  );
  return root;
}

function listing(root: string): string[] {
  return readdirSync(root, { recursive: true }).map(String).sort();
}

/** Imports helpers and lifecycle afresh as if the CLI ran from `cwd`. */
async function loadFrom(cwd: string) {
  vi.resetModules();
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const helpers = await import('../commands/helpers.js');
  const lifecycle = await import('../commands/lifecycle.js');
  return { helpers, lifecycle };
}

/** A live record (this test process) with no boot identity to probe. */
function writeLiveRecord(statePath: string, baseDir: string): void {
  const directory = join(statePath, '..');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  writeFileSync(
    statePath,
    JSON.stringify({
      instanceId: 'spelled',
      serverPid: process.pid,
      uiPid: null,
      serverPort: 45211,
      uiPort: 45215,
      baseDir,
      homeSource: '--home',
      startedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  if (process.platform !== 'win32') chmodSync(statePath, 0o600);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('lifecycle state location through the real helpers (#2675)', () => {
  test('an archive finds one record whether its home came from STATION_HOME or a flag', async () => {
    const archive = archiveTree();
    const home = makeTempDir('station-real-home-');
    // No ambient root: the home alone decides it, as for a user's shell.
    vi.stubEnv('STATION_ROOT', '');
    vi.stubEnv('STATION_HOME', home);
    const { helpers, lifecycle } = await loadFrom(archive);
    expect(helpers.LIFECYCLE_CODE_ROOT).toEqual({
      kind: 'prebuilt-archive',
      root: archive,
      release: RELEASE,
    });

    // A raw home is its own Station root.
    const instanceStateDir = join(home, 'state', 'stable', 'instances');
    expect(helpers.resolveLifecycleState().instanceStateDir).toBe(
      instanceStateDir,
    );
    expect(helpers.resolveLifecycleState(home).instanceStateDir).toBe(
      instanceStateDir,
    );
    const statePath = helpers.getInstanceStatePath('spelled', home);
    expect(statePath).toBe(join(instanceStateDir, 'spelled.json'));
    const before = listing(archive);
    writeLiveRecord(statePath, home);

    // `STATION_HOME=<home> station status`: the bare command's home.
    expect(
      (
        await lifecycle.collectInstanceStatus('spelled', {
          reclaimStale: false,
        })
      ).found,
    ).toBe(true);

    // `station stop --home=<home>` from a shell whose STATION_HOME is
    // another home, after the CLI bootstrap has written the default root
    // into STATION_ROOT (it does, unless STATION_HOME names a raw home): the
    // flag's home decides, not the environment.
    vi.stubEnv('STATION_HOME', makeTempDir('station-other-home-'));
    vi.stubEnv('STATION_ROOT', makeTempDir('station-bootstrap-root-'));
    expect(
      lifecycle.isRunning({ instanceName: 'spelled', stateHome: home }),
    ).toBe(true);
    expect(
      (
        await lifecycle.collectInstanceStatus('spelled', {
          reclaimStale: false,
          projectHome: home,
        })
      ).found,
    ).toBe(true);
    expect(listing(archive)).toEqual(before);
  });

  test("a checkout keeps its records in itself, whatever the instance's home", async () => {
    const checkout = makeTempDir('station-real-checkout-');
    mkdirSync(join(checkout, '.git'));
    const home = makeTempDir('station-real-home-');
    vi.stubEnv('STATION_ROOT', '');
    const { helpers, lifecycle } = await loadFrom(checkout);
    expect(helpers.LIFECYCLE_CODE_ROOT).toEqual({
      kind: 'source',
      root: checkout,
    });
    expect(helpers.resolveLifecycleState(home)).toEqual({
      stateDir: join(checkout, '.station'),
      instanceStateDir: join(checkout, '.station', 'instances'),
      buildCandidatesDir: join(checkout, '.station', 'build-candidates'),
      pidFile: join(checkout, '.station.pids'),
    });
    const statePath = helpers.getInstanceStatePath('spelled', home);
    expect(statePath).toBe(
      join(checkout, '.station', 'instances', 'spelled.json'),
    );
    writeLiveRecord(statePath, home);
    // Found with no home at all, as before #2675.
    expect(lifecycle.isRunning({ instanceName: 'spelled' })).toBe(true);
    if (process.platform !== 'win32') {
      expect(
        statSync(join(checkout, '.station', 'instances')).mode & 0o777,
      ).toBe(0o700);
    }
  });
});
