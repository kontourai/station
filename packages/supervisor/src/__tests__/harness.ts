/**
 * Real-process helpers for supervisor tests: an isolated home, a supervisor
 * child running the fixture core, an HTTP load client, and an SSE client.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { type ControlConnection, connectControl } from '../control-client.ts';
import {
  type ControlEndpoint,
  resolveControlEndpoint,
  type SupervisorStatus,
  supervisorRunDir,
} from '../protocol.ts';

export const SUPERVISOR_MAIN = fileURLToPath(
  new URL('../main.ts', import.meta.url),
);
export const FAKE_CORE = fileURLToPath(
  new URL('./__fixtures__/fake-core.mjs', import.meta.url),
);

/** Ports owned by the user's own Station instances. Tests must never touch them. */
const RESERVED_PORTS = new Set([3000, 3141, 3142, 3143, 3144]);

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== 'object' || !address) throw new Error('no port');
  if (RESERVED_PORTS.has(address.port) || address.port < 10_000)
    return freePort();
  return address.port;
}

/** Writes an entry that sets fixture flags and then runs the fixture core. */
export function writeCoreVariant(
  dir: string,
  name: string,
  env: Record<string, string>,
): string {
  const path = join(dir, `${name}.mjs`);
  const assignments = Object.entries(env)
    .map(
      ([key, value]) =>
        `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`,
    )
    .join('\n');
  // A file URL: on Windows an absolute path is not a valid import specifier.
  const target = JSON.stringify(pathToFileURL(FAKE_CORE).href);
  writeFileSync(path, `${assignments}\nawait import(${target});\n`);
  return path;
}

export interface RunningSupervisor {
  child: ChildProcess;
  endpoint: ControlEndpoint;
  port: number;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  connect(capabilities?: string[]): Promise<ControlConnection>;
  status(): Promise<SupervisorStatus>;
  handoff(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Homes short enough for the in-home socket path. The vitest temp root is too
 * deep for a 104-byte sun_path, so these live in the ambient temp directory.
 * Created before the teardown hook below, so they are removed after it.
 */
export const makeShortHome = (() => {
  const make = trackTempDirs({
    base: process.env.STATION_VITEST_HOST_TMPDIR ?? tmpdir(),
  });
  // A child of the tracked directory, so the run directory beside the home
  // is removed with it.
  return () => {
    const home = join(make('sv-'), 'h');
    mkdirSync(home, { mode: 0o700 });
    return home;
  };
})();

/**
 * Homes whose sibling run directory a test created: the run directory lives
 * beside the home, outside any temp directory that holds the home itself.
 */
const trackedHomes = new Set<string>();
export function trackHome(home: string): string {
  trackedHomes.add(home);
  return home;
}

const running = new Map<ChildProcess, ControlEndpoint>();

/**
 * Stops every supervisor a test started: SIGTERM first so it removes its
 * socket and token, then SIGKILL. A fallback socket outside the home is
 * removed here if the supervisor could not do it.
 */
afterEach(async () => {
  const children = [...running];
  running.clear();
  try {
    await Promise.all(
      children.map(
        ([child, endpoint]) =>
          new Promise<void>((resolve) => {
            const cleanup = () => {
              if (endpoint.fallbackDir) rmSync(endpoint.path, { force: true });
              resolve();
            };
            if (child.exitCode !== null || child.signalCode !== null)
              return cleanup();
            const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
            child.once('exit', () => {
              clearTimeout(killer);
              cleanup();
            });
            child.kill('SIGTERM');
          }),
      ),
    );
  } finally {
    for (const home of trackedHomes) {
      rmSync(supervisorRunDir(home), { recursive: true, force: true });
    }
    trackedHomes.clear();
  }
});

const OUTPUT_LIMIT = 256 * 1024;

export async function startSupervisor(options: {
  home: string;
  entry?: string;
  instance?: string;
  port?: number;
  env?: Record<string, string>;
  args?: string[];
  /** Use this script instead of the source entry, for example a built bundle. */
  main?: string;
  /** Node flags for the supervisor process itself, for example `--import`. */
  nodeArgs?: string[];
  /** A `--control` socket path; the harness then connects there. */
  control?: string;
  waitForServing?: boolean;
}): Promise<RunningSupervisor> {
  trackHome(options.home);
  const instance = options.instance ?? 'test';
  const port = options.port ?? (await freePort());
  const derived = resolveControlEndpoint({ home: options.home, instance });
  const endpoint = options.control
    ? { ...derived, path: options.control, fallbackDir: null }
    : derived;
  const child = spawn(
    process.execPath,
    [
      ...(options.nodeArgs ?? []),
      options.main ?? SUPERVISOR_MAIN,
      '--entry',
      options.entry ?? FAKE_CORE,
      '--home',
      options.home,
      '--instance',
      instance,
      ...(options.control ? ['--control', options.control] : []),
      ...(options.args ?? []),
    ],
    {
      env: { ...process.env, FAKE_CORE_PORT: String(port), ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  running.set(child, endpoint);
  let output = '';
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  let processGone = false;
  void exited.then(() => {
    processGone = true;
  });

  const connect = (capabilities: string[] = []) =>
    connectControl({
      path: endpoint.path,
      tokenPath: endpoint.tokenPath,
      capabilities,
    });
  let nextId = 1;
  const status = async () => {
    const connection = await connect();
    try {
      const reply = await connection.request(
        { type: 'status', id: `s${nextId++}` },
        ['status.result'],
      );
      if (reply.type !== 'status.result')
        throw new Error(`unexpected reply ${JSON.stringify(reply)}`);
      return reply.status;
    } finally {
      connection.close();
    }
  };
  const handoff = async (handoffOptions: Record<string, unknown> = {}) => {
    const connection = await connect();
    try {
      const reply = await connection.request(
        { type: 'handoff', id: `h${nextId++}`, ...handoffOptions },
        ['handoff.result'],
      );
      return reply as unknown as Record<string, unknown>;
    } finally {
      connection.close();
    }
  };

  const supervisor: RunningSupervisor = {
    child,
    endpoint,
    port,
    output: () => output,
    exited,
    connect,
    status,
    handoff,
  };
  if (options.waitForServing !== false) {
    await vi.waitFor(
      async () => {
        if (processGone) throw new Error(`supervisor exited early:\n${output}`);
        if (!existsSync(endpoint.tokenPath)) throw new Error('no token yet');
        const current = await status();
        if (current.state !== 'serving')
          throw new Error(`state ${current.state}`);
      },
      { timeout: 20_000, interval: 50 },
    );
  }
  return supervisor;
}

export interface LoadStats {
  ok: number;
  /** TCP connections opened; each one made after a drain began had to wait in the backlog. */
  connections: number;
  errors: Record<string, number>;
  bootIds: string[];
  statuses: Record<string, number>;
}

/**
 * Hammers `GET /boot` from `concurrency` loops over keep-alive connections,
 * the way a browser reuses its pool. Records every failure by code.
 */
export function startLoad(
  port: number,
  concurrency = 8,
): { stop(): Promise<LoadStats>; stats: LoadStats } {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const stats: LoadStats = {
    ok: 0,
    connections: 0,
    errors: {},
    bootIds: [],
    statuses: {},
  };
  const seen = new WeakSet<object>();
  let running = true;
  const request = () =>
    new Promise<void>((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/boot', agent, timeout: 30_000 },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => {
            stats.statuses[res.statusCode ?? 0] =
              (stats.statuses[res.statusCode ?? 0] ?? 0) + 1;
            try {
              const { bootId } = JSON.parse(body) as { bootId: string };
              stats.ok += 1;
              if (stats.bootIds.at(-1) !== bootId) stats.bootIds.push(bootId);
            } catch {
              stats.errors.BAD_BODY = (stats.errors.BAD_BODY ?? 0) + 1;
            }
            resolve();
          });
          res.on('error', (error: NodeJS.ErrnoException) => {
            stats.errors[error.code ?? error.message] =
              (stats.errors[error.code ?? error.message] ?? 0) + 1;
            resolve();
          });
        },
      );
      req.on('socket', (socket) => {
        if (seen.has(socket)) return;
        seen.add(socket);
        stats.connections += 1;
      });
      req.on('timeout', () =>
        req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })),
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        stats.errors[error.code ?? error.message] =
          (stats.errors[error.code ?? error.message] ?? 0) + 1;
        resolve();
      });
    });
  const loops = Array.from({ length: concurrency }, async () => {
    while (running) await request();
  });
  return {
    stats,
    async stop() {
      running = false;
      await Promise.all(loops);
      agent.destroy();
      return stats;
    },
  };
}

