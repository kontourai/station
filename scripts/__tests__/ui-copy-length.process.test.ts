import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';

const makeTempDir = trackTempDirs();
const entry = resolve('scripts/ui-copy-length.mjs');
const VERBOSE =
  'Sharing exposes existing and future room messages to every authorized viewer. Review them for paths and secrets first. ' +
  'Turning sharing off later does not recall copies.';

test('the CLI passes inherited and shrinking copy, refuses growth and new files, and rewrites with --update', () => {
  const cwd = makeTempDir('station-ui-copy-length-cli-');
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
  const baseline = join(cwd, 'scripts/ui-copy-length-baseline.json');
  const view = join(cwd, 'src-ui/src/views/Sharing.tsx');
  const run = (...args: string[]) =>
    spawnSyncBounded(process.execPath, [entry, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
  const paragraph = `<p>${VERBOSE}</p>`;
  writeFileSync(
    view,
    `export const V = () => <section>${paragraph}</section>;`,
  );
  // The test file is excluded even though it holds the same copy.
  writeFileSync(
    join(cwd, 'src-ui/src/views/Sharing.test.tsx'),
    `const fixture = <section>${paragraph}${paragraph}</section>;`,
  );
  writeFileSync(
    baseline,
    JSON.stringify({
      version: 1,
      files: {
        'src-ui/src/views/Sharing.tsx': {
          'long-copy:text:p': 1,
          'multi-sentence:text:p': 1,
        },
      },
    }),
  );

  const inherited = run();
  expect(inherited.error).toBeUndefined();
  expect(inherited.status, inherited.stderr).toBe(0);
  expect(inherited.stdout).toContain('0 new');

  writeFileSync(view, 'export const V = () => <p>Shared with viewers.</p>;');
  const shrunk = run();
  expect(shrunk.status, shrunk.stderr).toBe(0);
  expect(shrunk.stdout).toContain('below the baseline');
  expect(shrunk.stdout).toContain('--update');

  writeFileSync(
    view,
    `export const V = () => <section>${paragraph}${paragraph}</section>;`,
  );
  writeFileSync(
    join(cwd, 'src-ui/src/views/New.tsx'),
    `export const N = () => <Row description="${VERBOSE}" aria-label="${VERBOSE}" />;`,
  );
  const grown = run();
  expect(grown.error).toBeUndefined();
  expect(grown.status, grown.stdout).toBe(1);
  for (const expected of [
    'src-ui/src/views/Sharing.tsx: long-copy:text:p (+1)',
    'src-ui/src/views/New.tsx: long-copy:attr:description (+1)',
    'src-ui/src/views/New.tsx: multi-sentence:attr:description (+1)',
    '"Sharing exposes existing and future room messages',
    'Shorten it, move explanation into a Details disclosure or tooltip, or state each fact once. See src-ui/AGENTS.md#product-copy.',
  ]) {
    expect(grown.stderr).toContain(expected);
  }
  expect(grown.stderr).not.toContain('aria-label');
  expect(grown.stderr).not.toContain('Sharing.test.tsx');

  const updated = run('--update');
  expect(updated.status, updated.stderr).toBe(0);
  expect(JSON.parse(readFileSync(baseline, 'utf8'))).toEqual({
    version: 1,
    files: {
      'src-ui/src/views/New.tsx': {
        'long-copy:attr:description': 1,
        'multi-sentence:attr:description': 1,
      },
      'src-ui/src/views/Sharing.tsx': {
        'long-copy:text:p': 2,
        'multi-sentence:text:p': 2,
      },
    },
  });
  expect(run().status).toBe(0);

  writeFileSync(baseline, JSON.stringify({ version: 1, files: null }));
  const malformed = run();
  expect(malformed.status).toBe(1);
  expect(malformed.stderr).toContain('UI copy inventory must be an object');
}, 60_000);
