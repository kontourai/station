import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { spawnSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(import.meta.url);
const ptyModule = (() => {
  if (process.env.STATION_RESOURCE_PROOF_PTY_MODULE)
    return process.env.STATION_RESOURCE_PROOF_PTY_MODULE;
  try {
    require('node-pty');
    return require.resolve('node-pty');
  } catch {
    console.warn(
      'PTY UNVERIFIED: the native node-pty dependency is unavailable.',
    );
    return undefined;
  }
})();
const manager =
  process.platform === 'linux' &&
  spawnSyncBounded('/usr/bin/systemctl', ['--user', 'show-environment'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  }).status === 0;
if (!manager)
  console.warn(
    'ENFORCEMENT UNVERIFIED: workload containment needs a Linux systemd user manager.',
  );

type Snapshot = {
  state: string;
  slice: string;
  limits: { memoryMaxBytes: number; totalMemoryMaxBytes: number };
  active: Array<{ unit: string; pid: number }>;
  recent: Array<{ pid: number; result: string; memoryPeakBytes?: number }>;
};

async function gone(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

describe.skipIf(!manager)('running server workload containment', () => {
  // Scopes do not share the fixture service's PrivateTmp mount.
  const makeTempDir = trackTempDirs({
    base: join(root, 'node_modules'),
    lifetime: 'file',
  });
  const unit = `station-resource-proof-${randomUUID()}.service`;
  const slice = `stationworkload${createHash('sha256').update(unit).digest('hex').slice(0, 16)}.slice`;
  let base: string;
  let output = '';
  let runner: ReturnType<typeof spawn>;
  let sibling: {
    pid: number;
    first: {
      pid: number;
      args: string[];
      cgroup: string;
      env: Record<string, string>;
    };
  };

  async function request<T>(path: string): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${body}\n${output}`);
    return JSON.parse(body) as T;
  }

  beforeAll(async () => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string')
      throw new Error('No fixture port');
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    runner = spawn(
      '/usr/bin/systemd-run',
      [
        '--user',
        '--quiet',
        '--collect',
        '--pipe',
        '--wait',
        '--service-type=exec',
        `--unit=${unit}`,
        `--working-directory=${root}`,
        '--property=MemoryMax=536870912',
        '--property=MemorySwapMax=0',
        '--property=NoNewPrivileges=yes',
        '--property=PrivateTmp=yes',
        `--setenv=PATH=${process.env.PATH}`,
        `--setenv=PORT=${port}`,
        `--setenv=STATION_RESOURCE_PROOF_MCP_OBSERVATIONS=${join(makeTempDir('.station-mcp-proof-'), 'launches.jsonl')}`,
        ...(ptyModule
          ? [`--setenv=STATION_RESOURCE_PROOF_PTY_MODULE=${ptyModule}`]
          : []),
        '--setenv=STATION_WORKLOAD_MEMORY_MIB=64',
        '--setenv=STATION_WORKLOAD_TOTAL_MEMORY_MIB=192',
        '--setenv=STATION_WORKLOAD_SWAP_MIB=0',
        '--setenv=STATION_WORKLOAD_CPU_PERCENT=100',
        '--setenv=FIXTURE_SECRET=must-not-reach-child',
        process.execPath,
        '--import',
        'tsx',
        fileURLToPath(
          new URL('./helpers/workload-resource-server.ts', import.meta.url),
        ),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    runner.stdout?.on('data', (data) => {
      output = (output + data).slice(-32768);
    });
    runner.stderr?.on('data', (data) => {
      output = (output + data).slice(-32768);
    });
    await vi
      .waitFor(
        async () => {
          if (runner.exitCode !== null)
            throw new Error(`Fixture exited: ${output}`);
          expect(
            (await request<{ workloads: Snapshot }>('/status')).workloads.state,
            output,
          ).toBe('ready');
        },
        { timeout: 20_000 },
      )
      .catch((error) => {
        console.error('Workload fixture setup failed:', output, error);
        throw error;
      });
  }, 30_000);

  afterAll(async () => {
    const stopped = spawnSyncBounded(
      '/usr/bin/systemctl',
      ['--user', 'stop', unit],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    );
    expect(stopped.status, stopped.stderr).toBe(0);
    if (runner && runner.exitCode === null) await once(runner, 'exit');
    for (const args of [
      ['stop', slice],
      ['revert', unit, slice],
    ]) {
      const cleanup = spawnSyncBounded(
        '/usr/bin/systemctl',
        ['--user', ...args],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
      );
      expect(cleanup.status, cleanup.stderr).toBe(0);
    }
  });

  test('owned engine keeps its PID, literal argv and restricted environment outside the server cgroup', async () => {
    sibling = await request('/launch');
    const status = await request<{ cgroup: string; workloads: Snapshot }>(
      '/status',
    );
    expect(status.cgroup).toContain(unit);
    expect(sibling.first.pid).toBe(sibling.pid);
    expect(sibling.first.cgroup).not.toContain(unit);
    expect(sibling.first.cgroup).toContain(status.workloads.slice);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: argv must retain literal shell expansions.
    expect(sibling.first.args).toEqual(['literal $HOME ${PATH} $(false)']);
    expect(sibling.first.env.FIXTURE_VALUE).toBe('exact $HOME');
    expect(sibling.first.env.FIXTURE_SECRET).toBeUndefined();
    expect(sibling.first.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    expect(sibling.first.env.XDG_RUNTIME_DIR).toBeUndefined();
    expect(status.workloads.limits.memoryMaxBytes).toBe(64 * 1024 * 1024);
    const leaf = sibling.first.cgroup.trim().split('::')[1];
    expect(
      Number(await readFile(`/sys/fs/cgroup${leaf}/memory.max`, 'utf8')),
    ).toBe(64 * 1024 * 1024);
  });

  test('a real workload OOM leaves the answering server and sibling engine alive and records its cause', async () => {
    const result = await request<{
      code: number | null;
      signal: string;
      workloads: Snapshot;
    }>('/launch?mode=oom');
    expect(result.signal).toBe('SIGKILL');
    expect(
      result.workloads.recent.some((entry) => entry.result === 'oom-kill'),
    ).toBe(true);
    expect(await gone(sibling.pid)).toBe(false);
    expect(
      (await request<{ workloads: Snapshot }>('/status')).workloads.state,
    ).toBe('ready');
  });

  test('leader exit reaps descendants that start a new session and retain no process-group membership', async () => {
    const result = await request<{ escapedPid: number }>('/launch?mode=escape');
    expect(result.escapedPid).toBeGreaterThan(1);
    await expect.poll(() => gone(result.escapedPid)).toBe(true);
    expect(await gone(sibling.pid)).toBe(false);
  });

  test('the scope exec preserves Node IPC and the browser extra pipe descriptors', async () => {
    expect(await request('/launch?mode=ipc')).toMatchObject({ ok: true });
    const fds = await request<{ code: number; output: string }>(
      '/launch?mode=fds',
    );
    expect(fds.code).toBe(0);
    expect(fds.output).toContain('fd3');
    expect(fds.output).toContain('fd4');
  });

  test('captured command execution runs outside the control server with its workload budget', async () => {
    const result = await request<{ stdout: string; stderr: string }>('/exec');
    expect(result.stdout).toContain(slice);
    expect(result.stdout).not.toContain(unit);
    expect(result.stderr).toBe('');
  });

  test('managed cancellation lets the workload handle SIGTERM before descendant cleanup', async () => {
    expect(await request('/graceful')).toEqual({
      output: 'graceful\n',
      code: 0,
    });
  });

  test.each(['', '?legacy=1'])(
    'MCP leader exit reaps a new-session descendant retaining stdio (%s)',
    async (query) => {
      const message = await request<{ result: { descendant: number } }>(
        `/mcp${query}`,
      );
      expect(message.result.descendant).toBeGreaterThan(1);
      // Leader identity is sampled once per second; allow the next sweep
      // and its bounded systemd cleanup, independent of the timer's phase.
      await expect
        .poll(() => gone(message.result.descendant), {
          timeout: 5000,
        })
        .toBe(true);
      expect(await gone(sibling.pid)).toBe(false);
    },
  );

  test('full MCP client negotiation owns probe and session scopes independently', async () => {
    const response = await request<{
      result: {
        structuredContent: { pid: number; descendant: number; cgroup: string };
      };
      launches: Array<{ pid: number; descendant: number; cgroup: string }>;
      workloads: Snapshot;
    }>('/mcp-handshake');
    const identity = response.result.structuredContent;
    expect(response.launches).toHaveLength(2);
    expect(new Set(response.launches.map((launch) => launch.cgroup)).size).toBe(
      2,
    );
    expect(response.launches.map((launch) => launch.pid)).toContain(
      identity.pid,
    );
    for (const launch of response.launches) {
      expect(launch.cgroup).toContain(slice);
      expect(launch.cgroup).not.toContain(unit);
      await expect.poll(() => gone(launch.pid)).toBe(true);
      await expect.poll(() => gone(launch.descendant)).toBe(true);
    }
    expect(identity.cgroup).toContain(slice);
    expect(identity.cgroup).not.toContain(unit);
    await expect.poll(() => gone(identity.descendant)).toBe(true);
    await expect
      .poll(
        async () =>
          (await request<{ workloads: Snapshot }>('/status')).workloads.active,
      )
      .toHaveLength(1);
    expect(await gone(sibling.pid)).toBe(false);
  });

  test.skipIf(!ptyModule)(
    'terminal close allows its SIGHUP handler to flush before scope cleanup',
    async () => {
      expect(
        (await request<{ output: string }>('/terminal-grace')).output,
      ).toContain('flushed');
    },
  );

  test.skipIf(!ptyModule)(
    'the real terminal preserves input, size, cwd and foreground interrupt',
    async () => {
      const result = await request<{
        pid: number;
        cwd: string;
        output: string;
      }>('/terminal');
      expect(result.cwd).toBe('/');
      expect(result.output).toContain('37 101');
      expect(result.output).toContain(slice);
      expect(result.output).toContain('__PROOF_RESUMED__');
      await expect.poll(() => gone(result.pid)).toBe(true);
    },
  );

  test('a replacement generation reclaims a dead owner while preserving a live owner in the same service', async () => {
    const orphan = await request<{ pid: number }>('/orphan');
    expect(await gone(orphan.pid)).toBe(false);
    const response = await fetch(`${base}/reap`);
    expect(response.status).toBe(200);
    await expect.poll(() => gone(orphan.pid)).toBe(true);
    expect(await gone(sibling.pid)).toBe(false);
  });

  test('unavailable enforcement keeps management available and refuses new workloads', async () => {
    const result = await request<{
      blocked: boolean;
      error: string;
      workloads: Snapshot;
    }>('/unavailable');
    expect(result.blocked).toBe(true);
    expect(result.workloads.state).toBe('unavailable');
    expect(result.error).toContain('cannot start this workload');
    expect(
      (await request<{ workloads: Snapshot }>('/status')).workloads.state,
    ).toBe('ready');
  });

  test('aggregate memory exhaustion is contained outside the answering server', async () => {
    await request('/aggregate');
    const status = await request<{ workloads: Snapshot }>('/status');
    expect(status.workloads.state).toBe('ready');
    const cgroup = spawnSyncBounded(
      '/usr/bin/systemctl',
      ['--user', 'show', slice, '--property=ControlGroup', '--value'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    );
    expect(cgroup.status, cgroup.stderr).toBe(0);
    const events = await readFile(
      `/sys/fs/cgroup${cgroup.stdout.trim()}/memory.events.local`,
      'utf8',
    );
    expect(Number(/^oom (\d+)$/m.exec(events)?.[1])).toBeGreaterThan(0);
  });
});
