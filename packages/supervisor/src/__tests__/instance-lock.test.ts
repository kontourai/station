/**
 * One supervisor per (home, instance), whatever control socket it is given.
 * Lock epochs are files created with `wx`; a holder is alive if it proves the
 * lock's nonce over its control endpoint, or is a young lock whose pid exists.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import {
  makeShortHome,
  type RunningSupervisor,
  startSupervisor,
} from './harness.ts';

const makeTempDir = trackTempDirs();
const sleepers: ChildProcess[] = [];
const servers: Server[] = [];
const accepted: Socket[] = [];

afterEach(async () => {
  for (const child of sleepers.splice(0)) child.kill('SIGKILL');
  for (const socket of accepted.splice(0)) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

function runDir(home: string): string {
  return join(home, 'run');
}

function epochs(home: string): number[] {
  if (!existsSync(runDir(home))) return [];
  return readdirSync(runDir(home))
    .map((name) => /^instance-test\.lock\.(\d+)$/.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

function epochContent(
  home: string,
  epoch: number,
): { pid: number; nonce: string } {
  return JSON.parse(
    readFileSync(join(runDir(home), `instance-test.lock.${epoch}`), 'utf8'),
  );
}

function writeEpoch(
  home: string,
  epoch: number,
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
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  sleepers.push(child);
  await once(child, 'spawn');
  return child.pid as number;
}

function nonce(): string {
  return randomBytes(16).toString('hex');
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
    expect((await second.exited).code, second.output()).toBe(1);
    expect(second.output()).toContain(
      `another supervisor (pid ${first.child.pid}) holds instance test`,
    );
    expect(second.output()).not.toMatch(/generation \d+ started|reaped/);
    const after = await first.status();
    expect(after.state).toBe('serving');
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
    expect((await second.exited).code, second.output()).toBe(1);
    expect(second.output()).toContain(
      `another supervisor (pid ${first.child.pid}) holds instance test`,
    );
    expect(second.output()).not.toContain('took over');
    expect((await first.status()).state).toBe('serving');
  }, 60_000);

  it('lets exactly one of three or four concurrent starters take over a dead holder, every time', async () => {
    const home = makeTempDir('sup-lock-race-');
    writeEpoch(home, 1, {
      pid: deadPid(),
      nonce: nonce(),
      createdAt: Date.now() - 120_000,
      control: join(home, 'none.sock'),
    });
    let previous: RunningSupervisor | null = null;
    for (let iteration = 0; iteration < 50; iteration += 1) {
      const starters = await Promise.all(
        Array.from({ length: iteration % 2 === 0 ? 3 : 4 }, () =>
          startSupervisor({
            home,
            waitForServing: false,
            // Widen the window between judging the holder and creating the next epoch.
            env: { STATION_SUPERVISOR_TEST_LOCK_DELAY_MS: '150' },
          }),
        ),
      );
      // The previous winner was SIGKILLed: it is the dead holder for this round.
      await vi.waitFor(
        () => {
          const acquired = starters.filter((s) =>
            /acquired instance lock epoch \d+/.test(s.output()),
          );
          const refused = starters.filter(
            (s) => s.child.exitCode === 1 && REFUSAL.test(s.output()),
          );
          expect(
            acquired.length + refused.length,
            starters.map((s) => s.output()).join('\n---\n'),
          ).toBe(starters.length);
        },
        { timeout: 30_000, interval: 50 },
      );
      const winners = starters.filter((s) =>
        /acquired instance lock epoch \d+/.test(s.output()),
      );
      expect(winners, `iteration ${iteration}`).toHaveLength(1);
      for (const loser of starters.filter((s) => s !== winners[0])) {
        expect(loser.output(), `iteration ${iteration}`).not.toMatch(
          /acquired instance lock|generation \d+ started/,
        );
      }
      previous = winners[0] as RunningSupervisor;
      previous.child.kill('SIGKILL');
      await previous.exited;
    }
  }, 600_000);

  it('steps down when a later epoch appears before start-up finishes', async () => {
    const home = makeTempDir('sup-lock-superseded-');
    const starter = await startSupervisor({
      home,
      waitForServing: false,
      env: { STATION_SUPERVISOR_TEST_POST_ACQUIRE_DELAY_MS: '1500' },
    });
    // It wins epoch 1; while it is held before its re-check, epoch 2 appears.
    await vi.waitFor(() => expect(epochs(home)).toEqual([1]), {
      timeout: 10_000,
      interval: 20,
    });
    writeEpoch(home, 2, {
      pid: await liveSleeper(),
      nonce: nonce(),
      createdAt: Date.now(),
      control: 'x',
    });
    expect((await starter.exited).code, starter.output()).toBe(1);
    expect(starter.output()).toContain(
      'instance lock epoch 1 was superseded before start-up finished',
    );
    expect(starter.output()).not.toMatch(
      /acquired instance lock|generation \d+ started/,
    );
    // It removed its own epoch on the way out and left the later one alone.
    expect(epochs(home)).toEqual([2]);
  }, 60_000);

  it('does not take over a live-pending holder whose socket is not bound yet', async () => {
    const home = makeTempDir('sup-lock-pending-');
    const pid = await liveSleeper();
    writeEpoch(home, 1, {
      pid,
      nonce: nonce(),
      createdAt: Date.now(),
      control: join(makeShortHome(), 'not-yet.sock'),
    });
    const starter = await startSupervisor({ home, waitForServing: false });
    expect((await starter.exited).code, starter.output()).toBe(1);
    expect(starter.output()).toContain(
      `another supervisor (pid ${pid}) holds instance test`,
    );
    expect(starter.output()).toContain('live-pending');
    expect(epochs(home)).toEqual([1]);
  }, 60_000);

  it('refuses an old lock whose endpoint accepts but never answers', async () => {
    const home = makeTempDir('sup-lock-mute-');
    const pid = await liveSleeper();
    // A named pipe on Windows, where a filesystem path cannot be listened on.
    const mute =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\station-supervisor-test-mute-${nonce()}`
        : join(makeShortHome(), 'mute.sock');
    const server = createServer((socket) => {
      accepted.push(socket);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(mute, resolve));
    writeEpoch(home, 1, {
      pid,
      nonce: nonce(),
      createdAt: Date.now() - 120_000,
      control: mute,
    });
    const starter = await startSupervisor({ home, waitForServing: false });
    expect((await starter.exited).code, starter.output()).toBe(1);
    expect(starter.output()).toContain(
      `another supervisor (pid ${pid}) holds instance test`,
    );
    expect(epochs(home)).toEqual([1]);
  }, 60_000);

  it('takes over a dead holder and collects older epochs', async () => {
    const home = makeTempDir('sup-lock-dead-');
    writeEpoch(home, 3, {
      pid: deadPid(),
      nonce: nonce(),
      createdAt: Date.now() - 120_000,
      control: join(home, 'gone.sock'),
    });
    const starter = await startSupervisor({ home });
    expect(starter.output()).toContain('acquired instance lock epoch 4');
    expect(epochs(home)).toEqual([4]);
    expect(epochContent(home, 4).pid).toBe(starter.child.pid);
  }, 60_000);

  it('takes over the lock of a SIGKILLed supervisor', async () => {
    const home = makeTempDir('sup-lock-kill-');
    const first = await startSupervisor({ home });
    expect(epochs(home)).toEqual([1]);
    first.child.kill('SIGKILL');
    await first.exited;
    const second = await startSupervisor({ home });
    expect((await second.status()).state).toBe('serving');
    expect(epochs(home)).toEqual([2]);
    expect(epochContent(home, 2).pid).toBe(second.child.pid);
  }, 60_000);

  it('releases only its own epoch, and only while the nonce is still its own', async () => {
    const home = makeTempDir('sup-lock-release-');
    const first = await startSupervisor({ home });
    expect(epochs(home)).toEqual([1]);
    const mine = epochContent(home, 1);
    // A later epoch appears, and this supervisor's own file is rewritten by someone else.
    writeEpoch(home, 2, {
      pid: deadPid(),
      nonce: nonce(),
      createdAt: Date.now(),
      control: 'x',
    });
    writeEpoch(home, 1, { ...mine, nonce: nonce() });
    const connection = await first.connect();
    await connection.request({ type: 'stop', id: 'r1' }, ['stop.result']);
    expect(await first.exited).toEqual({ code: 0, signal: null });
    expect(epochs(home)).toEqual([1, 2]);

    // Positive control: an untouched epoch is removed on a clean stop.
    const other = makeTempDir('sup-lock-release-clean-');
    const clean = await startSupervisor({ home: other });
    const stop = await clean.connect();
    await stop.request({ type: 'stop', id: 'r2' }, ['stop.result']);
    expect(await clean.exited).toEqual({ code: 0, signal: null });
    expect(epochs(other)).toEqual([]);
  }, 60_000);
});
