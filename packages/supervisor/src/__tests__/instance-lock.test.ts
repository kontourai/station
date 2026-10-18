/**
 * One supervisor per (home, instance), whatever control socket it is given.
 * Lock epochs are files created with `wx`. A holder is alive while its pid
 * exists with the start-time fingerprint it recorded; reaching it is never
 * part of the decision. Every test fails on an explicit deadline or state.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { processFingerprint } from '../generation-registry.ts';
import {
  makeShortHome,
  type RunningSupervisor,
  startSupervisor,
} from './harness.ts';

const makeTempDir = trackTempDirs();
const posixOnly = process.platform === 'win32' ? it.skip : it;
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function runDir(home: string): string {
  return join(home, 'run');
}

function epochs(home: string): string[] {
  if (!existsSync(runDir(home))) return [];
  return readdirSync(runDir(home))
    .filter((name) => name.startsWith('instance-test.lock.'))
    .map((name) => name.slice('instance-test.lock.'.length))
    .sort((a, b) => Number(a) - Number(b));
}

function epochContent(home: string, epoch: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(runDir(home), `instance-test.lock.${epoch}`), 'utf8'),
  );
}

function writeEpoch(
  home: string,
  epoch: string,
  content: Record<string, unknown>,
): void {
  mkdirSync(runDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(runDir(home), `instance-test.lock.${epoch}`),
    JSON.stringify(content),
  );
}

/** A pid that certainly belonged to a process that has exited. */
function deadPid(): number {
  const result = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(process.pid))'],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return Number(result.stdout);
}

async function liveSleeper(): Promise<number> {
  const child: ChildProcess = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  cleanups.push(() => child.kill('SIGKILL'));
  await once(child, 'spawn');
  return child.pid as number;
}

async function fingerprintOf(pid: number): Promise<string> {
  const fingerprint = await processFingerprint(pid);
  if (fingerprint.status !== 'ok') throw new Error(`cannot fingerprint ${pid}`);
  return fingerprint.value;
}

/** Resolves the first of the supervisor's exit or `ms` elapsing, as a state to assert on. */
function exitWithin(
  supervisor: RunningSupervisor,
  ms: number,
): Promise<
  { code: number | null; signal: NodeJS.Signals | null } | 'STILL_RUNNING'
> {
  return Promise.race([
    supervisor.exited,
    // real-time: an explicit deadline for an expected exit, asserted as state.
    new Promise<'STILL_RUNNING'>((resolve) =>
      setTimeout(() => resolve('STILL_RUNNING'), ms),
    ),
  ]);
}

const REFUSAL = /another supervisor \(pid \d+\) holds instance test/;

