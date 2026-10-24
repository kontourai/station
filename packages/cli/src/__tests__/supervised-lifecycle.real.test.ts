// @vitest-environment node
/**
 * Journeys over real processes: the CLI (this checkout's launcher entry,
 * `scripts/station-cli.ts`) starts, restarts and stops an instance whose
 * build is the real server and supervisor bundles, against an isolated home
 * and loopback ports.
 *
 * - `station start` runs the supervisor, which runs the core server as a
 *   supervised generation; the instance record names the supervisor.
 * - `station restart` hands off to a new generation while HTTP clients keep
 *   connecting, refusing and resetting nothing.
 * - `station stop` drains through the control channel; every process exits.
 * - With STATION_DIRECT_LAUNCH=1 the server starts directly, its record has
 *   the shape an earlier CLI wrote, restart refuses, and stop still works:
 *   the new CLI against an unsupervised instance.
 *
 * The published CLI bundle refuses `start` and `stop` by design (they manage
 * a checkout), so the checkout's own CLI entry is the one a user runs here.
 *
 * Runs on Windows too, where `stop` reaches the supervisor over its named
 * pipe; only the frozen-supervisor case, which needs SIGSTOP, is POSIX-only.
 */
import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
  spawnSync,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { findListeningPidsForPorts } from '../commands/lifecycle.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const INSTANCE = `svlife${process.pid}${randomUUID().slice(0, 6)}`;
// The instance's own build directories (git-ignored), inside the checkout so
// the server bundle's external packages resolve from its node_modules.
const SERVER_DIR = join(repoRoot, `dist-server-${INSTANCE}`);
const UI_DIR = join(repoRoot, `dist-ui-${INSTANCE}`);
const RECORD = join(repoRoot, '.station', 'instances', `${INSTANCE}.json`);
// Liveness bounds, generous for a loaded host; nothing asserts a duration.
const BUILD_TIMEOUT_MS = 300_000;
const CLI_TIMEOUT_MS = 240_000;
const REQUEST_TIMEOUT_MS = 60_000;
const POSIX = process.platform !== 'win32';

// Short, so the supervisor's control socket path stays short on macOS.
const makeHomeRoot = trackTempDirs({
  base: process.env.STATION_VITEST_HOST_TMPDIR ?? tmpdir(),
});
const launchedPids = new Set<number>();

interface InstanceRecord {
  serverPid: number;
  uiPid: number;
  supervised?: boolean;
  build?: { sha: string } | null;
}

/** A rebake to undo after the test that made it. */
let rebaked: { from: string; to: string } | null = null;

/** Replaces the bundle's baked sha and its build stamp, as a rebuild would. */
function rebake(from: string, to: string): void {
  for (const file of ['command-station.js', 'station-build.json']) {
    const path = join(SERVER_DIR, file);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(from);
    writeFileSync(path, text.replaceAll(from, to));
  }
}

/** The UI proxy's own readiness answer: 200 only for an identified backend. */
function uiReadiness(port: number): Promise<number> {
  return new Promise((resolveStatus) => {
    http
      .get(
        { host: '127.0.0.1', port, path: '/api/system/readiness' },
        (res) => {
          res.resume();
          res.on('end', () => resolveStatus(res.statusCode ?? 0));
        },
      )
      .on('error', () => resolveStatus(0));
  });
}

/**
 * Whether a core generation booted with `sha`: each boot writes its build
 * provenance to the home's server log, `logs/server` (boot-history.ts). The identity routes
 * that report it need credentials this test does not hold.
 */
function bootedWithSha(home: string, sha: string): boolean {
  const logs = join(home, 'logs', 'server');
  return readdirSync(logs).some((file) => {
    try {
      return readFileSync(join(logs, file), 'utf8').includes(sha);
    } catch {
      return false;
    }
  });
}

function isolatedEnv(root: string, extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('STATION_') || key.startsWith('OTEL_')) continue;
    if (key === 'PORT') continue;
    env[key] = value;
  }
  return {
    ...env,
    STATION_TEMP_ROOT: join(root, 'temp-root'),
    STATION_OWNED_PROCESS_REGISTRY: join(root, 'owned-processes'),
    ...extra,
  };
}

