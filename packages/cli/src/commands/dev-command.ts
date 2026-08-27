/**
 * `station dev` — launch a bleeding-edge dev instance from any git worktree on
 * a deterministic, stable, non-colliding port pair + isolated home, so it
 * coexists with the stable dogfood (reserved on 3141/3000) and a shared URL
 * stays valid across restarts.
 *
 * This is a thin orchestrator: it resolves the worktree, derives the offset +
 * ports + instance + home via the pure helpers in `./dev-ports.ts`, then runs
 * the SAME start path as `station start` (it does not fork the start logic).
 */

import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import {
  allocateDevPorts,
  deriveDevInstanceAndHome,
  type IsPortFree,
  resolveDevOffset,
  resolveWorktreePath,
} from './dev-ports.js';
import { clean, start } from './lifecycle.js';

/** Hosts a dev server binds to; a genuinely-taken port shows up on one of them. */
const DEV_PORT_PROBE_HOSTS = ['127.0.0.1', '::1'] as const;

/**
 * Dev homes contain credentials and are the immediate parent of the instance
 * registry. Create or repair only owner-owned, non-symlink directories so the
 * registry's own fail-closed permission check can publish the instance.
 */
export function ensurePrivateDevHome(home: string): void {
  const secureDirectory = (directory: string, label: string) => {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${label} must be a real directory: ${directory}`);
    }
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      info.uid !== process.getuid()
    ) {
      throw new Error(
        `${label} must be owned by the current user: ${directory}`,
      );
    }
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      chmodSync(directory, 0o700);
      const repaired = lstatSync(directory);
      if (
        !repaired.isDirectory() ||
        repaired.isSymbolicLink() ||
        (typeof process.getuid === 'function' &&
          repaired.uid !== process.getuid()) ||
        (repaired.mode & 0o077) !== 0
      ) {
        throw new Error(`${label} could not be made owner-only: ${directory}`);
      }
    }
  };

  const parent = dirname(home);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  secureDirectory(parent, 'Station dev-home parent');
  try {
    mkdirSync(home, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  secureDirectory(home, 'Station dev home');
}

function probePortFreeOnHost(port: number, host: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      // A port genuinely in use is EADDRINUSE; a privileged bind is EACCES.
      // Any other error (e.g. ::1 not available on this host) means this
      // interface cannot decide occupancy, so it must not veto an otherwise
      // free port — probing wildcards that way is what made t3code's runner
      // walk away from free ports.
      const code = error.code;
      resolvePromise(code !== 'EADDRINUSE' && code !== 'EACCES');
    });
    server.once('listening', () => {
      server.close(() => resolvePromise(true));
    });
    server.listen(port, host);
  });
}

const probeDevPortFree: IsPortFree = async (port) => {
  for (const host of DEV_PORT_PROBE_HOSTS) {
    if (!(await probePortFreeOnHost(port, host))) return false;
  }
  return true;
};

export interface DevCommandDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Injectable port-availability predicate (tests). */
  isPortFree?: IsPortFree;
  /** Injectable worktree resolver (tests). */
  resolveWorktreePath?: (cwd: string) => string | undefined;
  /** Injectable start implementation (tests). */
  startImpl?: typeof start;
  /** Injectable clean implementation (tests). */
  cleanImpl?: typeof clean;
  /** Directory creation, overridable for tests. */
  ensureDir?: (dir: string) => void;
  log?: (message: string) => void;
}

function parseEnvOffset(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `STATION_PORT_OFFSET must be a non-negative integer; received ${JSON.stringify(raw)}.`,
    );
  }
  return Number(trimmed);
}

/**
 * Parse `station dev` flags, resolve the deterministic ports + isolated home,
 * and hand off to the shared `start` path. Returns without starting when
 * `--dry-run` is given.
 */
export async function runDevCommand(
  argv: string[],
  deps: DevCommandDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? ((message: string) => console.log(message));
  const startImpl = deps.startImpl ?? start;
  const cleanImpl = deps.cleanImpl ?? clean;
  const isPortFree = deps.isPortFree ?? probeDevPortFree;
  const resolveWorktree = deps.resolveWorktreePath ?? resolveWorktreePath;
  const ensureDir = deps.ensureDir ?? ensurePrivateDevHome;

  let portOffsetFlag: number | undefined;
  let host: string | undefined;
  let features: string | undefined;
  let dryRun = false;
  let build = false;
  let cleanHome = false;
  let force = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      // Answered by the dispatcher before this runs; ignore if it slips through.
      continue;
    }
    if (arg.startsWith('--port-offset=')) {
      const value = arg.slice('--port-offset='.length);
      if (!/^\d+$/.test(value)) {
        throw new Error(
          `--port-offset must be a non-negative integer; received ${JSON.stringify(value)}.`,
        );
      }
      portOffsetFlag = Number(value);
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg.startsWith('--features=')) {
      features = arg.slice('--features='.length);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--build') {
      build = true;
    } else if (arg === '--clean') {
      cleanHome = true;
    } else if (arg === '--force') {
      force = true;
    } else {
      throw new Error(
        `Unknown station dev option: ${arg}. Run \`station dev --help\`.`,
      );
    }
  }

  const portOffset = portOffsetFlag ?? parseEnvOffset(env.STATION_PORT_OFFSET);
  const devInstance = env.STATION_DEV_INSTANCE;
  const worktreePath = resolveWorktree(cwd);

  const { offset, source } = resolveDevOffset({
    portOffset,
    devInstance,
    worktreePath,
  });
  const allocation = await allocateDevPorts(offset, isPortFree);
  const { instance, home } = deriveDevInstanceAndHome({
    worktreePath,
    devInstance,
    cwd,
    stationRoot: env.STATION_ROOT,
  });

  const bindHost = host ?? '0.0.0.0';

  log(
    [
      'station dev — deterministic per-worktree instance',
      `  worktree:  ${worktreePath ?? '(none — using cwd basename)'}`,
      `  instance:  ${instance}`,
      `  home:      ${home}`,
      `  offset:    ${allocation.offset} (from ${source}${allocation.moved ? `; moved from ${offset} to avoid a busy port` : ''})`,
      `  server:    http://${bindHost}:${allocation.serverPort}`,
      `  ui:        http://${bindHost}:${allocation.uiPort}`,
      `  stop:      station stop --instance=${instance}`,
    ].join('\n'),
  );

  if (dryRun) return;

  ensureDir(home);

  if (cleanHome) {
    await cleanImpl({
      actionLabel: 'dev --clean',
      force,
      homeSource: '--base',
      instanceName: instance,
      projectHome: home,
      serverPort: allocation.serverPort,
      uiPort: allocation.uiPort,
    });
  }

  await startImpl({
    serverPort: allocation.serverPort,
    uiPort: allocation.uiPort,
    instanceName: instance,
    baseDir: home,
    homeSource: '--base',
    build,
    force,
    ...(features ? { features } : {}),
    // start() defaults an unset host to 0.0.0.0; pass it through only when the
    // user overrode it so the default stays owned by one place.
    ...(host ? { host } : {}),
  });
}
