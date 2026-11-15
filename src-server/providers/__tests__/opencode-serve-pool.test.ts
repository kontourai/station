import { spawn as spawnChild } from 'node:child_process';
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
  const binaries = new Map<string, { size: number; mtimeMs: number }>();
  const pool = new OpenCodeServePool({
    realpath: async (path) => path.replace(/^\/tmp\//, '/private/tmp/'),
    stat: async (path) => binaries.get(path) ?? { size: 1, mtimeMs: 1 },
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
    binaries,
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
  mcpDigest: 'no-tool-servers',
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

  test('sessions whose Station tool servers differ never share a server', async () => {
    const h = harness();
    active = h.pool;
    const a = await h.pool.acquire(input({ mcpDigest: 'session-a-servers' }));
    const b = await h.pool.acquire(input({ mcpDigest: 'session-b-servers' }));
    expect(b.url).not.toBe(a.url);
    const again = await h.pool.acquire(
      input({ mcpDigest: 'session-a-servers' }),
    );
    expect(again.url).toBe(a.url);
    expect(h.spawned).toHaveLength(2);
  });

  test("a lease moves its server to another tool-server set's key only while it alone holds it", async () => {
    const h = harness();
    active = h.pool;
    const checked = await h.pool.acquire(input());
    expect(checked.rekey('session-a-servers')).toBe(true);
    // The session's own acquire would now find it; the old key starts anew.
    const own = await h.pool.acquire(input({ mcpDigest: 'session-a-servers' }));
    expect(own.url).toBe(checked.url);
    expect(h.spawned).toHaveLength(1);
    const fresh = await h.pool.acquire(input());
    expect(fresh.url).not.toBe(checked.url);
    expect(h.spawned).toHaveLength(2);
    // Shared (two leases hold it), or the target key taken: refused.
    expect(checked.rekey('session-b-servers')).toBe(false);
    const other = await h.pool.acquire(input({ mcpDigest: 'session-c' }));
    expect(fresh.rekey('session-c')).toBe(false);
    other.release();
    fresh.release();
    // A released lease moves nothing.
    expect(fresh.rekey('session-d')).toBe(false);
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

  test('a changed binary never reuses the server the old one started', async () => {
    const h = harness();
    active = h.pool;
    await h.pool.acquire(input());
    h.binaries.set('/opt/bin/opencode', { size: 1, mtimeMs: 2 });
    await h.pool.acquire(input());
    h.binaries.set('/opt/bin/opencode', { size: 2, mtimeMs: 2 });
    await h.pool.acquire(input());
    expect(h.spawned).toHaveLength(3);
    // Same identity again: shared.
    await h.pool.acquire(input());
    expect(h.spawned).toHaveLength(3);
  });

  test('a spawn that fails reports its error at once and settles exited', async () => {
    let proc: EventEmitter & { stdout: PassThrough; pid?: number } =
      undefined as never;
    const pool = new OpenCodeServePool({
      realpath: async (path) => path,
      stat: async () => ({ size: 1, mtimeMs: 1 }),
      readyTimeoutMs: 60_000,
      spawn: (() => {
        proc = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stdin: new PassThrough(),
          pid: undefined,
          exitCode: null,
          signalCode: null,
        });
        setImmediate(() =>
          proc.emit(
            'error',
            Object.assign(new Error('spawn opencode ENOENT'), {
              code: 'ENOENT',
            }),
          ),
        );
        return { proc: proc as never, release: () => undefined };
      }) as never,
    });
    const started = Date.now();
    await expect(pool.acquire(input())).rejects.toThrow(
      /could not be started \(ENOENT\)/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    await pool.stopAll();
  }, 10_000);

  test('a spawn that throws reports its error at once', async () => {
    const pool = new OpenCodeServePool({
      realpath: async (path) => path,
      stat: async () => ({ size: 1, mtimeMs: 1 }),
      spawn: (() => {
        throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
      }) as never,
    });
    await expect(pool.acquire(input())).rejects.toThrow(/\(EACCES\)/);
  });

  test('stopAll during an acquire stops what that acquire started', async () => {
    let resolvePath!: (path: string) => void;
    const h = harness({
      realpath: (path) =>
        path === '/tmp/project'
          ? new Promise<string>((resolve) => {
              resolvePath = resolve;
            })
          : Promise.resolve(path),
    });
    const pending = h.pool.acquire(input());
    await new Promise((resolve) => setImmediate(resolve));
    await h.pool.stopAll();
    resolvePath('/private/tmp/project');
    await expect(pending).rejects.toThrow(/closed/);
    expect(h.spawned).toHaveLength(0);

    // Closed while the server was starting: it is stopped, not handed out.
    const late = harness();
    const acquiring = late.pool.acquire(input());
    await new Promise((resolve) => setImmediate(resolve));
    expect(late.spawned).toHaveLength(1);
    await late.pool.stopAll();
    await expect(acquiring).rejects.toThrow(/closed|not ready|exited/);
    expect(late.spawned[0]?.proc.exitCode).toBe(0);
  });

  test('a server ignoring stdin close and SIGTERM is killed', async () => {
    // A real child in its own group that ignores SIGTERM and stdin EOF.
    const script = [
      "process.on('SIGTERM', () => process.stdout.write('term\\n'));",
      'process.stdin.resume();',
      "process.stdin.on('end', () => process.stdout.write('eof\\n'));",
      "process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:47999' }) + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const seen: string[] = [];
    let exit: { code: number | null; signal: string | null } | undefined;
    const pool = new OpenCodeServePool({
      realpath: async (path) => path,
      stat: async () => ({ size: 1, mtimeMs: 1 }),
      stopGraceMs: 300,
      fetch: (async () => Response.json({ version: '2.3.0' })) as never,
      spawn: ((_command: string, _args: string[], options: any) => {
        const proc = spawnChild(process.execPath, ['-e', script], {
          cwd: process.cwd(),
          env: { PATH: options.env.PATH },
          stdio: ['pipe', 'pipe', 'ignore'],
          detached: true,
          windowsHide: true,
        });
        proc.stdout!.on('data', (chunk) => {
          seen.push(...chunk.toString().split('\n').filter(Boolean));
        });
        proc.once('exit', (code, signal) => {
          exit = { code, signal };
        });
        return { proc, release: () => undefined };
      }) as never,
    });
    const lease = await pool.acquire(input({ cwd: process.cwd() }));
    lease.discard();
    await lease.exited;
    expect(seen).toContain('eof');
    expect(seen).toContain('term');
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
  }, 10_000);
});