async function station(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'scripts/station-cli.ts', ...args],
      {
        cwd: repoRoot,
        env,
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as {
      code?: unknown;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? String(error),
    };
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parentOf(pid: number): number {
  const output = POSIX
    ? execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
        encoding: 'utf8',
        windowsHide: true,
      })
    : execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
  return Number(output.trim());
}

function readRecord(): InstanceRecord & Record<string, unknown> {
  return JSON.parse(readFileSync(RECORD, 'utf8'));
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.once('error', () => resolveFree(false));
    server.listen(port, '127.0.0.1', () =>
      server.close(() => resolveFree(true)),
    );
  });
}

/** A server port block (port..port+3) and a UI port, all free on loopback. */
async function freePorts(): Promise<{ server: number; ui: number }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const server = 41_000 + Math.floor(Math.random() * 18_000);
    const ui = server + 10;
    const ports = [server, server + 1, server + 2, server + 3, ui];
    if (ports.includes(3141) || ports.includes(3000)) continue;
    const free = await Promise.all(ports.map(portFree));
    if (free.every(Boolean)) return { server, ui };
  }
  throw new Error('no free port block');
}

function refused(port: number): Promise<boolean> {
  return new Promise((resolveRefused) => {
    const socket = createConnection(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolveRefused(false);
    });
    socket.once('error', () => resolveRefused(true));
  });
}

/**
 * Keep-alive loops reuse connections as a browser pool does; fresh loops
 * open one per request, so some land in the backlog while no generation
 * accepts.
 */
function startPoller(port: number) {
  const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const stats = {
    ok: 0,
    errors: {} as Record<string, number>,
    statuses: {} as Record<string, number>,
  };
  let running = true;
  const count = (bucket: Record<string, number>, key: string) => {
    bucket[key] = (bucket[key] ?? 0) + 1;
  };
  const request = (agent: http.Agent | false) =>
    new Promise<void>((resolveRequest) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: '/api/system/liveness',
          agent,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            count(stats.statuses, String(res.statusCode));
            if (res.statusCode === 200) stats.ok += 1;
            resolveRequest();
          });
          res.on('error', (error: NodeJS.ErrnoException) => {
            count(stats.errors, error.code ?? error.message);
            resolveRequest();
          });
        },
      );
      req.on('timeout', () =>
        req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })),
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        count(stats.errors, error.code ?? error.message);
        resolveRequest();
      });
    });
  const agents: Array<http.Agent | false> = [
    keepAlive,
    keepAlive,
    keepAlive,
    false,
    false,
  ];
  const loops = agents.map(async (agent) => {
    while (running) await request(agent);
  });
  return {
    stats,
    async stop() {
      running = false;
      await Promise.all(loops);
      keepAlive.destroy();
      return stats;
    },
  };
}

beforeAll(async () => {
  await execFileAsync(process.execPath, ['esbuild.config.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, STATION_BUILD_SERVER_DIR: SERVER_DIR },
    timeout: BUILD_TIMEOUT_MS,
    windowsHide: true,
  });
  expect(existsSync(join(SERVER_DIR, 'station-supervisor.js'))).toBe(true);
  // The stamp `station build` writes: the sha the server bundle baked in.
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  writeFileSync(
    join(SERVER_DIR, 'station-build.json'),
    JSON.stringify({
      sha,
      branch: 'journey',
      builtAt: new Date().toISOString(),
    }),
  );
  mkdirSync(UI_DIR, { recursive: true });
  writeFileSync(join(UI_DIR, 'index.html'), '<!doctype html><title>j</title>');
}, BUILD_TIMEOUT_MS + 10_000);

afterEach(async () => {
  // A failed journey must not leave its processes running.
  for (const pid of launchedPids) {
    if (!alive(pid)) continue;
    if (!POSIX) {
      // The tree: a supervisor's core is its child.
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      continue;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone.
      }
    }
  }
  launchedPids.clear();
  // Later starts check the build stamp against HEAD; put it back.
  if (rebaked) {
    rebake(rebaked.from, rebaked.to);
    rebaked = null;
  }
  rmSync(RECORD, { force: true });
});

afterAll(() => {
  rmSync(SERVER_DIR, { recursive: true, force: true });
  rmSync(UI_DIR, { recursive: true, force: true });
});

