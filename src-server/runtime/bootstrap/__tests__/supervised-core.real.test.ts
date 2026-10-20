// @vitest-environment node
/**
 * Journeys over real processes: the built supervisor bundle runs the built
 * core server bundle against an isolated Station home on loopback ports.
 *
 * - A parked generation leaves the home, the temp root, and the engine
 *   registry untouched until it is promoted.
 * - A handoff from generation 1 to 2 under continuous HTTP load, including
 *   requests whose headers are still arriving when generation 1 drains,
 *   refuses and resets nothing, keeps every port, and leaves the terminal,
 *   voice, and consent listeners served by the new generation.
 * - The supervisor (from source, with its fixture core) leaves a fresh home
 *   untouched, and keeps its socket, token, and lock through a home schema
 *   migration, since its run directory is beside the home.
 */
import {
  type ChildProcess,
  execFile,
  fork,
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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ensureStationHomeSchemaSync,
  readStationHomeSchemaVersion,
  STATION_HOME_SCHEMA_VERSION,
  stationHomeSchemaNeedsReset,
} from '@kontourai/station-shared/station-home-schema';
import {
  resolveControlEndpoint,
  type SupervisorStatus,
} from '@kontourai/station-supervisor/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { scaleLivenessMs } from '../../../../scripts/lib/liveness-scale.mjs';
import {
  type ControlConnection,
  connectControl,
} from '../../../__test-utils__/supervisor-control.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
// Inside the checkout (and git-ignored as dist-server-*), so the bundle's
// external packages resolve from the checkout's node_modules.
const buildDir = join(
  repoRoot,
  `dist-server-supervised-core-${process.pid}-${randomUUID().slice(0, 8)}`,
);
const SUPERVISOR = join(buildDir, 'station-supervisor.js');
const CORE = join(buildDir, 'command-station.js');
const INSTANCE = 'journey';
const BUILD_TIMEOUT_MS = scaleLivenessMs(120_000);
const BOOT_TIMEOUT_MS = scaleLivenessMs(120_000);
const REQUEST_TIMEOUT_MS = scaleLivenessMs(90_000);
const OUTPUT_LIMIT = 256 * 1024;
const STABLE_AFTER_MS = 2_000;

const execFileAsync = promisify(execFile);
// Created before the hooks that stop children, so its after-hook runs last:
// the directories outlive the processes using them.
const makeShortTempDir = trackTempDirs({
  base: process.env.STATION_VITEST_HOST_TMPDIR ?? tmpdir(),
});
const children = new Set<ChildProcess>();

/** The parent's own Station settings must not leak into these children. */
function isolatedEnv(home: string, extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('STATION_') || key.startsWith('OTEL_')) continue;
    if (key === 'PORT') continue;
    env[key] = value;
  }
  return {
    ...env,
    STATION_HOME: home,
    STATION_HOST: '127.0.0.1',
    PORT: '0',
    // Boot sweeps these; keep them off the host's shared ones.
    STATION_TEMP_ROOT: join(dirname(home), 'temp-root'),
    STATION_OWNED_PROCESS_REGISTRY: join(dirname(home), 'owned-processes'),
    ...extra,
  };
}

function makeHomeRoot(): string {
  // Short, so the control socket path is as short as it can be on macOS.
  return makeShortTempDir('svj-');
}

function exitOf(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolveExit) =>
    child.once('exit', (code) => resolveExit(code)),
  );
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = exitOf(child);
  child.kill('SIGTERM');
  const killer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  await exited;
  clearTimeout(killer);
}

