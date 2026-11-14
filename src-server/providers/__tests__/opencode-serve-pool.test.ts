import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OpenCodeServeDeniedPathError } from '../adapters/opencode-serve-client.js';
import {
  OpenCodeServePool,
  type OpenCodeServePoolOptions,
} from '../adapters/opencode-serve-pool.js';

/**
 * The pool against a stand-in for `opencode serve --stdio`: it prints the
 * ready line OpenCode prints, and exits when its stdin closes, as the real
 * server's lease does. No pid, so no signal can reach a real process group.
 */
class FakeServe extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = undefined;
  exitCode: number | null = null;
  readonly signalCode = null;
  constructor(port: number) {
    super();
    this.stdin.on('finish', () => {
      this.exitCode = 0;
      this.emit('exit', 0, null);
    });
    setImmediate(() =>
      this.stdout.write(
        `${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`,
      ),
    );
  }
}

type Spawned = {
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv };
  proc: FakeServe;
  released: number;
};

function harness(options: Partial<OpenCodeServePoolOptions> = {}) {
  const spawned: Spawned[] = [];
  const infoAuth: string[] = [];
  let infoAnswers: number[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(new URL(url).pathname).toBe('/api/info');
    infoAuth.push((init!.headers as Record<string, string>).authorization!);
    const status = infoAnswers.shift() ?? 200;
    return Response.json({ version: '2.3.0' }, { status });
  });
  const pool = new OpenCodeServePool({
    realpath: async (path) => path.replace(/^\/tmp\//, '/private/tmp/'),
    fetch: fetch as never,
    idleStopMs: 20,
    spawn: ((command: string, args: string[], spawnOptions: any) => {
      const entry: Spawned = {
        command,
        args,
        options: spawnOptions,
        proc: new FakeServe(47000 + spawned.length),
        released: 0,
      };
      spawned.push(entry);
      return {
        proc: entry.proc as never,
        release: () => {
          entry.released += 1;
        },
      };
    }) as never,
    ...options,
  });
  return {
    pool,
    spawned,
    infoAuth,
    fetch,
    setInfoAnswers: (answers: number[]) => {
      infoAnswers = answers;
    },
  };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  connectionId: 'opencode-1',
  binary: '/opt/bin/opencode',
  cwd: '/tmp/project',
  env: {
    PATH: '/usr/bin',
    OPENCODE_SERVER_PASSWORD: 'inherited',
    OPENCODE_PASSWORD: 'inherited-too',
  },
  tmpDir: '/station/tmp/engine',
  ...overrides,
});

let active: OpenCodeServePool | undefined;
afterEach(async () => {
  await active?.stopAll();
  active = undefined;
});

describe('OpenCodeServePool', () => {
  test('starts serve on an OS-chosen loopback port, in the real cwd, with its own password', async () => {
    const h = harness();
    active = h.pool;
    const lease = await h.pool.acquire(input());
    const [server] = h.spawned;
    expect(server?.command).toBe('/opt/bin/opencode');
    expect(server?.args).toEqual([
      'serve',
      '--stdio',
      '--hostname',
      '127.0.0.1',
      '--port',
      '0',
    ]);
    expect(server?.options.cwd).toBe('/private/tmp/project');
    expect(lease.cwd).toBe('/private/tmp/project');
    const env = server!.options.env!;
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(env.OPENCODE_PASSWORD).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.OPENCODE_PASSWORD).not.toBe('inherited-too');
    expect(env.TMPDIR).toBe('/station/tmp/engine');
    expect(lease.url).toBe('http://127.0.0.1:47000');
    // Readiness was asked with that password.
    expect(h.infoAuth[0]).toBe(
      `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString('base64')}`,
    );
    // The lease's client carries the same credential and the denylist.
    await expect(
      lease.client.request('GET', '/api/credential'),
    ).rejects.toBeInstanceOf(OpenCodeServeDeniedPathError);
    lease.release();
  });

  test('a booting server (503) is asked again until it answers', async () => {
    const h = harness();
    active = h.pool;
    h.setInfoAnswers([503, 503]);
    await h.pool.acquire(input());
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  test('a server refusing readiness is stopped and the acquire fails', async () => {
    const h = harness();
    active = h.pool;
    h.setInfoAnswers([401]);
    await expect(h.pool.acquire(input())).rejects.toThrow(
      /did not become ready/,
    );
    expect(h.spawned[0]?.proc.exitCode).toBe(0);
    expect(h.spawned[0]?.released).toBe(1);
  });

  test('one server per connection, real cwd and environment, shared by reference', async () => {
    const h = harness();
    active = h.pool;
    const a = await h.pool.acquire(input());
    const b = await h.pool.acquire(input({ cwd: '/private/tmp/project' }));
    expect(h.spawned).toHaveLength(1);
    expect(b.url).toBe(a.url);
    await h.pool.acquire(input({ cwd: '/tmp/other' }));
    await h.pool.acquire(input({ connectionId: 'opencode-2' }));
    await h.pool.acquire(input({ env: { PATH: '/other' } }));
    expect(h.spawned).toHaveLength(4);
  });

  test('a server stops only once every lease is back and the idle bound passed', async () => {
    const h = harness();
    active = h.pool;
    const a = await h.pool.acquire(input());
    const b = await h.pool.acquire(input());
    a.release();
    a.release();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.spawned[0]?.proc.exitCode).toBeNull();
    b.release();
    await a.exited;
    expect(h.spawned[0]?.released).toBe(1);
    // The next acquire starts a fresh server.
    await h.pool.acquire(input());
    expect(h.spawned).toHaveLength(2);
  });

  test('a discarded lease stops its server at once unless another lease holds it', async () => {
    const h = harness({ idleStopMs: 60_000 });
    active = h.pool;
    const a = await h.pool.acquire(input());
    const b = await h.pool.acquire(input());
    a.discard();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.spawned[0]?.proc.exitCode).toBeNull();
    b.discard();
    // Well inside the idle bound: only a stop at once ends it this soon.
    const stopped = await Promise.race([
      b.exited.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 2_000),
      ),
    ]);
    expect(stopped).toBe(true);
    expect(h.spawned[0]?.proc.exitCode).toBe(0);
  });

  test('a lease taken within the idle bound keeps the server', async () => {
    const h = harness({ idleStopMs: 30 });
    active = h.pool;
    (await h.pool.acquire(input())).release();
    const again = await h.pool.acquire(input());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.proc.exitCode).toBeNull();
    again.release();
  });

  test('the preview gate is asked before every spawn', async () => {
    let allowed = false;
    const h = harness({ allowSpawn: () => allowed });
    active = h.pool;
    await expect(h.pool.acquire(input())).rejects.toThrow(/turned off/);
    expect(h.spawned).toHaveLength(0);
    allowed = true;
    await h.pool.acquire(input());
    expect(h.spawned).toHaveLength(1);
  });
});
