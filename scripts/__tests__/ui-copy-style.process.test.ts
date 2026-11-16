import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';

const makeTempDir = trackTempDirs();
const entry = resolve('scripts/ui-copy-style.mjs');

test('the CLI passes inherited and shrinking findings, refuses growth and new files, and rewrites with --update', () => {
  const cwd = makeTempDir('station-ui-copy-style-cli-');
  const env = sanitizedGitEnvironment();
  const git = spawnSyncBounded('git', ['init', '--quiet'], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  expect(git.error).toBeUndefined();
  expect(git.status, git.stderr).toBe(0);
  mkdirSync(join(cwd, 'scripts'));
  mkdirSync(join(cwd, 'src-ui/src/views'), { recursive: true });
  const baseline = join(cwd, 'scripts/ui-copy-style-baseline.json');
  const view = join(cwd, 'src-ui/src/views/Sync.tsx');
  const run = (...args: string[]) =>
    spawnSyncBounded(process.execPath, [entry, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
  writeFileSync(
    view,
    'export const V = () => <p>Station reconciled the run. Loading...</p>;',
  );
  // The test file is excluded even though it holds the same copy.
  writeFileSync(
    join(cwd, 'src-ui/src/views/Sync.test.tsx'),
    'const f = <p>Station reconciled the authority — again!</p>;',
  );
  writeFileSync(
    baseline,
    JSON.stringify({
      version: 1,
      files: {
        'src-ui/src/views/Sync.tsx': {
          'jargon:reconcile': 2,
          'ascii-ellipsis': 1,
        },
      },
    }),
  );

  const inherited = run();
  expect(inherited.error).toBeUndefined();
  expect(inherited.status, inherited.stderr).toBe(0);
  expect(inherited.stdout).toContain('0 new');
  // One reconcile finding against a baseline of two is shrinkage.
  expect(inherited.stdout).toContain('below the baseline');
  expect(inherited.stdout).toContain('--update');

  // The injected violation: visible copy gains a jargon word and an em-dash
  // aside, and a new file gains an issue reference.
  writeFileSync(
    view,
    'export const V = () => <p>Station reconciled the authority — again. Loading...</p>;',
  );
  writeFileSync(
    join(cwd, 'src-ui/src/views/New.tsx'),
    'export const N = () => <Row description="Fixed in station#1234." />;',
  );
  const grown = run();
  expect(grown.error).toBeUndefined();
  expect(grown.status, grown.stdout).toBe(1);
  for (const expected of [
    'src-ui/src/views/Sync.tsx: jargon:authority (+1)',
    'src-ui/src/views/Sync.tsx: em-dash (+1)',
    'src-ui/src/views/New.tsx: issue-ref (+1)',
    '"Station reconciled the authority — again. Loading..."',
    'do not widen the baseline. See docs/guides/ui-copy.md.',
  ]) {
    expect(grown.stderr).toContain(expected);
  }
  expect(grown.stderr).not.toContain('jargon:reconcile');
  expect(grown.stderr).not.toContain('Sync.test.tsx');

  const updated = run('--update');
  expect(updated.status, updated.stderr).toBe(0);
  expect(JSON.parse(readFileSync(baseline, 'utf8'))).toEqual({
    version: 1,
    files: {
      'src-ui/src/views/New.tsx': { 'issue-ref': 1 },
      'src-ui/src/views/Sync.tsx': {
        'ascii-ellipsis': 1,
        'em-dash': 1,
        'jargon:authority': 1,
        'jargon:reconcile': 1,
      },
    },
  });
  expect(run().status).toBe(0);

  writeFileSync(baseline, JSON.stringify({ version: 1, files: null }));
  const malformed = run();
  expect(malformed.status).toBe(1);
  expect(malformed.stderr).toContain(
    'UI copy style inventory must be an object',
  );
}, 60_000);