function capture(child: ChildProcess): () => string {
  let output = '';
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => output;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitFor<T>(
  what: string,
  deadlineMs: number,
  probe: () => Promise<T | undefined> | T | undefined,
  diagnostics: () => string,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what}: ${String(last)}\n${diagnostics()}`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

beforeAll(async () => {
  await execFileAsync(process.execPath, ['esbuild.config.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, STATION_BUILD_SERVER_DIR: buildDir },
    timeout: BUILD_TIMEOUT_MS,
  });
  expect(existsSync(SUPERVISOR)).toBe(true);
  expect(existsSync(CORE)).toBe(true);
}, BUILD_TIMEOUT_MS + 10_000);

afterEach(async () => {
  await Promise.all([...children].map((child) => stop(child)));
  children.clear();
});

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

describe('a parked core generation', () => {
  it(
    'touches nothing in the home, temp root, or engine registry until promoted, then boots into them',
    async () => {
      const root = makeHomeRoot();
      const home = join(root, 'home');
      // Boot sweeps two places outside the home. Give each something the
      // sweep removes, so the test sees whether it ran.
      const tempRoot = join(root, 'temp-root');
      const staleTemp = join(tempRoot, 'stale-entry');
      mkdirSync(staleTemp, { recursive: true });
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
      utimesSync(staleTemp, twoDaysAgo, twoDaysAgo);
      const registry = join(root, 'owned-processes');
      mkdirSync(registry, { mode: 0o700 });
      const gonePid = spawnSync(process.execPath, ['-e', ''], {
        windowsHide: true,
      }).pid;
      const staleRecord = join(registry, 'engine-journey.json');
      // The engine registry is trusted only at mode 0700, which Windows
      // cannot report (every directory reads 0o666), so the orphan sweep
      // never reads it there: a pre-existing gap. Watch it on POSIX only.
      const watchRegistry = process.platform !== 'win32';
      // Owner gone and no engine birth recorded: the sweep drops the record
      // without signalling anything.
      writeFileSync(
        staleRecord,
        JSON.stringify({
          schemaVersion: 1,
          enginePid: gonePid,
          engineBirth: null,
          owner: {
            pid: gonePid,
            instanceId: 'journey',
            bootId: 'journey',
            birth: null,
          },
          command: 'journey',
          spawnedAt: new Date().toISOString(),
        }),
      );
      const core = fork(CORE, [], {
        env: isolatedEnv(home, {
          STATION_SUPERVISOR_IPC: '1',
          STATION_SUPERVISOR_GENERATION: '1',
          // Telemetry writes the home at import when an endpoint is set.
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
          STATION_TEMP_ROOT: tempRoot,
          STATION_OWNED_PROCESS_REGISTRY: registry,
        }),
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'json',
        windowsHide: true,
      });
      children.add(core);
      const output = capture(core);
      const messages: Array<{ type: string }> = [];
      core.on('message', (message: { type: string }) => messages.push(message));

      await waitFor(
        'parked',
        BOOT_TIMEOUT_MS,
        () => (messages.some((m) => m.type === 'parked') ? true : undefined),
        output,
      );
      // Give any import-time or deferred work time to reach the disk.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
      expect(existsSync(home)).toBe(false);
      expect(readdirSync(root).sort()).toEqual([
        'owned-processes',
        'temp-root',
      ]);
      expect(existsSync(staleTemp)).toBe(true);
      if (watchRegistry) expect(existsSync(staleRecord)).toBe(true);

      // Positive control: the same observation sees the home once promoted.
      core.send({ type: 'promote', listeners: [] });
      await waitFor(
        'the schema marker after promote',
        BOOT_TIMEOUT_MS,
        () =>
          existsSync(join(home, '.station-home-schema.json'))
            ? true
            : undefined,
        output,
      );
      await waitFor(
        'the boot sweeps after promote',
        BOOT_TIMEOUT_MS,
        () =>
          !existsSync(staleTemp) && (!watchRegistry || !existsSync(staleRecord))
            ? true
            : undefined,
        output,
      );

      // Losing the supervisor's channel ends the generation.
      core.disconnect();
      await waitFor(
        'the generation to exit after its IPC channel closed',
        BOOT_TIMEOUT_MS,
        () =>
          core.exitCode !== null || core.signalCode !== null ? true : undefined,
        output,
      );
    },
    // Above the sum of its three bounded waits, so a stuck one names itself.
    BOOT_TIMEOUT_MS * 4,
  );
});

interface PollStats {
  ok: number;
  okAfterHandoff: number;
  errors: Record<string, number>;
  statuses: Record<string, number>;
  /** Requests whose headers were sent slowly, over TRICKLE_MS. */
  trickled: number;
}

const TRICKLE_MS = 2_500;
const TRICKLE_LINES = 10;

/**
 * One request whose headers arrive a line at a time over TRICKLE_MS, as a
 * slow client sends them. Resolves with its status line, or rejects.
 */
function trickledRequest(port: number): Promise<string> {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(port, '127.0.0.1');
    let reply = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    socket.setEncoding('utf8');
    socket.setTimeout(REQUEST_TIMEOUT_MS, () =>
      socket.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })),
    );
    socket.on('data', (chunk: string) => {
      reply += chunk;
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolveRequest(reply.split('\r\n')[0] ?? '');
    });
    const lines = [
      'GET /api/system/liveness HTTP/1.1',
      'Host: 127.0.0.1',
      ...Array.from({ length: TRICKLE_LINES - 3 }, (_, i) => `X-Slow-${i}: 1`),
      'Connection: close',
    ];
    let index = 0;
    const next = () => {
      const line = lines[index];
      index += 1;
      if (line === undefined) {
        socket.write('\r\n');
        return;
      }
      socket.write(`${line}\r\n`);
      timer = setTimeout(next, TRICKLE_MS / TRICKLE_LINES);
    };
    socket.once('connect', next);
  });
}

/**
 * A tight poller on the API: keep-alive loops reuse connections the way a
 * browser pool does, and fresh-connection loops open one per request so some
 * land in the backlog while no generation accepts.
 */
function startPoller(port: number) {
  const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const stats: PollStats = {
    ok: 0,
    okAfterHandoff: 0,
    errors: {},
    statuses: {},
    trickled: 0,
  };
  let running = true;
  let handedOff = false;
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
            if (res.statusCode === 200) {
              stats.ok += 1;
              if (handedOff) stats.okAfterHandoff += 1;
            }
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
  const loops = [
    ...Array.from({ length: 4 }, () => keepAlive),
    false as const,
    false as const,
  ].map(async (agent) => {
    while (running) await request(agent);
  });
  // A new slow-header request every 500ms, so some are always partway
  // through their headers whenever the drain begins.
  const trickles: Promise<void>[] = [];
  const launcher = setInterval(() => {
    trickles.push(
      trickledRequest(port).then(
        (status) => {
          if (status === 'HTTP/1.1 200 OK') stats.trickled += 1;
          else count(stats.errors, `trickled:${status || 'no-response'}`);
        },
        (error: NodeJS.ErrnoException) =>
          count(stats.errors, `trickled:${error.code ?? error.message}`),
      ),
    );
  }, 500);
  return {
    stats,
    markHandedOff() {
      handedOff = true;
    },
    async stop() {
      running = false;
      clearInterval(launcher);
      await Promise.all([...loops, ...trickles]);
      keepAlive.destroy();
      return stats;
    },
  };
}

function healthClose(port: number): Promise<{ code: number; reason: string }> {
  return new Promise((resolveClose, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/__station/health`);
    socket.once('close', (code, reason) =>
      resolveClose({ code, reason: reason.toString('utf8') }),
    );
    socket.once('error', reject);
  });
}

