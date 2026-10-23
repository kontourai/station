import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  reapAllLongRunningFixtureChildren,
  spawnLongRunningFixtureChild,
} from '../../../packages/cli/src/__tests__/helpers/longrunning-fixture-child.js';
import { inspectProcessFingerprint } from '../../../packages/cli/src/commands/platform.js';
import {
  attestRuntimeRecoveryLaunch,
  type RuntimeRecoveryRequest,
} from './runtime-recovery-linux-bootstrap.mjs';
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

// Metadata controls below exercise the real pre-CLI attestation and owner
// receipt boundary. Existing runtime-recovery journeys own native execution.
const fixtureBoot = '11111111-1111-4111-8111-111111111111';
const linuxBirth = (start: string) => `linux:${fixtureBoot}:${start}`;

function recoveryProcReader(
  workerPid: number,
  actorPid: number,
  candidatePid: number,
  change: Partial<Record<string, string>> = {},
): (path: string) => string {
  const counts = new Map<string, number>();
  return (path) => {
    const count = (counts.get(path) ?? 0) + 1;
    counts.set(path, count);
    if (path === '/proc/sys/kernel/random/boot_id')
      return change.bootChanged && count > Number(change.bootChanged)
        ? '22222222-2222-4222-8222-222222222222'
        : fixtureBoot;
    const match = /^\/proc\/(\d+)\/(stat|status)$/.exec(path);
    if (!match) throw new Error('private-proc-token');
    const pid = Number(match[1]);
    const kind =
      pid === workerPid
        ? 'worker'
        : pid === actorPid
          ? 'actor'
          : pid === candidatePid
            ? 'candidate'
            : 'child';
    const start = kind === 'worker' ? '2' : kind === 'actor' ? '3' : '4';
    if (match[2] === 'stat') {
      const fields = Array<string>(20).fill('0');
      fields[0] = 'S';
      fields[1] = '226';
      fields[6] = '4194624';
      fields[19] = change[`${kind}Start`] ?? start;
      if (kind === 'candidate' && change.reused && count > 2) fields[19] = '5';
      return `${change[`${kind}StatPid`] ?? pid} (private-proc-token) ${fields.join(' ')}`;
    }
    const uid = kind === 'candidate' ? '0 0 0 0' : '1000 1000 1000 1000';
    const uids =
      kind === 'candidate' && change.changedUid && count > 1
        ? '1 1 1 1'
        : (change[`${kind}Uid`] ?? uid);
    const nnp =
      change[`${kind}Nnp`] ??
      (kind === 'actor' || kind === 'child' ? '1' : '0');
    return (
      `Name:\tprivate-proc-token\nPid:\t${pid}\nTgid:\t${pid}\n${change[`${kind}MissingUid`] ? '' : `Uid:\t${uids}\n`}NoNewPrivs:\t${nnp}\n` +
      ['CapEff', 'CapPrm', 'CapInh', 'CapAmb']
        .map(
          (cap) =>
            `${cap}:\t${change[`${kind}${cap}`] ?? '0000000000000000'}\n`,
        )
        .join('')
    );
  };
}