/** An SSE client that reconnects whenever its stream ends, recording each bootId it sees. */
export function startSse(port: number): {
  stop(): void;
  bootIds: string[];
  errors: string[];
} {
  const bootIds: string[] = [];
  const errors: string[] = [];
  let stopped = false;
  let current: http.ClientRequest | null = null;
  const connect = () => {
    if (stopped) return;
    let reconnected = false;
    const reconnect = () => {
      if (reconnected) return;
      reconnected = true;
      connect();
    };
    current = http.get(
      { host: '127.0.0.1', port, path: '/events', agent: false },
      (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const match = /data: (\{[^\n]*\})\n\n/.exec(buffer);
          if (match) {
            buffer = buffer.slice((match.index ?? 0) + match[0].length);
            const { bootId } = JSON.parse(match[1] ?? '{}') as {
              bootId: string;
            };
            if (bootIds.at(-1) !== bootId) bootIds.push(bootId);
          }
        });
        res.on('end', reconnect);
        res.on('error', (error: NodeJS.ErrnoException) => {
          if (stopped) return;
          errors.push(error.code ?? error.message);
          reconnect();
        });
      },
    );
    current.on('error', (error: NodeJS.ErrnoException) => {
      if (stopped) return;
      errors.push(error.code ?? error.message);
      reconnect();
    });
  };
  connect();
  return {
    bootIds,
    errors,
    stop() {
      stopped = true;
      current?.destroy();
    },
  };
}

export async function getBoot(
  port: number,
): Promise<{ bootId: string; generation: number; entry: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(
        {
          host: '127.0.0.1',
          port,
          path: '/boot',
          agent: false,
          timeout: 30_000,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => resolve(JSON.parse(body)));
        },
      )
      .on('error', reject);
  });
}
