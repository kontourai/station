import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectProcessFingerprint } from '../../../packages/cli/src/commands/platform.js';
import {
  reapAllLongRunningFixtureChildren,
  spawnLongRunningFixtureChild,
} from './longrunning-fixture-child.js';
import {
  observeFixtureCwds,
  runFixtureCwdLsof,
  StationFixtureOwner,
} from './station-fixture-owner.js';

const roots = new Set<string>();

afterEach(async () => {
  await reapAllLongRunningFixtureChildren();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-fixture-owner-'));
  roots.add(root);
  return join(root, 'instance.json');
}

function writeState(path: string, pid: number): void {
  const fingerprint = inspectProcessFingerprint(pid);
  if (!fingerprint) throw new Error(`fixture process ${pid} is unavailable`);
  writeFileSync(
    path,
    JSON.stringify({ serverPid: pid, serverFingerprint: fingerprint }),
    { mode: 0o600 },
  );
}

async function expectGone(pid: number): Promise<void> {
  await expect
    .poll(() => inspectProcessFingerprint(pid), { timeout: 1_000 })
    .toBeNull();
}

describe('StationFixtureOwner', () => {
  it('uses one bounded nonblocking lsof cwd scan', () => {
    const calls: unknown[][] = [];
    const result = runFixtureCwdLsof((command, args, options) => {
      calls.push([command, args, options]);
      return {
        signal: null,
        status: 0,
        stderr: '',
        stdout: 'p123\nfcwd\nn/tmp\n',
      };
    });

    expect(result).toEqual({
      signal: null,
      status: 0,
      stderr: '',
      stdout: 'p123\nfcwd\nn/tmp\n',
    });
    expect(calls).toEqual([
      [
        'lsof',
        ['-n', '-P', '-S', '2', '-a', '-d', 'cwd', '-Fn'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 3_000,
          windowsHide: true,
        },
      ],
    ]);
  });

  it('fails closed when lsof exits zero with an incomplete-output warning', () => {
    expect(
      observeFixtureCwds([tmpdir()], () => ({
        signal: null,
        status: 0,
        stderr: 'lsof: WARNING: output information may be incomplete\n',
        stdout: 'p123\nfcwd\nn/tmp\n',
      })),
    ).toEqual({ source: 'none', reason: 'lsof-warning;partial=true' });
  });

  it.runIf(process.platform === 'darwin')(
    'observes a real canonical private-var cwd without lsof warnings',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-fixture-owner-cwd-'));
      roots.add(root);
      const canonicalRoot = realpathSync(root);
      const child = await spawnLongRunningFixtureChild({ cwd: root });
      if (!child.pid) throw new Error('fixture child has no pid');
      const childPid = child.pid;

      await expect
        .poll(() => {
          const observed = observeFixtureCwds([root]);
          if (observed.source !== 'lsof') return observed;
          return observed.owners.get(canonicalRoot)?.has(childPid) ?? false;
        })
        .toBe(true);
    },
    12_000,
  );

  it('observes fixture cwd residue without recursively walking fixture files', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'station-fixture-owner-cwd-'));
    const secondRoot = mkdtempSync(
      join(tmpdir(), 'station-fixture-owner-cwd-'),
    );
    roots.add(firstRoot);
    roots.add(secondRoot);
    const canonicalFirstRoot = realpathSync(firstRoot);
    const canonicalSecondRoot = realpathSync(secondRoot);
    const observed = observeFixtureCwds([firstRoot, secondRoot], () => ({
      signal: null,
      status: 0,
      stdout: `p123\nfcwd\nn${canonicalFirstRoot}\np456\nfcwd\nn${canonicalSecondRoot}/nested\np789\nfcwd\nn${realpathSync(tmpdir())}\n`,
    }));

    expect(observed.source).toBe('lsof');
    if (observed.source === 'lsof') {
      expect([...observed.owners.values()].map((pids) => [...pids])).toEqual([
        [123],
        [456],
      ]);
    }
  });

  it('retains a registered canonical root after deletion for a deleted cwd report', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-fixture-owner-cwd-'));
    const canonicalRoot = realpathSync(root);
    const owner = new StationFixtureOwner({
      observeFixtureCwds: (fixtureRoots) => {
        expect(fixtureRoots).toEqual([canonicalRoot]);
        return observeFixtureCwds(fixtureRoots, () => ({
          signal: null,
          status: 0,
          stdout: `p123\nfcwd\nn${canonicalRoot} (deleted)\n`,
        }));
      },
    });
    owner.registerFixtureRoot(root);
    rmSync(root, { recursive: true });

    expect(() => owner.dispose()).toThrow(
      `Fixture-owned Station cleanup failed: cwd:${canonicalRoot}:pids=123`,
    );
  });

  it.each([
    ['empty output', ''],
    ['missing cwd name', 'p123\nfcwd\n'],
    ['name before cwd descriptor', 'p123\nn/tmp\n'],
    ['cwd descriptor before pid', 'fcwd\nn/tmp\n'],
    ['relative cwd name', 'p123\nfcwd\nnrelative\n'],
    ['new pid before prior name', 'p123\nfcwd\np456\nfcwd\nn/tmp\n'],
  ])('fails closed for malformed lsof %s', (_case, stdout) => {
    expect(
      observeFixtureCwds([tmpdir()], () => ({
        signal: null,
        status: 0,
        stdout,
      })),
    ).toEqual({ source: 'none', reason: 'lsof-malformed-output' });
  });

  it.each([
    [
      'unavailable tool',
      {
        error: Object.assign(new Error('missing'), { code: 'ENOENT' }),
        signal: null,
        status: null,
        stdout: '',
      },
      'lsof-ENOENT;partial=false',
    ],
    [
      'nonzero exit',
      { signal: null, status: 2, stdout: '' },
      'lsof-exit-2;partial=false',
    ],
    [
      'signal termination',
      { signal: 'SIGKILL' as const, status: null, stdout: 'p123\n' },
      'lsof-signal-SIGKILL;partial=true',
    ],
  ])('fails closed for %s', (_case, result, reason) => {
    expect(observeFixtureCwds([tmpdir()], () => result)).toEqual({
      source: 'none',
      reason,
    });
  });

  it('fails closed and distinguishes partial timeout output', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-fixture-owner-cwd-'));
    roots.add(root);
    const owner = new StationFixtureOwner({
      observeFixtureCwds: (fixtureRoots) =>
        observeFixtureCwds(fixtureRoots, () => ({
          error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
          signal: 'SIGTERM',
          status: null,
          stdout: 'p123\nfcwd\n',
        })),
    });
    owner.registerFixtureRoot(root);

    expect(() => owner.dispose()).toThrow(
      'Fixture-owned Station cleanup failed: cwd:source=none;reason=lsof-ETIMEDOUT;partial=true',
    );
  });

  it('reaps a published candidate after forced state deletion', async () => {
    const child = await spawnLongRunningFixtureChild();
    if (!child.pid) throw new Error('fixture child has no pid');
    const path = statePath();
    writeState(path, child.pid);
    const owner = new StationFixtureOwner();
    owner.registerStatePath(path);
    owner.capturePublishedBoot(path);
    rmSync(path);

    owner.dispose();
    await expectGone(child.pid);
  }, 12_000);

  it('preserves its immutable snapshot and refuses a replacement PID', async () => {
    const candidate = await spawnLongRunningFixtureChild();
    const unrelated = await spawnLongRunningFixtureChild();
    if (!candidate.pid || !unrelated.pid)
      throw new Error('fixture child has no pid');
    const path = statePath();
    writeState(path, candidate.pid);
    const owner = new StationFixtureOwner();
    owner.registerStatePath(path);
    owner.capturePublishedBoot(path);
    writeState(path, unrelated.pid);

    owner.dispose();
    await expectGone(candidate.pid);
    expect(inspectProcessFingerprint(unrelated.pid)).not.toBeNull();
  }, 12_000);

  it('leaves no owned process residue across repeated cleanup', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const child = await spawnLongRunningFixtureChild();
      if (!child.pid) throw new Error('fixture child has no pid');
      const path = statePath();
      writeState(path, child.pid);
      const owner = new StationFixtureOwner();
      owner.registerStatePath(path);
      owner.capturePublishedBoot(path);
      owner.dispose();
      await expectGone(child.pid);
    }
  }, 18_000);

  it('retains every successful boot snapshot for one state path', async () => {
    const initial = await spawnLongRunningFixtureChild();
    const recovered = await spawnLongRunningFixtureChild();
    if (!initial.pid || !recovered.pid)
      throw new Error('fixture child has no pid');
    const path = statePath();
    const owner = new StationFixtureOwner();
    owner.registerStatePath(path);
    writeState(path, initial.pid);
    owner.capturePublishedBoot(path);
    writeState(path, recovered.pid);
    owner.capturePublishedBoot(path);

    owner.dispose();
    await expectGone(initial.pid);
    await expectGone(recovered.pid);
  }, 18_000);

  it('throws bounded diagnostics when an owned process survives teardown', async () => {
    const child = await spawnLongRunningFixtureChild();
    if (!child.pid) throw new Error('fixture child has no pid');
    const path = statePath();
    writeState(path, child.pid);
    const owner = new StationFixtureOwner({ killTree: () => {} });
    owner.registerStatePath(path);
    owner.capturePublishedBoot(path);

    expect(() => owner.dispose()).toThrow(
      `Fixture-owned Station cleanup failed: server:${child.pid}:still-running`,
    );
  }, 8_000);
});
