import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const dirs: string[] = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runGate(root: string) {
  return execFileSync(
    process.execPath,
    [join(process.cwd(), 'scripts', 'lockfile-sync-gate.mjs')],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
}

test('version pipeline pins lock regeneration and the real gate rejects then recovers stale workspace metadata', () => {
  const rootScript = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  ).scripts['version-packages'];
  expect(rootScript).toBe(
    'changeset version && npm install --package-lock-only --ignore-scripts --force && npm run lockfile-sync:gate',
  );
  expect(
    readFileSync(
      join(process.cwd(), '.github/workflows/publish-packages.yml'),
      'utf8',
    ),
  ).toMatch(/^\s*version-script: npm run version-packages$/m);

  const root = mkdtempSync(join(tmpdir(), 'station-release-lock-'));
  dirs.push(root);
  mkdirSync(join(root, 'packages', 'a'), { recursive: true });
  mkdirSync(join(root, 'packages', 'b'), { recursive: true });
  writeJson(join(root, 'package.json'), {
    name: 'fixture-root',
    version: '1.0.0',
    private: true,
    workspaces: ['packages/a', 'packages/b'],
    dependencies: { 'fixture-a': '^1.0.0' },
  });
  writeJson(join(root, 'packages', 'a', 'package.json'), {
    name: 'fixture-a',
    version: '1.0.0',
    private: true,
    dependencies: { 'fixture-b': '^1.0.0' },
  });
  writeJson(join(root, 'packages', 'b', 'package.json'), {
    name: 'fixture-b',
    version: '1.0.0',
    private: true,
    devDependencies: { 'fixture-a': '^1.0.0' },
    peerDependencies: { 'fixture-a': '^1.0.0' },
  });

  // No registry dependencies exist in this fixture; this creates its lock
  // entirely locally and proves the exact release repair stays network-free.
  execFileSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--force',
      '--no-audit',
    ],
    { cwd: root, windowsHide: true },
  );

  writeJson(join(root, 'package.json'), {
    name: 'fixture-root',
    version: '1.0.0',
    private: true,
    workspaces: ['packages/a', 'packages/b'],
    dependencies: { 'fixture-a': '^1.0.1' },
  });
  writeJson(join(root, 'packages', 'a', 'package.json'), {
    name: 'fixture-a',
    version: '1.0.1',
    private: true,
    dependencies: { 'fixture-b': '^1.0.0' },
  });
  writeJson(join(root, 'packages', 'b', 'package.json'), {
    name: 'fixture-b',
    version: '1.0.0',
    private: true,
    devDependencies: { 'fixture-a': '^1.0.1' },
    peerDependencies: { 'fixture-a': '~1.0.1' },
  });

  let failure: { stderr?: string } | undefined;
  try {
    runGate(root);
  } catch (error) {
    failure = error as { stderr?: string };
  }
  expect(failure).toBeDefined();
  expect(failure?.stderr).toContain('root dependencies.fixture-a');
  expect(failure?.stderr).toContain('packages/a version');
  expect(failure?.stderr).toContain('packages/b devDependencies.fixture-a');
  expect(failure?.stderr).toContain('packages/b peerDependencies.fixture-a');

  execFileSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--force',
      '--no-audit',
    ],
    { cwd: root, windowsHide: true },
  );
  expect(runGate(root)).toContain('Lockfile sync gate:');
});