function plainGet(
  port: number,
  path = '/',
): Promise<{ status: number; body: string; type: string | undefined }> {
  return new Promise((resolveGet, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () =>
          resolveGet({
            status: res.statusCode ?? 0,
            body,
            type: res.headers['content-type'],
          }),
        );
      },
    );
    req.on('error', reject);
  });
}

describe('a supervised core handoff', () => {
  it(
    'hands every listener to a new generation with no refused or reset connection',
    async () => {
      const root = makeHomeRoot();
      const home = join(root, 'home');
      const supervisor = spawn(
        process.execPath,
        [
          SUPERVISOR,
          '--entry',
          CORE,
          '--home',
          home,
          '--instance',
          INSTANCE,
          // A generation is stable after this; only a stable generation's
          // clean drained exit restarts without a failure strike.
          '--restart-stable-ms',
          String(STABLE_AFTER_MS),
        ],
        {
          env: isolatedEnv(home),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      children.add(supervisor);
      const output = capture(supervisor);
      const endpoint = resolveControlEndpoint({ home, instance: INSTANCE });
      let connection: ControlConnection | null = null;
      let nextId = 1;
      const status = async (): Promise<SupervisorStatus> => {
        connection ??= await connectControl(endpoint.path, endpoint.tokenPath);
        const reply = await connection.request(
          { type: 'status', id: `s${nextId++}` },
          ['status.result'],
        );
        if (reply.type !== 'status.result')
          throw new Error(JSON.stringify(reply));
        return reply.status;
      };
      try {
        const first = await waitFor(
          'generation 1 serving all four listeners',
          BOOT_TIMEOUT_MS,
          async () => {
            if (supervisor.exitCode !== null)
              throw new Error('supervisor exited');
            if (!existsSync(endpoint.tokenPath)) return undefined;
            const current = await status();
            return current.state === 'serving' &&
              current.active?.state === 'serving' &&
              current.listeners.length === 4
              ? current
              : undefined;
          },
          output,
        );
        const port = first.active?.port as number;
        const pid1 = first.active?.pid as number;
        const bootId1 = first.active?.bootId;
        expect(
          Object.fromEntries(first.listeners.map((l) => [l.name, l.port])),
        ).toEqual({
          api: port,
          terminal: port + 1,
          voice: port + 2,
          consent: port + 3,
        });

        const poller = startPoller(port);
        await waitFor(
          'the poller to be served',
          BOOT_TIMEOUT_MS,
          () => (poller.stats.ok >= 20 ? true : undefined),
          output,
        );
        const handoff = await connection!.request(
          { type: 'handoff', id: `h${nextId++}` },
          ['handoff.result'],
        );
        poller.markHandedOff();
        if ((handoff as { outcome?: string }).outcome !== 'committed') {
          await poller.stop();
        }
        expect(handoff, output()).toMatchObject({
          type: 'handoff.result',
          outcome: 'committed',
          generation: 2,
        });
        await waitFor(
          'requests served after the handoff',
          BOOT_TIMEOUT_MS,
          () => (poller.stats.okAfterHandoff >= 20 ? true : undefined),
          output,
        );
        const stats = await poller.stop();
        if (process.platform === 'win32') {
          // Catching narrows Windows' reset window but cannot close it: a
          // connection completed into a pending accept in the instant a
          // listener closes is still reset (38 of 39 journeys on a Windows
          // host were clean, the other reset one connection). Allow that one;
          // every other error stays zero, and the line below proves catching
          // ran, which is what a revert would remove.
          const { ECONNRESET: resets = 0, ...others } = stats.errors;
          expect(others, output()).toEqual({});
          expect(resets, output()).toBeLessThanOrEqual(1);
        } else {
          expect(stats.errors, output()).toEqual({});
        }
        // On Windows the handoff rests on the supervisor catching connections
        // while generation 1 drains (process supervisor design, Windows): all
        // four listeners, eight spares each.
        if (process.platform === 'win32') {
          expect(output()).toContain(
            'catching connections on 32 spare listener(s) while generation 1 drains',
          );
        }
        // Slow-header requests were in flight across the drain and finished.
        expect(stats.trickled).toBeGreaterThanOrEqual(10);
        expect(Object.keys(stats.statuses)).toEqual(['200']);

        const second = await status();
        expect(second.active).toMatchObject({
          generation: 2,
          state: 'serving',
          port,
        });
        expect(second.active?.pid).not.toBe(pid1);
        expect(second.active?.bootId).not.toBe(bootId1);
        expect(second.listeners).toEqual(first.listeners);
        expect(processAlive(pid1)).toBe(false);
        expect(processAlive(second.active?.pid as number)).toBe(true);

        // Generation 1 is gone, so whatever answers now is generation 2.
        await expect(healthClose(port + 1)).resolves.toEqual({
          code: 1000,
          reason: 'healthy',
        });
        await expect(healthClose(port + 2)).resolves.toEqual({
          code: 1000,
          reason: 'healthy',
        });
        // Non-upgrade requests get exactly what ws sends from a port it owns.
        await expect(plainGet(port + 1)).resolves.toEqual({
          status: 426,
          body: 'Upgrade Required',
          type: 'text/plain',
        });
        const consent = await plainGet(port + 3);
        expect(consent.status).toBe(404);
        expect(consent.type).toMatch(/text\/html/);

        // An operator's SIGTERM straight to the serving core. POSIX only:
        // on Windows process.kill(pid, 'SIGTERM') terminates the process
        // outright, so the core never runs its SIGTERM drain.
        if (process.platform !== 'win32') {
          // It drains as for a handoff, so no client is reset, and the
          // supervisor restarts it without counting a failure.
          const pid2 = second.active?.pid as number;
          // Let generation 2 become stable, as a long-running core would be.
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, STABLE_AFTER_MS + 500),
          );
          const signalled = startPoller(port);
          await waitFor(
            'the poller to be served before SIGTERM',
            BOOT_TIMEOUT_MS,
            () => (signalled.stats.ok >= 20 ? true : undefined),
            output,
          );
          process.kill(pid2, 'SIGTERM');
          signalled.markHandedOff();
          const third = await waitFor(
            'generation 3 serving after SIGTERM',
            BOOT_TIMEOUT_MS,
            async () => {
              const current = await status();
              return current.active?.generation === 3 &&
                current.active.state === 'serving'
                ? current
                : undefined;
            },
            output,
          );
          await waitFor(
            'requests served after the restart',
            BOOT_TIMEOUT_MS,
            () => (signalled.stats.okAfterHandoff >= 20 ? true : undefined),
            output,
          );
          const signalledStats = await signalled.stop();
          expect(signalledStats.errors, output()).toEqual({});
          expect(processAlive(pid2)).toBe(false);
          expect(third.active?.port).toBe(port);
          expect(third.restarts.consecutiveFailures).toBe(0);
          // The clean-exit path itself, not a crash restart whose strike a
          // later stable period reset to 0.
          expect(output()).toContain(
            'drained and exited on its own; restarting it',
          );
          expect(output()).not.toMatch(/restarting in \d+ms \(failure/);
        }
      } finally {
        (connection as ControlConnection | null)?.close();
      }

      // Stopping the supervisor drains the serving generation (3 after the
      // SIGTERM phase, 2 on Windows) and exits cleanly. Windows has no
      // SIGTERM to catch (kill ends the process outright), so there the stop
      // comes over the control channel, as the CLI and tray send it.
      const exited = exitOf(supervisor);
      if (process.platform === 'win32') {
        const stopper = await connectControl(endpoint.path, endpoint.tokenPath);
        try {
          const reply = await stopper.request({ type: 'stop', id: 'stop' }, [
            'stop.result',
          ]);
          expect(reply).toMatchObject({ type: 'stop.result', accepted: true });
        } finally {
          stopper.close();
        }
      } else {
        supervisor.kill('SIGTERM');
      }
      await expect(exited).resolves.toBe(0);
    },
    BOOT_TIMEOUT_MS * 4,
  );
});

// The supervisor from source, with its fixture core, beside a real home.

const SUPERVISOR_MAIN = join(repoRoot, 'packages/supervisor/src/main.ts');
const FAKE_CORE = join(
  repoRoot,
  'packages/supervisor/src/__tests__/__fixtures__/fake-core.mjs',
);
const SOURCE_INSTANCE = 'home';
const SERVING_TIMEOUT_MS = scaleLivenessMs(30_000);
/** Longer than the supervisor's 5-second lock and socket self-check. */
const SELF_CHECK_WAIT_MS = 6_500;

const sourceChildren: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(
    sourceChildren.splice(0).map(
      (child) =>
        new Promise<void>((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolveExit();
          const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
          child.once('exit', () => {
            clearTimeout(killer);
            resolveExit();
          });
          child.kill('SIGTERM');
        }),
    ),
  );
});

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  );
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (typeof address !== 'object' || !address) throw new Error('no port');
  return address.port;
}