describe('instance lock (real processes)', () => {
  it('refuses a second supervisor for the same instance even with its own --control socket', async () => {
    const home = makeTempDir('sup-lock-');
    const first = await startSupervisor({ home });
    const before = await first.status();
    const second = await startSupervisor({
      home,
      args: ['--control', join(makeShortHome(), 'b.sock')],
      waitForServing: false,
    });
    expect(await exitWithin(second, 20_000), second.output()).toEqual({
      code: 1,
      signal: null,
    });
    expect(second.output()).toContain(
      `another supervisor (pid ${first.child.pid}) holds instance test`,
    );
    const after = await first.status();
    expect(after.active?.pid).toBe(before.active?.pid);
    expect(after.restarts.consecutiveFailures).toBe(0);
  }, 60_000);

  it('refuses when the live holder runs in a different time zone and locale', async () => {
    const home = makeTempDir('sup-lock-tz-');
    const first = await startSupervisor({
      home,
      env: { TZ: 'UTC', LANG: 'C', LC_ALL: 'C' },
    });
    const second = await startSupervisor({
      home,
      env: { TZ: 'Asia/Tokyo', LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8' },
      waitForServing: false,
    });
    expect(await exitWithin(second, 20_000), second.output()).toEqual({
      code: 1,
      signal: null,
    });
    expect(second.output()).toContain(
      `another supervisor (pid ${first.child.pid}) holds instance test`,
    );
    expect((await first.status()).state).toBe('serving');
  }, 60_000);

  posixOnly(
    'refuses while the holder is stopped and its control backlog is flooded',
    async () => {
      const home = makeTempDir('sup-lock-sigstop-');
      const first = await startSupervisor({ home });
      const before = await first.status();
      const holder = first.child.pid as number;
      process.kill(holder, 'SIGSTOP');
      cleanups.push(() => {
        try {
          process.kill(holder, 'SIGCONT');
        } catch {
          // Gone.
        }
      });
      // Fill the stopped holder's accept backlog, in batches, until a connect
      // is not queued. The queue length differs by platform (macOS 128 here,
      // Linux up to the listen backlog of 511).
      const flood: Socket[] = [];
      cleanups.push(() => {
        for (const socket of flood) socket.destroy();
      });
      const connectOnce = () =>
        new Promise<string>((resolve) => {
          const socket = createConnection(first.endpoint.path);
          flood.push(socket);
          socket.once('connect', () => resolve('queued'));
          socket.once('error', (error: NodeJS.ErrnoException) =>
            resolve(error.code ?? 'error'),
          );
          socket.setTimeout(3_000, () => resolve('pending'));
        });
      const outcomes: string[] = [];
      while (
        outcomes.length < 1_500 &&
        outcomes.every((outcome): boolean => outcome === 'queued')
      ) {
        outcomes.push(
          ...(await Promise.all(Array.from({ length: 100 }, connectOnce))),
        );
      }
      // The backlog is saturated: some connects were not queued. macOS refuses
      // them (ECONNREFUSED); Linux fails them or leaves them pending.
      const counts = outcomes.reduce<Record<string, number>>((all, outcome) => {
        all[outcome] = (all[outcome] ?? 0) + 1;
        return all;
      }, {});
      expect(
        outcomes.some((outcome) => outcome !== 'queued'),
        JSON.stringify(counts),
      ).toBe(true);

      const second = await startSupervisor({
        home,
        waitForServing: false,
        // The old reachability rule only fooled itself on a lock past its grace.
        args: ['--lock-pending-grace-ms', '1'],
      });
      expect(await exitWithin(second, 20_000), second.output()).toEqual({
        code: 1,
        signal: null,
      });
      expect(second.output()).toContain(
        `another supervisor (pid ${holder}) holds instance test`,
      );
      expect(second.output()).not.toMatch(/acquired instance lock|reaped/);

      for (const socket of flood) socket.destroy();
      process.kill(holder, 'SIGCONT');
      // Only the original holder answers on the path, with its original core.
      // The continued holder drains its backlog first; poll within a deadline.
      let after = await first.status().catch(() => null);
      await vi.waitFor(
        async () => {
          after = await first.status();
        },
        { timeout: 10_000, interval: 100 },
      );
      if (!after) throw new Error('no status from the continued holder');
      expect(after.supervisor.pid).toBe(holder);
      expect(after.active?.pid).toBe(before.active?.pid);
      expect(epochs(home)).toEqual(['1']);
    },
    90_000,
  );

  posixOnly(
    're-binds its socket after an external deletion, and a starter still refuses',
    async () => {
      const home = makeTempDir('sup-lock-unlinked-');
      const first = await startSupervisor({ home });
      rmSync(first.endpoint.path);
      const second = await startSupervisor({
        home,
        waitForServing: false,
        // The old reachability rule only fooled itself on a lock past its grace.
        args: ['--lock-pending-grace-ms', '1'],
      });
      expect(await exitWithin(second, 20_000), second.output()).toEqual({
        code: 1,
        signal: null,
      });
      expect(second.output()).toContain(
        `another supervisor (pid ${first.child.pid}) holds instance test`,
      );
      // Within one self-check interval (5 s) the holder is reachable on its path again.
      await vi.waitFor(
        () => expect(existsSync(first.endpoint.path)).toBe(true),
        {
          timeout: 8_000,
          interval: 100,
        },
      );
      expect((await first.status()).supervisor.pid).toBe(first.child.pid);
      expect(first.output()).toContain(
        'control socket path is missing or replaced; re-binding',
      );
    },
    60_000,
  );

  posixOnly(
    'lets one of two instances own a shared --control path, with no ping-pong',
    async () => {
      const shared = join(makeShortHome(), 'shared.sock');
      const first = await startSupervisor({
        home: makeTempDir('sup-lock-shared-a-'),
        control: shared,
      });
      // The path is deleted, and a second instance (another home) binds it.
      rmSync(shared);
      const second = await startSupervisor({
        home: makeTempDir('sup-lock-shared-b-'),
        control: shared,
      });
      // The first finds a live listener on its path: it refuses to steal it and exits.
      expect(await exitWithin(first, 8_000), first.output()).toEqual({
        code: 1,
        signal: null,
      });
      expect(first.output()).toContain(
        `a process is already listening at ${shared}`,
      );
      // The second keeps the path through more than one self-check interval.
      await new Promise((resolve) => setTimeout(resolve, 6_000)); // real-time: outlast one self-check interval.
      expect(existsSync(shared)).toBe(true);
      expect((await second.status()).supervisor.pid).toBe(second.child.pid);
      expect(second.output()).not.toContain('re-binding');
    },
    60_000,
  );

  it('names the lock file, the holder, and the remedy when it refuses', async () => {
    const home = makeTempDir('sup-lock-message-');
    const first = await startSupervisor({ home });
    const second = await startSupervisor({ home, waitForServing: false });
    expect(await exitWithin(second, 20_000), second.output()).toEqual({
      code: 1,
      signal: null,
    });
    const lockFile = join(runDir(home), 'instance-test.lock.1');
    expect(second.output()).toContain(`lock file: ${lockFile}`);
    expect(second.output()).toContain(
      `pid ${first.child.pid} is running as this instance's supervisor`,
    );
    expect(second.output()).toContain(
      `stop it with SIGTERM to pid ${first.child.pid} or the control channel's stop request, then start again`,
    );
  }, 60_000);

  posixOnly(
    'sweeps only stale leftovers of its own naming pattern from the control directory',
    async () => {
      const dir = makeShortHome();
      const control = join(dir, 'c.sock');
      // A socket file left by a killed process, under each private naming pattern.
      const leftover = async (name: string) => {
        const path = join(dir, name);
        const child = spawn(
          process.execPath,
          [
            '-e',
            `require('net').createServer().listen(${JSON.stringify(path)}, () => process.stdout.write('up'))`,
          ],
          { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
        );
        await once(child.stdout as NodeJS.ReadableStream, 'data');
        child.kill('SIGKILL');
        await once(child, 'exit');
        return path;
      };
      const old = new Date(Date.now() - 120_000);
      const staleBind = await leftover('.sa1b2c3');
      const staleAside = await leftover('.d0f9e8d');
      const freshBind = await leftover('.s123456');
      const wrongName = await leftover('.sZZZZZZ');
      for (const path of [staleBind, staleAside, wrongName])
        utimesSync(path, old, old);
      const regular = join(dir, '.dabcdef');
      writeFileSync(regular, 'not a socket');
      utimesSync(regular, old, old);

      const supervisor = await startSupervisor({
        home: makeTempDir('sup-lock-sweep-'),
        control,
      });
      expect((await supervisor.status()).state).toBe('serving');
      expect(existsSync(staleBind)).toBe(false);
      expect(existsSync(staleAside)).toBe(false);
      // Too fresh to be a leftover, the wrong pattern, or not a socket: kept.
      expect(existsSync(freshBind)).toBe(true);
      expect(existsSync(wrongName)).toBe(true);
      expect(existsSync(regular)).toBe(true);
      expect(supervisor.output()).toContain(`removed leftover ${staleBind}`);
    },
    60_000,
  );

  it('drains and exits 1 when its epoch is superseded while serving', async () => {
    const home = makeTempDir('sup-lock-superseded-live-');
    const first = await startSupervisor({ home });
    const core = (await first.status()).active?.pid as number;
    writeEpoch(home, '2', {
      pid: process.pid,
      nonce: randomBytes(16).toString('hex'),
      startFingerprint: await fingerprintOf(process.pid),
      createdAt: Date.now(),
      control: 'elsewhere',
    });
    expect(await exitWithin(first, 8_000), first.output()).toEqual({
      code: 1,
      signal: null,
    });
    expect(first.output()).toContain('instance lock epoch 1 was superseded');
    expect(first.output()).toContain('generation 1 exited code=0');
    expect(() => process.kill(core, 0)).toThrow();
  }, 60_000);

  it('lets exactly one of three or four concurrent starters take over a dead holder, every time', async () => {
    const home = makeTempDir('sup-lock-race-');
    writeEpoch(home, '1', {
      pid: deadPid(),
      nonce: randomBytes(16).toString('hex'),
      startFingerprint: 'dead',
      createdAt: Date.now() - 120_000,
      control: 'gone',
    });
    for (let iteration = 0; iteration < 50; iteration += 1) {
      const starters = await Promise.all(
        Array.from({ length: iteration % 2 === 0 ? 3 : 4 }, () =>
          startSupervisor({
            home,
            waitForServing: false,
            env: { STATION_SUPERVISOR_TEST_LOCK_DELAY_MS: '150' },
          }),
        ),
      );
      await vi.waitFor(
        () => {
          const settled = starters.filter(
            (s) =>
              /acquired instance lock epoch \d+/.test(s.output()) ||
              (s.child.exitCode === 1 && REFUSAL.test(s.output())),
          );
          expect(
            settled.length,
            starters.map((s) => s.output()).join('\n---\n'),
          ).toBe(starters.length);
        },
        { timeout: 30_000, interval: 50 },
      );
      const winners = starters.filter((s) =>
        /acquired instance lock epoch \d+/.test(s.output()),
      );
      expect(winners, `iteration ${iteration}`).toHaveLength(1);
      const winner = winners[0] as RunningSupervisor;
      winner.child.kill('SIGKILL');
      await winner.exited;
    }
  }, 600_000);

  it('does not take over a half-written lock while it is young', async () => {
    const home = makeTempDir('sup-lock-pending-');
    mkdirSync(runDir(home), { mode: 0o700 });
    writeFileSync(join(runDir(home), 'instance-test.lock.1'), '');
    const starter = await startSupervisor({ home, waitForServing: false });
    expect(await exitWithin(starter, 20_000), starter.output()).toEqual({
      code: 1,
      signal: null,
    });
    expect(starter.output()).toContain('live-pending');
    expect(epochs(home)).toEqual(['1']);
  }, 60_000);

  it('ignores a stray epoch name with a leading zero', async () => {
    const home = makeTempDir('sup-lock-zero-');
    const pid = await liveSleeper();
    writeEpoch(home, '06', {
      pid,
      nonce: randomBytes(16).toString('hex'),
      startFingerprint: await fingerprintOf(pid),
      createdAt: Date.now(),
      control: 'x',
    });
    const starter = await startSupervisor({ home });
    expect(starter.output()).toContain('acquired instance lock epoch 1');
    expect(epochs(home)).toEqual(
      ['1', '06'].sort((a, b) => Number(a) - Number(b)),
    );
  }, 60_000);

  it('takes over from a reused pid whose fingerprint differs', async () => {
    const home = makeTempDir('sup-lock-reused-');
    const pid = await liveSleeper();
    writeEpoch(home, '1', {
      pid,
      nonce: randomBytes(16).toString('hex'),
      startFingerprint: 'a-different-process',
      createdAt: Date.now(),
      control: 'x',
    });
    const starter = await startSupervisor({ home });
    expect(starter.output()).toContain('acquired instance lock epoch 2');
    expect(() => process.kill(pid, 0)).not.toThrow();
  }, 60_000);

  it.skipIf(process.platform !== 'darwin')(
    'refuses when it cannot fingerprint a holder whose pid exists',
    async () => {
      const home = makeTempDir('sup-lock-unknown-');
      const pid = await liveSleeper();
      writeEpoch(home, '1', {
        pid,
        nonce: randomBytes(16).toString('hex'),
        startFingerprint: await fingerprintOf(pid),
        createdAt: Date.now() - 120_000,
        control: join(makeShortHome(), 'unreachable.sock'),
      });
      // No `ps` on PATH: the fingerprint is unknown, so the holder counts as live.
      const starter = await startSupervisor({
        home,
        env: { PATH: '/nonexistent' },
        waitForServing: false,
      });
      expect(await exitWithin(starter, 20_000), starter.output()).toEqual({
        code: 1,
        signal: null,
      });
      expect(starter.output()).toContain(
        `another supervisor (pid ${pid}) holds instance test`,
      );
      expect(epochs(home)).toEqual(['1']);
    },
    60_000,
  );

  it('marks its epoch released on a clean stop, and the next starter takes over', async () => {
    const home = makeTempDir('sup-lock-release-');
    const first = await startSupervisor({ home });
    const connection = await first.connect();
    await connection.request({ type: 'stop', id: 'r1' }, ['stop.result']);
    expect(await exitWithin(first, 20_000)).toEqual({ code: 0, signal: null });
    expect(epochs(home)).toEqual(['1']);
    expect(epochContent(home, '1').releasedAt).toBeTypeOf('number');
    const second = await startSupervisor({ home });
    expect(second.output()).toContain('acquired instance lock epoch 2');
    expect(epochs(home)).toEqual(['2']);
  }, 60_000);

  it('never releases an epoch whose nonce is no longer its own', async () => {
    const home = makeTempDir('sup-lock-foreign-');
    const first = await startSupervisor({ home });
    const mine = epochContent(home, '1');
    writeEpoch(home, '1', { ...mine, nonce: randomBytes(16).toString('hex') });
    first.child.kill('SIGTERM');
    await exitWithin(first, 20_000);
    expect(epochContent(home, '1').releasedAt).toBeUndefined();
  }, 60_000);

  posixOnly(
    'refuses to replace a control socket another process is listening on',
    async () => {
      const home = makeTempDir('sup-lock-impostor-');
      // The previous holder released cleanly, but something else listens on the path.
      const endpointHome = makeShortHome();
      const path = join(endpointHome, 'shared.sock');
      const impostor: Server = createServer((socket) => {
        socket.on('error', () => {});
      });
      await new Promise<void>((resolve) => impostor.listen(path, resolve));
      cleanups.push(() => impostor.close());
      writeEpoch(home, '1', {
        pid: deadPid(),
        nonce: randomBytes(16).toString('hex'),
        startFingerprint: 'dead',
        createdAt: Date.now() - 120_000,
        control: path,
        releasedAt: Date.now() - 60_000,
      });
      const starter = await startSupervisor({
        home,
        args: ['--control', path],
        waitForServing: false,
      });
      expect(await exitWithin(starter, 20_000), starter.output()).toEqual({
        code: 1,
        signal: null,
      });
      expect(starter.output()).toContain(
        `a process is already listening at ${path}`,
      );
      // The impostor's socket is still in place and still accepts.
      await new Promise<void>((resolve, reject) => {
        const probe = createConnection(path);
        probe.once('connect', () => {
          probe.destroy();
          resolve();
        });
        probe.once('error', reject);
      });
    },
    60_000,
  );

  it('steps down when a later epoch appears before start-up finishes', async () => {
    const home = makeTempDir('sup-lock-superseded-');
    const starter = await startSupervisor({
      home,
      waitForServing: false,
      env: { STATION_SUPERVISOR_TEST_POST_ACQUIRE_DELAY_MS: '1500' },
    });
    await vi.waitFor(() => expect(epochs(home)).toEqual(['1']), {
      timeout: 10_000,
      interval: 20,
    });
    writeEpoch(home, '2', {
      pid: process.pid,
      nonce: randomBytes(16).toString('hex'),
      startFingerprint: await fingerprintOf(process.pid),
      createdAt: Date.now(),
      control: 'x',
    });
    // It must step down at its post-bind check, well inside one 5 s self-check
    // interval: never serve, never start a core, in the meantime.
    expect(await exitWithin(starter, 4_000), starter.output()).toEqual({
      code: 1,
      signal: null,
    });
    expect(starter.output()).toContain('instance lock epoch 1 was superseded');
    expect(starter.output()).not.toMatch(
      /acquired instance lock|generation \d+ started/,
    );
  }, 60_000);
});