/**
 * `station service run` in the foreground, as an installed unit or the
 * container runs it. Resolves once it supervises a ready Station.
 */
async function startServiceRun(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ child: ChildProcess; output: () => string }> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/station-cli.ts', 'service', 'run', ...args],
    {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let output = '';
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-256 * 1024);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  await waitUntil(
    () => output.includes('Supervising Station') || child.exitCode !== null,
    CLI_TIMEOUT_MS,
    'service run supervising Station',
  );
  if (child.exitCode !== null)
    throw new Error(`service run exited:\n${output}`);
  return { child, output: () => output };
}

describe('station start, restart and stop under the process supervisor', () => {
  it('starts a supervised core, restarts it with no refused connection, and stops every process', async () => {
    const root = makeHomeRoot('svl-');
    const home = join(root, 'h');
    const env = isolatedEnv(root);
    const ports = await freePorts();
    const target = [`--home=${home}`, `--instance=${INSTANCE}`];

    const started = await station(
      [
        'start',
        ...target,
        `--port=${ports.server}`,
        `--ui-port=${ports.ui}`,
        '--host=127.0.0.1',
      ],
      env,
    );
    expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(0);
    expect(started.stdout).toContain('✓ Supervisor: pid');
    const record = readRecord();
    launchedPids.add(record.serverPid);
    launchedPids.add(record.uiPid);
    // The launcher did not bypass the supervisor: the record names it, and
    // the core serving the API is its child, not the recorded process.
    expect(record.supervised).toBe(true);
    const before = await station(
      ['supervisor', 'status', '--json', ...target],
      env,
    );
    expect(before.code, before.stderr).toBe(0);
    const status1 = JSON.parse(before.stdout);
    expect(status1).toMatchObject({
      state: 'serving',
      supervisor: { pid: record.serverPid, instance: INSTANCE },
      active: { generation: 1, state: 'serving' },
    });
    const core1 = status1.active.pid as number;
    launchedPids.add(core1);
    expect(core1).not.toBe(record.serverPid);
    expect(parentOf(core1)).toBe(record.serverPid);
    expect(
      status1.listeners.map((l: { port: number }) => l.port).sort(),
    ).toEqual(
      [
        ports.server,
        ports.server + 1,
        ports.server + 2,
        ports.server + 3,
      ].sort(),
    );

    // `station service run` tears down an instance whose recorded pid is
    // not among its port's listeners; the supervisor holds the socket.
    // The listing comes from lsof, which Windows lacks: empty there.
    const listeners = findListeningPidsForPorts([ports.server]);
    if (listeners.length > 0) expect(listeners).toContain(record.serverPid);

    const poller = startPoller(ports.server);
    try {
      await waitUntil(() => poller.stats.ok > 50, REQUEST_TIMEOUT_MS, 'load');
      const restarted = await station(['restart', ...target], env);
      expect(restarted.code, `${restarted.stdout}\n${restarted.stderr}`).toBe(
        0,
      );
      expect(restarted.stdout).toContain('✓ Restarted: generation 2 serves');
      const servedAtHandoff = poller.stats.ok;
      await waitUntil(
        () => poller.stats.ok > servedAtHandoff + 50,
        REQUEST_TIMEOUT_MS,
        'load after the handoff',
      );
    } finally {
      const stats = await poller.stop();
      expect(stats.errors).toEqual({});
      expect(Object.keys(stats.statuses)).toEqual(['200']);
    }
    const after = JSON.parse(
      (await station(['supervisor', 'status', '--json', ...target], env))
        .stdout,
    );
    expect(after).toMatchObject({
      supervisor: { pid: record.serverPid },
      active: { generation: 2, state: 'serving' },
    });
    const core2 = after.active.pid as number;
    launchedPids.add(core2);
    expect(core2).not.toBe(core1);
    expect(alive(core1)).toBe(false);
    expect(readRecord().serverPid).toBe(record.serverPid);

    // Restart into a genuinely different build, as `station build` would
    // leave it: another baked sha in the bundle and its stamp. The UI
    // proxy, which never restarts, must still find the backend ready.
    expect(await uiReadiness(ports.ui)).toBe(200);
    const oldSha = readRecord().build?.sha ?? '';
    const newSha = 'd'.repeat(40);
    rebake(oldSha, newSha);
    rebaked = { from: newSha, to: oldSha };
    const rebuilt = await station(['restart', ...target], env);
    expect(rebuilt.code, `${rebuilt.stdout}\n${rebuilt.stderr}`).toBe(0);
    expect(bootedWithSha(home, newSha)).toBe(true);
    expect(readRecord().build?.sha).toBe(newSha);
    // The proxy answers from a fresh probe: ready now, and still ready.
    expect(await uiReadiness(ports.ui)).toBe(200);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    expect(await uiReadiness(ports.ui)).toBe(200);
    const status3 = JSON.parse(
      (await station(['supervisor', 'status', '--json', ...target], env))
        .stdout,
    );
    launchedPids.add(status3.active.pid);

    const stopped = await station(['stop', ...target], env);
    expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
    expect(stopped.stderr).not.toContain('did not take a stop request');
    for (const pid of [
      record.serverPid,
      core2,
      status3.active.pid as number,
      record.uiPid,
    ]) {
      expect(alive(pid), `pid ${pid}`).toBe(false);
    }
    expect(existsSync(RECORD)).toBe(false);
    // It stopped on the control channel's request, not on a signal.
    const log = readFileSync(
      join(home, 'logs', `station-${INSTANCE}.log`),
      'utf8',
    );
    // On every platform: a signalled supervisor logs `received SIGTERM`
    // (on Windows a signal kills it outright and it logs nothing).
    expect(log).toContain('shutting down with exit code 0');
    expect(log).not.toContain('received SIGTERM');
    for (const port of [ports.server, ports.server + 1, ports.ui]) {
      expect(await refused(port), `port ${port}`).toBe(true);
    }
  }, 600_000);

  // SIGSTOP has no Windows equivalent to freeze the supervisor with.
  it.skipIf(!POSIX)(
    'station stop stops a supervisor that never answers in under 60 seconds',
    async () => {
      const root = makeHomeRoot('svs-');
      const home = join(root, 'h');
      const env = isolatedEnv(root);
      const ports = await freePorts();
      const target = [`--home=${home}`, `--instance=${INSTANCE}`];
      const started = await station(
        [
          'start',
          ...target,
          `--port=${ports.server}`,
          `--ui-port=${ports.ui}`,
          '--host=127.0.0.1',
        ],
        env,
      );
      expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(0);
      const record = readRecord();
      launchedPids.add(record.serverPid);
      launchedPids.add(record.uiPid);
      const status = JSON.parse(
        (await station(['supervisor', 'status', '--json', ...target], env))
          .stdout,
      );
      const core = status.active.pid as number;
      launchedPids.add(core);

      // Frozen: it accepts control connections into its backlog and never
      // answers, and a SIGTERM waits until it is continued.
      process.kill(record.serverPid, 'SIGSTOP');
      const began = Date.now();
      const stopped = await station(['stop', ...target], env);
      const tookMs = Date.now() - began;
      expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      expect(stopped.stderr).toContain('did not take a stop request');
      // The unmanaged path; the managed one, under service run, has its own
      // test below.
      expect(tookMs).toBeLessThan(60_000);
      expect(alive(record.serverPid)).toBe(false);
      // Its core learns of the supervisor's death from the closed IPC channel.
      await waitUntil(() => !alive(core), 30_000, 'the core exiting');
    },
    600_000,
  );

  it('starts directly with STATION_DIRECT_LAUNCH=1, and the new CLI still stops that unsupervised instance', async () => {
    const root = makeHomeRoot('svd-');
    const home = join(root, 'h');
    const env = isolatedEnv(root, { STATION_DIRECT_LAUNCH: '1' });
    const ports = await freePorts();
    const target = [`--home=${home}`, `--instance=${INSTANCE}`];

    const started = await station(
      [
        'start',
        ...target,
        `--port=${ports.server}`,
        `--ui-port=${ports.ui}`,
        '--host=127.0.0.1',
      ],
      env,
    );
    expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(0);
    expect(started.stdout).not.toContain('Supervisor:');
    const record = readRecord();
    launchedPids.add(record.serverPid);
    launchedPids.add(record.uiPid);
    // The record an earlier CLI wrote: no `supervised` key at all.
    expect(Object.hasOwn(record, 'supervised')).toBe(false);
    // No supervisor ran: it would have made its run directory beside the home.
    expect(existsSync(join(root, '.h.station-supervisor'))).toBe(false);

    // Without the opt-out in its environment, the new CLI reads the record.
    const plainEnv = isolatedEnv(root);
    const status = await station(['supervisor', 'status', ...target], plainEnv);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain('runs without the process supervisor');
    const restart = await station(['restart', ...target], plainEnv);
    expect(restart.code).not.toBe(0);
    expect(restart.stderr).toContain('cannot restart in place');
    expect(alive(record.serverPid)).toBe(true);

    const stopped = await station(['stop', ...target], plainEnv);
    expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
    expect(alive(record.serverPid)).toBe(false);
    expect(alive(record.uiPid)).toBe(false);
    expect(existsSync(RECORD)).toBe(false);
  }, 600_000);
  it.each([
    ['supervised', false],
    ['started directly', true],
  ])(
    'frees every port when the service run of a %s instance is killed',
    async (_kind, direct) => {
      const root = makeHomeRoot('svk-');
      const home = join(root, 'h');
      const env = isolatedEnv(
        root,
        direct ? { STATION_DIRECT_LAUNCH: '1' } : {},
      );
      const ports = await freePorts();
      const run = await startServiceRun(
        [
          `--home=${home}`,
          `--instance=${INSTANCE}`,
          `--port=${ports.server}`,
          `--ui-port=${ports.ui}`,
        ],
        env,
      );
      const runPid = run.child.pid ?? 0;
      launchedPids.add(runPid);
      const record = readRecord();
      launchedPids.add(record.serverPid);
      launchedPids.add(record.uiPid);
      expect(record.supervised).toBe(direct ? undefined : true);
      // Supervised, the core is the supervisor's child; direct, it is the
      // recorded server process, which keeps its own parent watchdog.
      const core = direct
        ? record.serverPid
        : (JSON.parse(
            (
              await station(
                [
                  'supervisor',
                  'status',
                  '--json',
                  `--home=${home}`,
                  `--instance=${INSTANCE}`,
                ],
                env,
              )
            ).stdout,
          ).active.pid as number);
      launchedPids.add(core);
      // Its children: the supervisor or direct server, and the UI listener.
      expect(parentOf(record.serverPid)).toBe(runPid);
      expect(parentOf(record.uiPid)).toBe(runPid);

      // SIGKILL on POSIX, TerminateProcess on Windows: none of its cleanup runs.
      run.child.kill('SIGKILL');
      await waitUntil(
        () => !alive(record.serverPid) && !alive(core) && !alive(record.uiPid),
        60_000,
        'the supervisor, its core and the UI listener exiting',
      );
      for (const port of [ports.server, ports.server + 1, ports.ui]) {
        expect(await refused(port), `port ${port}`).toBe(true);
      }
    },
    600_000,
  );

  // SIGSTOP has no Windows equivalent to freeze the supervisor with.
  it.skipIf(!POSIX)(
    "stops a frozen supervisor inside service run's 60-second shutdown deadline",
    async () => {
      const root = makeHomeRoot('svm-');
      const home = join(root, 'h');
      const env = isolatedEnv(root);
      const ports = await freePorts();
      const run = await startServiceRun(
        [
          `--home=${home}`,
          `--instance=${INSTANCE}`,
          `--port=${ports.server}`,
          `--ui-port=${ports.ui}`,
        ],
        env,
      );
      launchedPids.add(run.child.pid ?? 0);
      const record = readRecord();
      launchedPids.add(record.serverPid);
      launchedPids.add(record.uiPid);

      process.kill(record.serverPid, 'SIGSTOP');
      const began = Date.now();
      run.child.kill('SIGTERM');
      await waitUntil(
        () => run.child.exitCode !== null,
        90_000,
        'service run exiting',
      );
      const tookMs = Date.now() - began;
      // Its own cleanup finished; the 60-second force exit never fired.
      expect(run.output()).not.toContain('forcing exit');
      expect(run.child.exitCode, run.output()).toBe(0);
      expect(tookMs).toBeLessThan(60_000);
      expect(alive(record.serverPid)).toBe(false);
      expect(alive(record.uiPid)).toBe(false);
    },
    600_000,
  );
});
