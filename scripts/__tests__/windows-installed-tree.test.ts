import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectWindowsInstalledTree } from '../windows-installed-tree.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-installed-tree-'));
  roots.push(root);
  for (const name of ['dist-server', 'node_modules', 'schemas'])
    mkdirSync(join(root, name));
  for (const name of [
    'station-nightly.exe',
    'dist-server/command-station.js',
    'dist-server/station-build.json',
    'node_modules/runtime.js',
    'schemas/schema.json',
  ])
    writeFileSync(join(root, name), name);
  return root;
}
it('detects obsolete files even when expected runtime bytes still match', () => {
  const root = fixture();
  const clean = inspectWindowsInstalledTree(root).summary;
  writeFileSync(join(root, 'station.exe'), 'old executable');
  const upgraded = inspectWindowsInstalledTree(root).summary;
  expect(upgraded.runtimeSha256).toBe(clean.runtimeSha256);
  expect(upgraded.fullSha256).not.toBe(clean.fullSha256);
});
it('detects changed runtime bytes and refuses a missing server entry', () => {
  const root = fixture();
  const clean = inspectWindowsInstalledTree(root).summary;
  writeFileSync(join(root, 'node_modules/runtime.js'), 'corrupted');
  expect(inspectWindowsInstalledTree(root).summary.runtimeSha256).not.toBe(
    clean.runtimeSha256,
  );
  rmSync(join(root, 'dist-server/command-station.js'));
  expect(() => inspectWindowsInstalledTree(root)).toThrow();
});
it('excludes only the installer-owned uninstaller from comparisons', () => {
  const root = fixture();
  const clean = inspectWindowsInstalledTree(root).summary;
  writeFileSync(join(root, 'uninstall.exe'), 'installer-generated');
  expect(inspectWindowsInstalledTree(root).summary).toEqual(clean);
});
