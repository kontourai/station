import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  reapAllLongRunningFixtureChildren,
  spawnLongRunningFixtureChild,
} from '../../../packages/cli/src/__tests__/helpers/longrunning-fixture-child.js';
import { inspectProcessFingerprint } from '../../../packages/cli/src/commands/platform.js';
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
        ['-n', '-P', '-S', '2', '-a', '-d', 'cwd', '-Ffn'],
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
    ['stable older process', 'linux:boot:1', 'linux:boot:1', 'lsof'],
    ['same tick as worker', 'linux:boot:2', 'linux:boot:2', 'none'],
    ['newer descendant', 'linux:boot:3', 'linux:boot:3', 'none'],
    ['PID reused during observation', 'linux:boot:1', 'linux:boot:3', 'none'],
    ['different boot', 'linux:other:1', 'linux:other:1', 'none'],
    ['unavailable birth', null, null, 'none'],
    ['malformed birth', 'linux:boot:invalid', 'linux:boot:invalid', 'none'],
  ])('bounds an unreadable cwd by %s', (_case, before, after, expected) => {
    let reads = 0;
    const observed = observeFixtureCwds(
      [tmpdir()],
      () => ({
        signal: null,
        status: 0,
        stdout: `p${process.pid}\nfcwd\nn${realpathSync(tmpdir())}\np1\nfcwd\nn/proc/1/cwd (readlink: Permission denied)\n`,
      }),
      {
        platform: 'linux',
        birth: (pid) => {
          if (pid === process.pid) return 'linux:boot:2';
          return ++reads === 1 ? before : after;
        },
      },
    );
    expect(observed.source).toBe(expected);
    if (observed.source === 'lsof')
      expect(observed.owners.get(realpathSync(tmpdir()))).toEqual(
        new Set([process.pid]),
      );
  });

  it('keeps direct cwd observations strict without fixture birth scope', () => {
    const observed = observeFixtureCwds([tmpdir()], () => ({
      signal: null,
      status: 0,
      stdout: `p${process.pid}\nfcwd\nn${realpathSync(tmpdir())}\np${process.ppid}\nfcwd\nn/proc/${process.ppid}/cwd (readlink: Permission denied)\n`,
    }));
    expect(observed).toEqual({
      source: 'none',
      reason: 'lsof-malformed-output',
    });
  });

  it.each([
    [null, '/proc/1/cwd (readlink: Permission denied)'],
    ['linux:boot:2', '/proc/1/cwd (readlink: No such file or directory)'],
    ['linux:boot:2', 'relative (readlink: Permission denied)'],
    ['linux:boot:2', '/proc/9/cwd (readlink: Permission denied)'],
  ])(
    'refuses incomplete worker identity or other readlink errors',
    (workerBirth, name) => {
      const observed = observeFixtureCwds(
        [tmpdir()],
        () => ({
          signal: null,
          status: 0,
          stdout: `p${process.pid}\nfcwd\nn${realpathSync(tmpdir())}\np1\nfcwd\nn${name}\n`,
        }),
        {
          platform: 'linux',
          birth: (pid) => (pid === process.pid ? workerBirth : 'linux:boot:1'),
        },
      );
      expect(observed).toMatchObject({
        source: 'none',
        reason: 'lsof-malformed-output',
      });
    },
  );

  it('retains a bounded path-free diagnosis for rejected cwd records', () => {
    const observed = observeFixtureCwds(
      [tmpdir()],
      () => ({
        signal: null,
        status: 0,
        stdout: 'p1\nfcwd\nnprivate-fixture-token\n',
      }),
      { platform: 'linux', birth: () => 'linux:boot:2' },
    );
    expect(observed).toMatchObject({
      source: 'none',
      reason: 'lsof-malformed-output',
      diagnostic: 'class=non-absolute;pid=1',
    });
    expect(JSON.stringify(observed)).not.toContain('private-fixture-token');
    const owner = new StationFixtureOwner({
      observeFixtureCwds: () => observed,
    });
    owner.registerFixtureRoot(tmpdir());
    expect(() => owner.dispose()).toThrow(
      'Fixture-owned Station cleanup failed: cwd:source=none;reason=lsof-malformed-output;class=non-absolute;pid=1',
    );
  });

  it.each([
    [false, 'S'],
    [true, 'S'],
    [false, 't'],
  ])(
    'diagnoses a denied Linux cwd without accepting it (reused=%s,state=%s)',
    (reused, state) => {
      let statReads = 0;
      const stat = (start: string) => {
        const fields = Array<string>(20).fill('0');
        fields[0] = state;
        fields[1] = '2';
        fields[6] = '2097152';
        fields[19] = start;
        return `1 (private-fixture-token) ${fields.join(' ')}`;
      };
      const observed = observeFixtureCwds(
        [tmpdir()],
        () => ({
          signal: null,
          status: 0,
          stdout: 'p1\nfcwd\nn/proc/1/cwd (readlink: Permission denied)\n',
        }),
        {
          platform: 'linux',
          birth: (pid) => `linux:boot:${pid === process.pid ? '2' : '3'}`,
          readProcFile: (path) => {
            if (path === '/proc/1/stat')
              return stat(++statReads === 2 && reused ? '4' : '3');
            if (path === '/proc/1/status')
              return 'Name:\tprivate-fixture-token\nTgid:\t1\nUid:\t1000\t1000\t1000\t1000\n';
            if (path === '/proc/sys/kernel/random/boot_id') return 'boot';
            if (path === '/proc/sys/kernel/osrelease') return '6.8.0-test';
            throw new Error('private-fixture-token');
          },
        },
      );
      expect(observed).toMatchObject({
        source: 'none',
        reason: 'lsof-malformed-output',
        diagnostic: `class=birth-not-earlier;pid=1;proc-state=${state};proc-ppid=2;proc-tgid=1;proc-flags=2097152;proc-uid=1000:1000:1000:1000;proc-birth=newer;proc-origin=unbound;proc-birth-samples-stable=${!reused};kernel=6.8.0-test`,
      });
      expect(JSON.stringify(observed)).not.toContain('private-fixture-token');
    },
  );

  it.each([
    ['empty output', ''],
    ['missing cwd name', 'p123\nfcwd\n'],
    ['name before cwd descriptor', 'p123\nn/tmp\n'],
    ['cwd descriptor before pid', 'fcwd\nn/tmp\n'],
    ['relative cwd name', 'p123\nfcwd\nnrelative\n'],
    [
      'unresolved cwd name',
      'p123\nfcwd\nn/proc/1/cwd (readlink: Permission denied)\n',
    ],
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
