/**
 * #2675: a portable server archive ships dist-server/dist-ui prebuilt and no
 * toolchain, so the CLI must recognise it and refuse to build. install.sh's
 * source release trees look similar (`.station-release.json`, no `.git`) but
 * DO build on the host, so only the archive builder's marker may qualify.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  isPrebuiltArchiveRoot,
  PREBUILT_ARCHIVE_MARKER_CONTENT,
  PREBUILT_ARCHIVE_MARKER_FILENAME,
} from '../commands/lifecycle.js';

const makeTempDir = trackTempDirs();

// The exact shape scripts/lib/container-release-metadata.mjs writes.
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
