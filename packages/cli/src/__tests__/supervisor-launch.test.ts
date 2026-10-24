// @vitest-environment node
/**
 * Whether a lifecycle start runs the core server under the process
 * supervisor, and the supervisor's arguments when it does.
 */
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  INSTALL_ROOT_MARKER_CONTENT,
  INSTALL_ROOT_MARKER_FILENAME,
} from '@kontourai/station-shared/prebuilt-archive';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  DIRECT_LAUNCH_ENV,
  planServerLaunch,
  SUPERVISOR_BUNDLE_FILENAME,
} from '../commands/supervisor-launch.js';

const makeTempDir = trackTempDirs();

function codeRootWithBuild(): { codeRoot: string; serverDir: string } {
  const codeRoot = makeTempDir('supervisor-launch-');
  const serverDir = join(codeRoot, 'dist-server-work');
  mkdirSync(serverDir);
  writeFileSync(join(serverDir, 'command-station.js'), '');
  writeFileSync(join(serverDir, SUPERVISOR_BUNDLE_FILENAME), '');
  return { codeRoot, serverDir };
}

function plan(
  overrides: Partial<Parameters<typeof planServerLaunch>[0]> = {},
  build = codeRootWithBuild(),
) {
  return planServerLaunch({
    serverDir: build.serverDir,
    entry: join(build.serverDir, 'command-station.js'),
    projectHome: '/homes/work',
    instanceId: 'work',
    codeRoot: build.codeRoot,
    watch: false,
    env: {},
    ...overrides,
  });
}

describe('planServerLaunch', () => {
  it('names the bundle the server build writes', async () => {
    // The build options are plain JavaScript; read the name they export.
    const { SUPERVISOR_BUNDLE_NAME } = (await import(
      pathToFileURL(
        join(import.meta.dirname, '../../../supervisor/build-options.mjs'),
      ).href
    )) as { SUPERVISOR_BUNDLE_NAME: string };
    expect(SUPERVISOR_BUNDLE_FILENAME).toBe(SUPERVISOR_BUNDLE_NAME);
    expect(SUPERVISOR_BUNDLE_FILENAME).toBe('station-supervisor.js');
  });

  it('runs the supervisor beside the server bundle, for the home and instance', () => {
    const build = codeRootWithBuild();
    expect(plan({}, build)).toEqual({
      supervised: true,
      args: [
        join(build.serverDir, 'station-supervisor.js'),
        '--entry',
        join(build.serverDir, 'command-station.js'),
        '--home',
        '/homes/work',
        '--instance',
        'work',
      ],
    });
  });

  it('tells the supervisor to watch the launcher that supervises the start', () => {
    const launch = plan({ parentPid: 4321 });
    expect(launch.supervised && launch.args.slice(-2)).toEqual([
      '--parent-pid',
      '4321',
    ]);
  });

  it(`starts directly, quietly, when ${DIRECT_LAUNCH_ENV}=1, for --watch, and with a lifecycle journal`, () => {
    for (const overrides of [
      { env: { [DIRECT_LAUNCH_ENV]: '1' } },
      { watch: true },
      { lifecycleJournal: '/journals/work.ndjson' },
    ]) {
      expect(plan(overrides)).toEqual({ supervised: false, notice: null });
    }
    // Only `1` opts out.
    expect(plan({ env: { [DIRECT_LAUNCH_ENV]: '0' } }).supervised).toBe(true);
  });

  it('starts directly, saying why, for a build without the bundle or an unnameable instance', () => {
    const codeRoot = makeTempDir('supervisor-launch-old-');
    const serverDir = join(codeRoot, 'dist-server');
    mkdirSync(serverDir);
    const old = plan({}, { codeRoot, serverDir });
    expect(old).toMatchObject({ supervised: false });
    expect(old.supervised === false && old.notice).toContain(
      'This build has no process supervisor',
    );
    const unnameable = plan({ instanceId: '-bad' });
    expect(unnameable.supervised === false && unnameable.notice).toContain(
      "Instance id '-bad' cannot name a supervisor control channel",
    );
  });

  it('bounds handoffs to every version of an install.sh archive', () => {
    const installRoot = makeTempDir('supervisor-launch-install-');
    writeFileSync(
      join(installRoot, INSTALL_ROOT_MARKER_FILENAME),
      INSTALL_ROOT_MARKER_CONTENT,
    );
    const codeRoot = join(installRoot, 'versions', '1.2.3');
    const serverDir = join(codeRoot, 'dist-server');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, SUPERVISOR_BUNDLE_FILENAME), '');
    // The service runs the active version through `current`.
    symlinkSync(codeRoot, join(installRoot, 'current'));
    const launch = plan(
      { codeRoot: join(installRoot, 'current') },
      {
        codeRoot,
        serverDir,
      },
    );
    expect(launch.supervised && launch.args.slice(-2)).toEqual([
      '--build-root',
      // Physical: the supervisor resolves it to its real path anyway.
      join(realpathSync(installRoot), 'versions'),
    ]);
    // Any other tree keeps the supervisor's default (the entry's directory).
    const elsewhere = plan();
    expect(elsewhere.supervised && elsewhere.args).not.toContain(
      '--build-root',
    );
  });
});
