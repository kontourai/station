import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  execFileSyncBounded,
  spawnSyncBounded,
} from '../lib/bounded-capture.mjs';

const temps = trackTempDirs();
const script = resolve(import.meta.dirname, '../pr-delivery-plan.mjs');

function fixture(path: string) {
  const root = temps('delivery-plan-');
  const git = (...args: string[]) =>
    execFileSyncBounded('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(root, 'no-global-config'),
        GIT_CONFIG_NOSYSTEM: '1',
      },
    }).trim();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(root, 'base'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), 'changed');
  git('add', '.');
  git('commit', '-qm', 'candidate');
  return { root, base, head: git('rev-parse', 'HEAD') };
}

function run(f: ReturnType<typeof fixture>, base = f.base) {
  const output = join(f.root, 'outputs');
  const result = spawnSyncBounded(process.execPath, [script, base, f.head], {
    cwd: f.root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  return { result, output };
}

describe('delivery planning through the real Git CLI', () => {
  test.each([
    ['install.sh', ['install', 'portable', 'ecosystem']],
    ['src-desktop/src/lib.rs', ['native', 'desktop']],
    ['pnpm-lock.yaml', ['portable', 'desktop']],
    ['docs/unrelated.md', []],
    [
      '.github/workflows/delivery-validation.yml',
      ['install', 'portable', 'native', 'desktop', 'ecosystem'],
    ],
    [
      'scripts/pr-delivery-paths.json',
      ['install', 'portable', 'native', 'desktop', 'ecosystem'],
    ],
  ])('routes %s without losing the remaining families', (path, expected) => {
    const { result, output } = run(fixture(path));
    expect(result.status, result.stderr).toBe(0);
    const selected = readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.endsWith('=true'))
      .map((line) => line.split('=')[0]);
    expect(selected.sort()).toEqual([...expected].sort());
  });

  test('rejects a missing Git base rather than emitting an empty successful plan', () => {
    const { result } = run(fixture('install.sh'), 'a'.repeat(40));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('git diff');
  });

  test('rejects non-SHA input before invoking Git', () => {
    const { result } = run(fixture('install.sh'), '--help');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exact base and head SHAs');
  });
});
