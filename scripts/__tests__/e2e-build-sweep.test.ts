import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepInterruptedBuildDirs } from '../run-e2e-suite.mjs';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makeRoot(dirs: Array<[string, number]>): string {
  root = mkdtempSync(join(tmpdir(), 'e2e-sweep-spec-'));
  for (const [name, ageHours] of dirs) {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    const when = new Date(Date.now() - ageHours * 3600_000);
    utimesSync(path, when, when);
  }
  return root;
}

function writeDeadLease(root: string, instance: string, _outputDirs: string[]) {
  const leases = join(root, '.kontourai/e2e-runs');
  mkdirSync(leases, { recursive: true });
  writeFileSync(
    join(leases, `${instance}.json`),
    JSON.stringify({
      version: 2,
      root: resolve(root),
      instance,
      state: 'running',
      // An impossible exact daemon identity simulates an interrupted owner;
      // pid alone is deliberately not enough for a live lease.
      daemon: {
        server: { pid: 999_999, processStart: 'never', pgid: 999_999 },
        ui: { pid: 999_998, processStart: 'never', pgid: 999_998 },
        instanceId: instance,
        bootId: 'dead-boot',
      },
      outputDirs: [`dist-server-${instance}`, `dist-ui-${instance}`],
    }),
  );
}

describe('sweepInterruptedBuildDirs', () => {
  it('reclaims build output left by an interrupted run', () => {
    const r = makeRoot([
      ['dist-server-e2e-product-1785033082727-131nrj', 24],
      ['dist-ui-e2e-product-1785033082727-131nrj', 24],
    ]);
    writeDeadLease(r, 'e2e-product-1785033082727-131nrj', [
      'dist-server-e2e-product-1785033082727-131nrj',
      'dist-ui-e2e-product-1785033082727-131nrj',
    ]);
    expect(sweepInterruptedBuildDirs(r)).toBe(2);
    expect(
      existsSync(join(r, 'dist-ui-e2e-product-1785033082727-131nrj')),
    ).toBe(false);
  });

  it('never touches a concurrently running sibling suite', () => {
    // A sibling's directories are seconds old, far inside the threshold. This
    // is what makes an age-based sweep safe to run while other suites are live.
    const r = makeRoot([
      ['dist-ui-e2e-audit-live', 0],
      ['dist-ui-e2e-product-old', 24],
    ]);
    writeDeadLease(r, 'e2e-product-old', ['dist-ui-e2e-product-old']);
    expect(sweepInterruptedBuildDirs(r)).toBe(1);
    expect(existsSync(join(r, 'dist-ui-e2e-audit-live'))).toBe(true);
    expect(existsSync(join(r, 'dist-ui-e2e-product-old'))).toBe(false);
  });

  it('leaves unrelated directories alone', () => {
    const r = makeRoot([
      ['dist-ui', 48],
      ['dist-server', 48],
      ['dist-ui-phone', 48],
      ['node_modules', 48],
      ['dist-ui-e2e-product-stale', 48],
    ]);
    writeDeadLease(r, 'e2e-product-stale', ['dist-ui-e2e-product-stale']);
    expect(sweepInterruptedBuildDirs(r)).toBe(1);
    for (const keep of [
      'dist-ui',
      'dist-server',
      'dist-ui-phone',
      'node_modules',
    ]) {
      expect(existsSync(join(r, keep)), keep).toBe(true);
    }
  });

  it('is a no-op on a clean checkout', () => {
    expect(sweepInterruptedBuildDirs(makeRoot([]))).toBe(0);
  });

  it('does not throw when the root cannot be read', () => {
    expect(sweepInterruptedBuildDirs('/definitely/not/a/real/path')).toBe(0);
  });

  it('never reclaims an unleased directory, even when it is old', () => {
    const r = makeRoot([['dist-ui-e2e-product-unleased', 48]]);
    expect(sweepInterruptedBuildDirs(r)).toBe(0);
    expect(existsSync(join(r, 'dist-ui-e2e-product-unleased'))).toBe(true);
  });

  it('never reclaims a lease rooted in a different worktree', () => {
    const r = makeRoot([['dist-ui-e2e-product-foreign', 48]]);
    const leases = join(r, '.kontourai/e2e-runs');
    mkdirSync(leases, { recursive: true });
    writeFileSync(
      join(leases, 'e2e-product-foreign.json'),
      JSON.stringify({
        version: 2,
        root: '/another/worktree',
        instance: 'e2e-product-foreign',
        daemon: {
          server: { pid: 999_999, processStart: 'never', pgid: 999_999 },
          ui: { pid: 999_998, processStart: 'never', pgid: 999_998 },
          instanceId: 'e2e-product-foreign',
          bootId: 'dead-boot',
        },
        outputDirs: ['dist-ui-e2e-product-foreign'],
      }),
    );
    expect(sweepInterruptedBuildDirs(r)).toBe(0);
    expect(existsSync(join(r, 'dist-ui-e2e-product-foreign'))).toBe(true);
  });

  it('rejects a symlinked .kontourai ancestry and retains its output', () => {
    const r = makeRoot([['dist-ui-e2e-product-symlink', 48]]);
    const outside = mkdtempSync(join(tmpdir(), 'e2e-lease-outside-'));
    try {
      symlinkSync(outside, join(r, '.kontourai'));
      expect(sweepInterruptedBuildDirs(r)).toBe(0);
      expect(existsSync(join(r, 'dist-ui-e2e-product-symlink'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('retains a forged filename-to-instance binding', () => {
    const r = makeRoot([['dist-ui-e2e-product-forged', 48]]);
    writeDeadLease(r, 'e2e-product-different', []);
    const leaseDirectory = join(r, '.kontourai/e2e-runs');
    // Put a valid-looking payload under the *wrong* filename.
    writeFileSync(
      join(leaseDirectory, 'e2e-product-forged.json'),
      readFileSync(join(leaseDirectory, 'e2e-product-different.json')),
    );
    expect(sweepInterruptedBuildDirs(r)).toBe(0);
    expect(existsSync(join(r, 'dist-ui-e2e-product-forged'))).toBe(true);
  });
});
