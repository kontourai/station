import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { execFileSyncBounded } from '../lib/bounded-capture.mjs';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';
import { prepareReleaseCut, releaseCutPlan } from '../release-cut.mjs';

const identity = {
  tag: 'v0.2.0-rc.1',
  sourceSha: 'a'.repeat(40),
  currentHead: 'b'.repeat(40),
  sourceVersion: '0.2.0',
  currentVersion: '0.2.0',
};

test('first RC cut advances main to the next unreleased minor without changing the frozen source', () => {
  expect(releaseCutPlan(identity)).toMatchObject({
    sourceSha: 'a'.repeat(40),
    sourceVersion: '0.2.0',
    nextVersion: '0.3.0',
    action: 'bump',
  });
});

test('later RC/final cut is a no-op when main already has the next base', () => {
  expect(
    releaseCutPlan({ ...identity, tag: 'v0.2.0', currentVersion: '0.3.0' }),
  ).toMatchObject({ action: 'already-advanced', nextVersion: '0.3.0' });
});

test.each([
  { sourceVersion: '0.2.1' },
  { sourceSha: 'main' },
  { currentVersion: '0.2.1' },
  { tag: 'v0.2.0-preview.1' },
])('rejects a cut outside its frozen version/source contract: %o', (change) => {
  expect(() => releaseCutPlan({ ...identity, ...change })).toThrow();
});

// The command changes only the delivery branch's product mirrors after a real cut tag exists.

const cutDirectory = trackTempDirs();
test('release-cut plan is read-only and apply bumps all native mirrors while preserving the tag', () => {
  const root = cutDirectory('station-release-cut-');
  mkdirSync(join(root, 'src-desktop'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ version: '0.2.0' }) + '\n',
  );
  writeFileSync(
    join(root, 'src-desktop/tauri.conf.json'),
    JSON.stringify({ version: '0.2.0' }) + '\n',
  );
  writeFileSync(
    join(root, 'src-desktop/Cargo.toml'),
    '[package]\nname = "station"\nversion = "0.2.0"\n',
  );
  writeFileSync(
    join(root, 'src-desktop/Cargo.lock'),
    'version = 3\n\n[[package]]\nname = "station"\nversion = "0.2.0"\n',
  );
  const git = (args: string[]) =>
    execFileSyncBounded('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: sanitizedGitEnvironment(),
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Station Tests']);
  git(['config', 'user.email', 'station@example.invalid']);
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
  git(['tag', 'v0.2.0-rc.1']);
  const source = git(['rev-parse', 'refs/tags/v0.2.0-rc.1']);
  expect(prepareReleaseCut({ root, tag: 'v0.2.0-rc.1' })).toMatchObject({
    action: 'bump',
    applied: false,
  });
  expect(git(['status', '--porcelain'])).toBe('');
  expect(
    prepareReleaseCut({ root, tag: 'v0.2.0-rc.1', apply: true }),
  ).toMatchObject({ applied: true, nextVersion: '0.3.0' });
  expect(
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  ).toBe('0.3.0');
  expect(
    JSON.parse(readFileSync(join(root, 'src-desktop/tauri.conf.json'), 'utf8'))
      .version,
  ).toBe('0.3.0');
  expect(readFileSync(join(root, 'src-desktop/Cargo.toml'), 'utf8')).toContain(
    'version = "0.3.0"',
  );
  expect(readFileSync(join(root, 'src-desktop/Cargo.lock'), 'utf8')).toContain(
    'version = "0.3.0"',
  );
  expect(git(['rev-parse', 'refs/tags/v0.2.0-rc.1'])).toBe(source);
  expect(() =>
    prepareReleaseCut({ root, tag: 'v0.2.0-rc.1', apply: true }),
  ).toThrow('committed clean');
});