async function startSourceSupervisor(home: string) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('STATION_')) env[key] = value;
  }
  const child = spawn(
    process.execPath,
    [
      SUPERVISOR_MAIN,
      '--entry',
      FAKE_CORE,
      '--home',
      home,
      '--instance',
      SOURCE_INSTANCE,
    ],
    {
      env: { ...env, FAKE_CORE_PORT: String(await freeLoopbackPort()) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  sourceChildren.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const endpoint = resolveControlEndpoint({ home, instance: SOURCE_INSTANCE });
  const status = async (): Promise<SupervisorStatus> => {
    const connection = await connectControl(endpoint.path, endpoint.tokenPath);
    try {
      const reply = await connection.request({ type: 'status', id: 's' }, [
        'status.result',
      ]);
      if (reply.type !== 'status.result')
        throw new Error(JSON.stringify(reply));
      return reply.status;
    } finally {
      connection.close();
    }
  };
  const deadline = Date.now() + SERVING_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`supervisor exited early:\n${output}`);
    }
    try {
      if ((await status()).state === 'serving') break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`supervisor never served:\n${output}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return { child, endpoint, status, output: () => output };
}

function makeSourceRoot(): string {
  // Short, so the control socket path fits beside the home on macOS.
  return makeShortTempDir('svh-');
}

describe('the supervisor beside a Station home', () => {
  it(
    'leaves a fresh home untouched, so the schema gate admits it as fresh',
    async () => {
      const home = join(makeSourceRoot(), 'home');
      const supervisor = await startSourceSupervisor(home);
      expect(existsSync(home)).toBe(false);
      expect(stationHomeSchemaNeedsReset(home)).toBe(false);
      ensureStationHomeSchemaSync(home);
      // Pinned beside the derivation it guards.
      expect(STATION_HOME_SCHEMA_VERSION).toBe(2);
      expect(readStationHomeSchemaVersion(home)).toBe(
        STATION_HOME_SCHEMA_VERSION,
      );
      expect((await supervisor.status()).state).toBe('serving');
    },
    SERVING_TIMEOUT_MS * 2,
  );

  it(
    'keeps its control socket, token, and lock through a home schema migration',
    async () => {
      const home = join(makeSourceRoot(), 'home');
      const supervisor = await startSourceSupervisor(home);
      ensureStationHomeSchemaSync(home);
      writeFileSync(join(home, 'data.json'), '{}');
      const runDir = dirname(supervisor.endpoint.tokenPath);
      const token = readFileSync(supervisor.endpoint.tokenPath, 'utf8');
      const locks = readdirSync(runDir).filter((name) =>
        name.startsWith(`instance-${SOURCE_INSTANCE}.lock.`),
      );
      expect(locks.length).toBeGreaterThan(0);

      // A real migration through the gate: copy aside, migrate, replace.
      ensureStationHomeSchemaSync(home, {
        targetVersion: STATION_HOME_SCHEMA_VERSION + 1,
        migrations: [
          {
            fromVersion: STATION_HOME_SCHEMA_VERSION,
            migrate: (staged) => writeFileSync(join(staged, 'migrated'), '1'),
          },
        ],
      });
      expect(readStationHomeSchemaVersion(home)).toBe(
        STATION_HOME_SCHEMA_VERSION + 1,
      );
      expect(existsSync(join(home, 'migrated'))).toBe(true);
      expect(existsSync(join(home, 'data.json'))).toBe(true);

      const pid = supervisor.child.pid;
      expect(await supervisor.status()).toMatchObject({
        state: 'serving',
        supervisor: { pid },
      });
      expect(readFileSync(supervisor.endpoint.tokenPath, 'utf8')).toBe(token);
      for (const lock of locks)
        expect(existsSync(join(runDir, lock))).toBe(true);
      // Past a self-check: it still holds its lock and socket, and serves.
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, SELF_CHECK_WAIT_MS),
      );
      expect(supervisor.child.exitCode).toBeNull();
      expect((await supervisor.status()).state).toBe('serving');
      expect(supervisor.output()).not.toMatch(/re-binding|superseded/);
    },
    SERVING_TIMEOUT_MS * 2 + SELF_CHECK_WAIT_MS,
  );
});
