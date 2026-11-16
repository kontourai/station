import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { assertNightlyReleaseBase } from '../nightly-release-base.mjs';

const temporary = trackTempDirs();
const published = (tag_name: string) => ({
  tag_name,
  draft: false,
  prerelease: tag_name.includes('-'),
});

test('Nightly base follows the highest published RC/final, not release-list order', () => {
  expect(
    assertNightlyReleaseBase('0.3.0', [
      published('v0.1.11'),
      published('v0.2.0-rc.2'),
    ]),
  ).toMatchObject({ state: 'ahead', latestPublishedTag: 'v0.2.0-rc.2' });
  expect(
    assertNightlyReleaseBase('0.2.0', [
      { ...published('v0.2.0-rc.1'), draft: true },
    ]),
  ).toMatchObject({ state: 'bootstrap' });
});

test.each(['v0.2.0', 'v0.2.0-rc.1', 'v0.3.0'])(
  'refuses Nightly base 0.2.0 behind frozen publication %s',
  (tag) => {
    expect(() => assertNightlyReleaseBase('0.2.0', [published(tag)])).toThrow(
      'must be greater',
    );
  },
);

test('CLI refuses a regressing base before any publication command', () => {
  const dir = temporary('station-nightly-base-');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ version: '0.2.0' }),
  );
  writeFileSync(
    join(dir, 'history.json'),
    JSON.stringify([published('v0.2.0-rc.1')]),
  );
  const result = spawnSyncBounded(
    process.execPath,
    [
      resolve('scripts/nightly-release-base.mjs'),
      '--package-json',
      join(dir, 'package.json'),
      '--release-history',
      join(dir, 'history.json'),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('must be greater than published v0.2.0-rc.1');
});

test('refuses missing publication state instead of treating it as bootstrap', () => {
  expect(() =>
    assertNightlyReleaseBase('0.3.0', [{ tag_name: 'v0.2.0' }]),
  ).toThrow('publication state');
});
