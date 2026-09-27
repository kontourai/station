/**
 * #2675: a portable server archive ships dist-server/dist-ui prebuilt and no
 * toolchain, so the CLI must recognise it and refuse to build. install.sh's
 * source release trees look similar (`.station-release.json`, no `.git`) but
 * DO build on the host, so only the archive builder's marker may qualify.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { resolveLifecycleInstanceId } from '../commands/helpers.js';
import {
  isPrebuiltArchiveRoot,
  PREBUILT_ARCHIVE_MARKER_CONTENT,
  PREBUILT_ARCHIVE_MARKER_FILENAME,
} from '../commands/lifecycle.js';
import { resolveLifecycleCodeRoot } from '../commands/lifecycle-code-root.js';

const makeTempDir = trackTempDirs();

// The exact shape scripts/lib/container-release-metadata.mjs writes (the
// portable archive builder embeds it as .station-release.json).
const RELEASE = {
  schemaVersion: 2,
  sha: 'a'.repeat(40),
  ref: 'v0.0.0',
  createdAt: '2026-09-26T00:00:00.000Z',
  channel: 'stable',
  releaseChannel: 'stable',
  prerelease: false,
};

function tree({
  marker = PREBUILT_ARCHIVE_MARKER_CONTENT as string | null,
  release = RELEASE as unknown,
  git = false,
} = {}) {
  const root = makeTempDir('station-prebuilt-archive-');
  writeFileSync(
    join(root, '.station-release.json'),
    `${JSON.stringify(release, null, 2)}\n`,
  );
  if (marker !== null) {
    writeFileSync(join(root, PREBUILT_ARCHIVE_MARKER_FILENAME), marker);
  }
  if (git) mkdirSync(join(root, '.git'));
  return root;
}

describe('isPrebuiltArchiveRoot', () => {
  test('recognises an archive tree: marker, valid provenance, no checkout', () => {
    expect(PREBUILT_ARCHIVE_MARKER_FILENAME).toBe('.station-prebuilt-archive');
    expect(isPrebuiltArchiveRoot(tree())).toBe(true);
  });

  test('does not claim an install.sh release tree, which builds on the host', () => {
    expect(isPrebuiltArchiveRoot(tree({ marker: null }))).toBe(false);
  });

  test('does not claim a checkout even when a marker is present', () => {
    expect(isPrebuiltArchiveRoot(tree({ git: true }))).toBe(false);
  });

  test('requires the exact marker and valid release provenance', () => {
    expect(isPrebuiltArchiveRoot(tree({ marker: 'something else\n' }))).toBe(
      false,
    );
    expect(
      isPrebuiltArchiveRoot(tree({ release: { ...RELEASE, extra: true } })),
    ).toBe(false);
  });
});

/**
 * #2675 B1: where lifecycle state lives. A source tree keeps it inside itself
 * (unchanged); a prebuilt archive, which the installer marks read-only and an
 * upgrade replaces with a sibling version directory, keeps it under
 * `<STATION_ROOT>/state/<channel>/` so every version of a channel shares it.
 */
describe('resolveLifecycleCodeRoot', () => {
  test("puts an archive's state under STATION_ROOT/state/<channel>, outside the archive", () => {
    const root = tree();
    const stationRoot = makeTempDir('station-root-');
    const codeRoot = resolveLifecycleCodeRoot(root, {
      STATION_ROOT: stationRoot,
    });
    expect(codeRoot).toEqual({
      kind: 'prebuilt-archive',
      root,
      release: RELEASE,
      stateDir: join(stationRoot, 'state', 'stable'),
      instanceStateDir: join(stationRoot, 'state', 'stable', 'instances'),
    });
  });

  test("names the archive's own runtime channel, not the ring or the caller's", () => {
    const root = tree({
      release: {
        ...RELEASE,
        ref: 'v0.0.0-preview.1',
        channel: 'beta',
        releaseChannel: 'preview',
        prerelease: true,
      },
    });
    const stationRoot = makeTempDir('station-root-');
    expect(
      resolveLifecycleCodeRoot(root, {
        STATION_ROOT: stationRoot,
        STATION_CHANNEL: 'stable',
      }).stateDir,
    ).toBe(join(stationRoot, 'state', 'beta'));
  });

  test('derives STATION_ROOT as the rest of Station does when it is unset', () => {
    const root = tree();
    const derivedRoot = makeTempDir('station-derived-root-');
    // An instance-leaf STATION_HOME derives its containing root.
    expect(
      resolveLifecycleCodeRoot(root, {
        STATION_HOME: join(derivedRoot, 'instances', 'stable'),
      }).stateDir,
    ).toBe(join(derivedRoot, 'state', 'stable'));
    // Neither set: the user's ~/.station.
    expect(resolveLifecycleCodeRoot(root, {}).stateDir).toBe(
      join(homedir(), '.station', 'state', 'stable'),
    );
  });

  test('keeps a source tree and an install.sh release tree exactly where they were', () => {
    for (const root of [tree({ git: true }), tree({ marker: null })]) {
      expect(
        resolveLifecycleCodeRoot(root, { STATION_ROOT: '/ignored' }),
      ).toEqual({
        kind: 'source',
        root,
        stateDir: join(root, '.station'),
        instanceStateDir: join(root, '.station', 'instances'),
        buildCandidatesDir: join(root, '.station', 'build-candidates'),
        pidFile: join(root, '.station.pids'),
      });
    }
  });
});

describe('resolveLifecycleInstanceId across code roots', () => {
  const identity = () => ({
    projectHome: makeTempDir('station-archive-home-'),
    serverPort: 45123,
    uiPort: 45127,
  });

  test('two version directories of one channel give one instance its one id', () => {
    const target = identity();
    const versionA = tree();
    const versionB = tree({
      release: { ...RELEASE, sha: 'b'.repeat(40), ref: 'v0.0.1' },
    });
    const idA = resolveLifecycleInstanceId({ ...target, cwd: versionA });
    const idB = resolveLifecycleInstanceId({ ...target, cwd: versionB });
    expect(idB).toBe(idA);
    expect(idA).toBe(
      `instance-${createHash('sha1')
        .update(
          JSON.stringify({
            prebuiltArchiveChannel: 'stable',
            projectHome: target.projectHome,
            serverPort: target.serverPort,
            uiPort: target.uiPort,
          }),
        )
        .digest('hex')
        .slice(0, 12)}`,
    );
  });

  test('a source checkout still hashes its own path, so two checkouts stay apart', () => {
    const target = identity();
    const checkoutA = tree({ git: true });
    const checkoutB = tree({ git: true });
    const idA = resolveLifecycleInstanceId({ ...target, cwd: checkoutA });
    expect(resolveLifecycleInstanceId({ ...target, cwd: checkoutB })).not.toBe(
      idA,
    );
    // The pre-#2675 derivation, pinned: existing checkout records keep their id.
    expect(idA).toBe(
      `instance-${createHash('sha1')
        .update(
          JSON.stringify({
            cwd: checkoutA,
            projectHome: target.projectHome,
            serverPort: target.serverPort,
            uiPort: target.uiPort,
          }),
        )
        .digest('hex')
        .slice(0, 12)}`,
    );
  });

  test('an explicit --instance name is unaffected by the code root', () => {
    expect(
      resolveLifecycleInstanceId({
        ...identity(),
        cwd: tree(),
        instanceName: 'Named Box',
      }),
    ).toBe('named-box');
  });
});
