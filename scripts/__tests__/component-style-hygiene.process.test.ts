import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';

const makeTempDir = trackTempDirs();
const entry = resolve('scripts/component-style-hygiene.mjs');

test('the CLI accepts canonical untracked source and refuses new recipe debt and malformed baselines', () => {
  const cwd = makeTempDir('station-component-style-cli-');
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
  mkdirSync(join(cwd, 'src-ui/src'), { recursive: true });
  const baseline = join(cwd, 'scripts/component-style-hygiene-baseline.json');
  writeFileSync(baseline, JSON.stringify({ version: 1, files: {} }));
  const source = join(cwd, 'src-ui/src/Action.tsx');
  const css = join(cwd, 'src-ui/src/Action.css');
  const run = () =>
    spawnSyncBounded(process.execPath, [entry], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
  writeFileSync(
    source,
    '<><Button>Save</Button><Dialog title="Edit" /><button role="switch" /></>',
  );
  writeFileSync(
    css,
    '.action { padding: var(--k-space-2); content: "var(--space-4)"; }',
  );
  const accepted = run();
  expect(accepted.error).toBeUndefined();
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(accepted.stdout).toContain('0 new');

  writeFileSync(
    source,
    '<><button className="item__action">Save</button><dialog open /><aside role={"alertdialog"} /></>',
  );
  writeFileSync(css, '.action { padding: var(--space-4); }');
  const refused = run();
  expect(refused.error).toBeUndefined();
  expect(refused.status, refused.stderr).toBe(1);
  for (const finding of [
    'bespoke-action',
    'bespoke-dialog:dialog',
    'bespoke-dialog:aside',
    'legacy-token:--space-4',
  ]) {
    expect(refused.stderr).toContain(finding);
  }
  writeFileSync(baseline, JSON.stringify({ version: 1, files: null }));
  const malformed = run();
  expect(malformed.error).toBeUndefined();
  expect(malformed.status).toBe(1);
  expect(malformed.stderr).toContain(
    'Component/style inventory must be an object',
  );
}, 60_000);
