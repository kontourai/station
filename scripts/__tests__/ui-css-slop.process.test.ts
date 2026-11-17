import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';

const makeTempDir = trackTempDirs();
const entry = resolve('scripts/ui-css-slop.mjs');

test('the CLI passes inherited and shrinking findings, refuses growth and new files, skips token sheets, and rewrites with --update', () => {
  const cwd = makeTempDir('station-ui-css-slop-cli-');
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
  const baseline = join(cwd, 'scripts/ui-css-slop-baseline.json');
  const sheet = join(cwd, 'src-ui/src/views/Card.css');
  const run = (...args: string[]) =>
    spawnSyncBounded(process.execPath, [entry, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
  writeFileSync(sheet, '.card { color: #fff; z-index: 10; }');
  // Token and generated sheets define the values; they are never counted.
  writeFileSync(
    join(cwd, 'src-ui/src/tokens.css'),
    '.x { background: linear-gradient(#fff, #000); z-index: 99; }',
  );
  writeFileSync(
    join(cwd, 'src-ui/src/color-themes.startup.generated.css'),
    '.x { color: #123456; }',
  );
  writeFileSync(
    baseline,
    JSON.stringify({
      version: 1,
      files: {
        'src-ui/src/views/Card.css': { 'hex-color': 2, 'numeric-z-index': 1 },
      },
    }),
  );

  const inherited = run();
  expect(inherited.error).toBeUndefined();
  expect(inherited.status, inherited.stderr).toBe(0);
  expect(inherited.stdout).toContain('0 new');
  expect(inherited.stdout).toContain('below the baseline');

  // The injected violation: a gradient in a counted sheet and a blur in a
  // new one.
  writeFileSync(
    sheet,
    '.card { color: #fff; z-index: 10; background: linear-gradient(var(--k-bg), transparent); }',
  );
  writeFileSync(
    join(cwd, 'src-ui/src/views/Glass.css'),
    '.glass { backdrop-filter: blur(8px); }',
  );
  const grown = run();
  expect(grown.error).toBeUndefined();
  expect(grown.status, grown.stdout).toBe(1);
  for (const expected of [
    'src-ui/src/views/Card.css: gradient (+1); use a flat --k-* surface.',
    'background: linear-gradient(var(--k-bg), transparent)',
    'src-ui/src/views/Glass.css: backdrop-blur (+1)',
  ]) {
    expect(grown.stderr).toContain(expected);
  }
  expect(grown.stderr).not.toContain('tokens.css');
  expect(grown.stderr).not.toContain('generated.css');
  expect(grown.stderr).not.toContain('hex-color');

  const updated = run('--update');
  expect(updated.status, updated.stderr).toBe(0);
  expect(JSON.parse(readFileSync(baseline, 'utf8'))).toEqual({
    version: 1,
    files: {
      'src-ui/src/views/Card.css': {
        gradient: 1,
        'hex-color': 1,
        'numeric-z-index': 1,
      },
      'src-ui/src/views/Glass.css': { 'backdrop-blur': 1 },
    },
  });
  expect(run().status).toBe(0);

  writeFileSync(baseline, JSON.stringify({ version: 1, files: [] }));
  const malformed = run();
  expect(malformed.status).toBe(1);
  expect(malformed.stderr).toContain('UI CSS slop inventory must be an object');
}, 60_000);
