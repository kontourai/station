// @vitest-environment node
/**
 * Journeys over real processes: the built supervisor bundle runs the built
 * core server bundle against an isolated Station home on loopback ports.
 *
 * - A parked generation leaves the home untouched until it is promoted.
 * - A handoff from generation 1 to 2 under continuous HTTP load refuses and
 *   resets nothing, keeps every port, and leaves the terminal, voice, and
 *   consent listeners served by the new generation.
 */
import { type ChildProcess, execFile, fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import http from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  type ControlServerMessage,
  resolveControlEndpoint,
  SUPERVISOR_PROTOCOL,
  type SupervisorStatus,
} from '@kontourai/station-supervisor/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { scaleLivenessMs } from '../../../../scripts/lib/liveness-scale.mjs';

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

const execFileAsync = promisify(execFile);
const homes: string[] = [];
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
    ...extra,
  };
}

function makeHomeRoot(): string {
  // Short, so the control socket path fits inside the home on macOS.
  const root = mkdtempSync(join(tmpdir(), 'svj-'));
  homes.push(root);
  return root;
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

/**
 * A minimal control-channel client. The package's own client is not imported:
 * its sources use `.ts` import specifiers that this tsconfig does not accept,
 * while the `/protocol` subpath (types and constants) has none.
 */
interface ControlConnection {
  request(
    message: { type: string; id: string },
    until: string[],
  ): Promise<ControlServerMessage>;
  close(): void;
}

function connectControl(
  path: string,
  tokenPath: string,
): Promise<ControlConnection> {
  return new Promise((resolveConnection, reject) => {
    const socket = createConnection(path);
    const waiters = new Set<(message: ControlServerMessage) => void>();
    let buffer = '';
    let welcomed = false;
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (
        let newline = buffer.indexOf('\n');
        newline >= 0;
        newline = buffer.indexOf('\n')
      ) {
        const message = JSON.parse(
          buffer.slice(0, newline),
        ) as ControlServerMessage;
        buffer = buffer.slice(newline + 1);
        if (!welcomed) {
          if (message.type !== 'welcome') {
            reject(new Error(`control refused: ${JSON.stringify(message)}`));
            socket.destroy();
            return;
          }
          welcomed = true;
          resolveConnection({
            request: (request, until) =>
              new Promise((resolveReply) => {
                const waiter = (reply: ControlServerMessage) => {
                  if ((reply as { id?: string }).id !== request.id) return;
                  if (!until.includes(reply.type) && reply.type !== 'error')
                    return;
                  waiters.delete(waiter);
                  resolveReply(reply);
                };
                waiters.add(waiter);
                socket.write(`${JSON.stringify(request)}\n`);
              }),
            close: () => socket.end(),
          });
          continue;
        }
        for (const waiter of [...waiters]) waiter(message);
      }
    });
    socket.write(
      `${JSON.stringify({
        type: 'hello',
        protocol: { ...SUPERVISOR_PROTOCOL },
        token: readFileSync(tokenPath, 'utf8').trim(),
        client: { kind: 'test', version: '0.0.0' },
        capabilities: [],
      })}\n`,
    );
  });
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
  for (const root of homes.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('a parked core generation', () => {
  it(
    'touches nothing in the home until promoted, then boots into it',
    async () => {
      const root = makeHomeRoot();
      const home = join(root, 'home');
      const core = fork(CORE, [], {
        env: isolatedEnv(home, {
          STATION_SUPERVISOR_IPC: '1',
          STATION_SUPERVISOR_GENERATION: '1',
          // Telemetry writes the home at import when an endpoint is set.
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
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
      expect(readdirSync(root)).toEqual([]);

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

      // Losing the supervisor's channel ends the generation.
      const exited = exitOf(core);
      core.disconnect();
      await expect(exited).resolves.not.toBeUndefined();
      expect(core.exitCode ?? core.signalCode).not.toBeNull();
    },
    BOOT_TIMEOUT_MS * 2,
  );
});

interface PollStats {
  ok: number;
  okAfterHandoff: number;
  errors: Record<string, number>;
  statuses: Record<string, number>;
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
  return {
    stats,
    markHandedOff() {
      handedOff = true;
    },
    async stop() {
      running = false;
      await Promise.all(loops);
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
        [SUPERVISOR, '--entry', CORE, '--home', home, '--instance', INSTANCE],
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
        await waitFor(
          'requests served after the handoff',
          BOOT_TIMEOUT_MS,
          () => (poller.stats.okAfterHandoff >= 20 ? true : undefined),
          output,
        );
        const stats = await poller.stop();
        expect(handoff, output()).toMatchObject({
          type: 'handoff.result',
          outcome: 'committed',
          generation: 2,
        });
        expect(stats.errors, output()).toEqual({});
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
      } finally {
        (connection as ControlConnection | null)?.close();
      }

      // Stopping the supervisor drains generation 2 and exits cleanly.
      const exited = exitOf(supervisor);
      supervisor.kill('SIGTERM');
      await expect(exited).resolves.toBe(0);
    },
    BOOT_TIMEOUT_MS * 4,
  );
});