describe('StationFixtureOwner', () => {
  it.each([
    ['closed actor', {}, true],
    ['NNP unset', { actorNnp: '0' }, false],
    ['root actor', { actorUid: '0 0 0 0' }, false],
    ['mixed actor IDs', { actorUid: '1000 0 1000 1000' }, false],
    ['effective capability', { actorCapEff: '0000000000000080' }, false],
    ['permitted capability', { actorCapPrm: '0000000000000080' }, false],
    ['inheritable capability', { actorCapInh: '0000000000000080' }, false],
    ['ambient capability', { actorCapAmb: '0000000000000080' }, false],
    ['worker changed UID', { workerUid: '1001 1001 1001 1001' }, false],
    ['worker changed birth', { workerStart: '3' }, false],
  ])('checks the actual pre-CLI actor: %s', (_name, change, accepted) => {
    const workerPid = process.pid;
    const actorPid = workerPid + 1000;
    const request: RuntimeRecoveryRequest = {
      version: 1,
      root: '/fixture',
      release: '/fixture/release',
      scopeNonce: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      runtimePath: '/fixture/release/dist-server-phone/command-station.js',
      runtimeDigest: 'fixture-digest',
      workerPid,
      workerBirth: linuxBirth('2'),
      uid: 1000,
    };
    const attest = () =>
      attestRuntimeRecoveryLaunch(
        request,
        actorPid,
        'start',
        recoveryProcReader(workerPid, actorPid, workerPid + 2000, change),
      );
    if (accepted) {
      const receipt = attest();
      expect(receipt).toMatchObject({
        root: '/fixture',
        release: '/fixture/release',
        scopeNonce: request.scopeNonce,
        workerPid,
        workerBirth: linuxBirth('2'),
        uid: 1000,
        command: 'start',
        actor: { pid: actorPid, birth: linuxBirth('3'), nnp: 1 },
      });
      expect(JSON.stringify(receipt)).not.toContain('private-proc-token');
    } else {
      expect(attest).toThrow(/fixture actor|launch identity/);
    }
  });

  it.skipIf(process.platform === 'win32').each([
    ['bound launch and boot', {}, true],
    ['no receipt', { noReceipt: '1' }, false],
    ['no captured boot', { noCapture: '1' }, false],
    ['wrong receipt root', { wrongRoot: '1' }, false],
    ['wrong receipt nonce', { wrongNonce: '1' }, false],
    ['actor changed after capture', { changedActor: '1' }, false],
    ['child NNP unset', { childNnp: '0' }, false],
    ['child has another UID', { childUid: '1001 1001 1001 1001' }, false],
    ['same UID candidate', { candidateUid: '1000 1000 1000 1000' }, false],
    ['candidate real UID matches', { candidateUid: '1000 0 0 0' }, false],
    ['candidate effective UID matches', { candidateUid: '0 1000 0 0' }, false],
    ['candidate saved UID matches', { candidateUid: '0 0 1000 0' }, false],
    ['candidate fs UID matches', { candidateUid: '0 0 0 1000' }, false],
    ['candidate IDs changed', { changedUid: '1' }, false],
    ['candidate IDs missing', { candidateMissingUid: '1' }, false],
    ['candidate birth unbound', { candidateStart: '5' }, false],
    ['candidate PID mismatched', { candidateStatPid: '99999999' }, false],
    ['candidate PID reused', { reused: '1' }, false],
    ['resolved fixture cwd still blocks', { resolvedResidue: '1' }, false],
    ['lsof warnings still block', { warning: '1' }, false],
    ['candidate boot changed', { bootChanged: '2' }, false],
  ])(
    'requires closed launch evidence before excluding another UID: %s',
    (_name, change: Partial<Record<string, string>>, accepted) => {
      const path = statePath();
      const root = realpathSync(dirname(path));
      const release = join(root, 'release');
      mkdirSync(release);
      const published = join(release, 'instance.json');
      const workerPid = process.pid;
      const actorPid = workerPid + 1000;
      const candidatePid = workerPid + 2000;
      const serverPid = workerPid + 3000;
      const uiPid = workerPid + 4000;
      let read = recoveryProcReader(workerPid, actorPid, candidatePid);
      const killed = new Set<number>();
      const fingerprint = (pid: number) => ({
        pid,
        startToken: linuxBirth('4'),
        commandDigest: `fixture-${pid}`,
      });
      const observed: { value?: ReturnType<typeof observeFixtureCwds> } = {};
      const owner = new StationFixtureOwner({
        inspectProcess: (pid) => (killed.has(pid) ? null : fingerprint(pid)),
        killTree: (pid) => {
          killed.add(pid);
        },
        processObservation: {
          platform: 'linux',
          birth: (pid) => linuxBirth(pid === workerPid ? '2' : '4'),
          readProcFile: (file) => read(file),
        },
        observeFixtureCwds: (fixtureRoots, _run, evidence) => {
          observed.value = observeFixtureCwds(
            fixtureRoots,
            () => ({
              signal: null,
              status: 0,
              stderr: change.warning ? 'incomplete mount observation' : '',
              stdout: `p${workerPid}\nfcwd\nn${change.resolvedResidue ? root : '/'}\np${candidatePid}\nfcwd\nn/proc/${candidatePid}/cwd (readlink: Permission denied)\n`,
            }),
            evidence,
          );
          return observed.value;
        },
      });
      owner.registerFixtureRoot(root);
      mkdirSync(join(release, 'dist-server-phone'));
      copyFileSync(
        new URL('../fixtures/dogfood-runtime-fixture.mjs', import.meta.url),
        join(release, 'dist-server-phone/command-station.js'),
      );
      const request = owner.writeRuntimeRecoveryStationShim(release, 'phone');
      if (!request) throw new Error('Missing runtime recovery launch request');
      const requestPath = join(
        release,
        `.station-fixture-${request.scopeNonce}.json`,
      );
      const receipt = attestRuntimeRecoveryLaunch(
        request,
        actorPid,
        'start',
        read,
      );
      const receiptPath = `${requestPath}l`;
      if (change.wrongRoot) receipt.root = root + '-other';
      if (change.wrongNonce)
        receipt.scopeNonce = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      if (!change.noReceipt)
        appendFileSync(receiptPath, JSON.stringify(receipt) + '\n');
      writeFileSync(
        published,
        JSON.stringify({
          bootId: 'fixture-boot',
          serverPid,
          serverFingerprint: fingerprint(serverPid),
          uiPid,
          uiFingerprint: fingerprint(uiPid),
        }),
      );
      read = recoveryProcReader(workerPid, actorPid, candidatePid, {
        childNnp: change.childNnp,
        childUid: change.childUid,
      });
      if (!change.noCapture) {
        if (
          change.noReceipt ||
          change.wrongRoot ||
          change.wrongNonce ||
          change.childNnp ||
          change.childUid
        )
          expect(() => owner.capturePublishedBoot(published)).toThrow(
            'lacks bound privilege closure evidence',
          );
        else owner.capturePublishedBoot(published);
      }
      if (change.changedActor) {
        receipt.actor.pid += 1;
        writeFileSync(receiptPath, JSON.stringify(receipt) + '\n');
      }
      // Start a fresh candidate observation after the publication controls.
      read = recoveryProcReader(workerPid, actorPid, candidatePid, change);
      if (accepted) {
        expect(() => owner.dispose()).not.toThrow();
        expect(observed.value?.source).toBe('lsof');
        if (observed.value?.source === 'lsof')
          expect(observed.value.owners.get(root)).toEqual(new Set());
      } else {
        if (change.resolvedResidue) {
          expect(() => owner.dispose()).toThrow(
            `cwd:${root}:pids=${workerPid}`,
          );
          expect(observed.value?.source).toBe('lsof');
        } else {
          expect(() => owner.dispose()).toThrow(
            change.warning ? 'lsof-warning' : 'lsof-malformed-output',
          );
          expect(observed.value?.source).toBe('none');
        }
      }
    },
  );

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
    ['witnessed kernel workqueue', {}, 'lsof'],
    ['missing workqueue flag', { flags: '2097152' }, 'none'],
    ['missing kernel-thread flag', { flags: '32' }, 'none'],
    ['io worker', { flags: '69238896' }, 'none'],
    ['user worker', { flags: '69255264' }, 'none'],
    ['reused candidate', { afterStart: '4' }, 'none'],
    ['unbound original birth', { beforeStart: '4', afterStart: '4' }, 'none'],
    ['changed flags', { afterFlags: '2097152' }, 'none'],
    ['different parent', { parent: '4' }, 'none'],
    ['namespace user PID 2', { rootFlags: '0' }, 'none'],
    ['reused parent identity', { rootAfterStart: '4' }, 'none'],
    ['changed parent flags', { rootAfterFlags: '0' }, 'none'],
    ['newer parent identity', { rootStart: '3' }, 'none'],
    ['different boot', { boot: 'other' }, 'none'],
    ['changed boot', { afterBoot: 'other' }, 'none'],
    ['unavailable metadata', { unavailable: true }, 'none'],
  ])('bounds an unreadable cwd by %s', (_name, change, expected) => {
    const sample = {
      flags: '69238880',
      afterFlags: '69238880',
      beforeStart: '3',
      afterStart: '3',
      parent: '2',
      rootFlags: '2097152',
      rootAfterFlags: '2097152',
      rootStart: '1',
      rootAfterStart: '1',
      boot: 'boot',
      afterBoot: 'boot',
      unavailable: false,
      ...change,
    };
    let reads = 0;
    let rootReads = 0;
    let bootReads = 0;
    const stat = (
      pid: number,
      parent: string,
      flags: string,
      start: string,
    ) => {
      const fields = Array<string>(20).fill('0');
      fields[0] = 'I';
      fields[1] = parent;
      fields[6] = flags;
      fields[19] = start;
      return `${pid} (private-fixture-token) ${fields.join(' ')}`;
    };
    const observed = observeFixtureCwds(
      [tmpdir()],
      () => ({
        signal: null,
        status: 0,
        stdout: `p${process.pid}\nfcwd\nn${realpathSync(tmpdir())}\np123\nfcwd\nn/proc/123/cwd (readlink: Permission denied)\n`,
      }),
      {
        platform: 'linux',
        birth: (pid) => `linux:boot:${pid === process.pid ? '2' : '3'}`,
        readProcFile: (path) => {
          if (sample.unavailable) throw new Error('private-fixture-token');
          if (path === '/proc/123/stat')
            return ++reads === 1
              ? stat(123, sample.parent, sample.flags, sample.beforeStart)
              : stat(123, sample.parent, sample.afterFlags, sample.afterStart);
          if (path === '/proc/2/stat')
            return ++rootReads === 1
              ? stat(2, '0', sample.rootFlags, sample.rootStart)
              : stat(2, '0', sample.rootAfterFlags, sample.rootAfterStart);
          if (path === '/proc/sys/kernel/random/boot_id')
            return ++bootReads === 1 ? sample.boot : sample.afterBoot;
          throw new Error('private-fixture-token');
        },
      },
    );
    expect(observed.source).toBe(expected);
    expect(JSON.stringify(observed)).not.toContain('private-fixture-token');
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
