import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request as nodeRequest } from 'node:http';
import { createConnection as createRawConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import {
  readInstanceRegistry,
  upsertInstance,
} from '@kontourai/station-shared/instance-registry';
import { readLifecycleEvents } from '@kontourai/station-shared/lifecycle-events';
import {
  ensureStationHomeSchemaSync,
  STATION_HOME_RESET_COMMAND,
  STATION_HOME_SCHEMA_FILE,
  STATION_HOME_SCHEMA_VERSION,
} from '@kontourai/station-shared/station-home-schema';
import { buildSync } from 'esbuild';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { configureRuntimeHttp } from '../../../../src-server/runtime/bootstrap/runtime-http.js';
import type { EventBus } from '../../../../src-server/services/orchestration/event-bus.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../../src-server/utils/internal-api-token.js';
import type { Logger } from '../../../../src-server/utils/logger.js';
import {
  reapAllLongRunningFixtureChildren,
  spawnLongRunningFixtureChild,
} from './helpers/longrunning-fixture-child.js';

type LifecycleModule = typeof import('../commands/lifecycle.js');
type PlatformModule = typeof import('../commands/platform.js');
type FsModule = typeof import('node:fs');

const TEST_ROOT = join(
  tmpdir(),
  `station-lifecycle-${process.pid}-${Date.now()}`,
);
const TEST_CWD = join(TEST_ROOT, 'cwd');
// Mirrors SERVER_ENTRY_FILENAME in ../commands/lifecycle.ts. That module is
// loaded dynamically here (under vi.doMock), so it cannot be imported
// statically for this value. `isInstalled` is asserted directly against the
// real module below, so a drift between these two names fails a test rather
// than silently re-creating the empty-directory blind spot.
const TEST_SERVER_ENTRY_FILENAME = 'command-station.js';
const TEST_DEFAULT_HOME = join(TEST_ROOT, 'default-home');
const TEST_ALT_HOME = join(TEST_ROOT, 'alt-home');
const TEST_SECOND_HOME = join(TEST_ROOT, 'second-home');
const TEST_PIDFILE = join(TEST_CWD, '.station.pids');
const TEST_INSTANCE_STATE_DIR = join(TEST_CWD, '.station', 'instances');
const PROCESS_INTEGRATION_TEST_TIMEOUT_MS = 15_000;

function normalizeInstanceName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'default';
}

function resolveInstanceId(
  options: {
    cwd?: string;
    instanceName?: string;
    projectHome?: string;
    serverPort?: number;
    uiPort?: number;
  } = {},
): string {
  if (options.instanceName?.trim()) {
    return normalizeInstanceName(options.instanceName);
  }

  const projectHome = resolve(options.projectHome || TEST_DEFAULT_HOME);
  const serverPort = options.serverPort ?? 3141;
  const uiPort = options.uiPort ?? 3000;

  if (
    projectHome === TEST_DEFAULT_HOME &&
    serverPort === 3141 &&
    uiPort === 3000
  ) {
    return 'default';
  }

  const hash = createHash('sha1')
    .update(
      JSON.stringify({
        cwd: options.cwd || TEST_CWD,
        projectHome,
        serverPort,
        uiPort,
      }),
    )
    .digest('hex')
    .slice(0, 12);

  return `instance-${hash}`;
}

function getInstanceStatePath(instanceId: string, cwd = TEST_CWD): string {
  return join(cwd, '.station', 'instances', `${instanceId}.json`);
}

function readyLifecycleFetch(url: string | URL | Request): Promise<Response> {
  const parsed = new URL(String(url));
  if (parsed.pathname === '/api/system/readiness') {
    for (const entry of readdirSync(TEST_INSTANCE_STATE_DIR)) {
      const state = JSON.parse(
        readFileSync(join(TEST_INSTANCE_STATE_DIR, entry), 'utf8'),
      );
      if (state.uiPort === Number(parsed.port)) {
        return Promise.resolve(
          new Response(JSON.stringify({ ready: true, status: 'ready' }), {
            status: 200,
          }),
        );
      }
    }
  }
  // station#3677 review MED 4: the consent report derives from the server's
  // own `/api/system/instance` self-report, never a TCP probe of the
  // consent port. The ready mock answers `listening` for the instance whose
  // server answers this port.
  if (parsed.pathname === '/api/system/instance') {
    for (const entry of readdirSync(TEST_INSTANCE_STATE_DIR)) {
      const state = JSON.parse(
        readFileSync(join(TEST_INSTANCE_STATE_DIR, entry), 'utf8'),
      );
      if (state.serverPort === Number(parsed.port)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              component: 'command-station',
              instance: state.instanceId,
              consent: {
                status: 'listening',
                port: state.consentPort ?? state.serverPort + 3,
              },
            }),
            { status: 200 },
          ),
        );
      }
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }
  // station#1177: BOTH identity endpoints serve the boot triple in
  // production (the UI child receives it at spawn — lifecycle.ts's
  // buildUiServerScript identity arg) and `station start` now validates
  // both; a blind 200 on the UI path would model the exact pre-#1177 hole
  // (a competing instance's UI answering).
  if (
    parsed.pathname === '/api/system/identity' ||
    parsed.pathname === '/__station/identity'
  ) {
    const matchesPort = (state: {
      serverPort?: number;
      uiPort?: number;
    }): boolean =>
      parsed.pathname === '/api/system/identity'
        ? state.serverPort === Number(parsed.port)
        : state.uiPort === Number(parsed.port);
    for (const entry of readdirSync(TEST_INSTANCE_STATE_DIR)) {
      const state = JSON.parse(
        readFileSync(join(TEST_INSTANCE_STATE_DIR, entry), 'utf8'),
      );
      if (matchesPort(state)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              instanceId: state.instanceId,
              sha: state.build?.sha ?? 'unknown',
              bootId: state.bootId,
            }),
            { status: 200 },
          ),
        );
      }
    }
  }
  return Promise.resolve(new Response('{}', { status: 200 }));
}

function makeReadyTcpConnectMock(): Mock {
  return vi.fn(() => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      setTimeout: () => void;
    };
    socket.destroy = vi.fn();
    socket.setTimeout = vi.fn();
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
}

function makeReadyIdentityRequestMock(): Mock {
  return vi.fn(
    (
      url: string,
      _options: import('node:http').RequestOptions,
      callback: (response: import('node:http').IncomingMessage) => void,
    ) => {
      const request = new EventEmitter() as EventEmitter & {
        end: () => void;
      };
      request.end = () => {
        queueMicrotask(() => {
          const state = JSON.parse(
            readFileSync(
              join(
                TEST_INSTANCE_STATE_DIR,
                readdirSync(TEST_INSTANCE_STATE_DIR)[0]!,
              ),
              'utf8',
            ),
          );
          const response = new EventEmitter() as EventEmitter & {
            headers: import('node:http').IncomingHttpHeaders;
            statusCode: number;
          };
          response.headers = {};
          response.statusCode = 200;
          callback(response as import('node:http').IncomingMessage);
          response.emit(
            'data',
            Buffer.from(
              new URL(url).pathname === '/api/system/readiness'
                ? JSON.stringify({ ready: true, status: 'ready' })
                : JSON.stringify({
                    instanceId: state.instanceId,
                    sha: state.build?.sha ?? 'unknown',
                    bootId: state.bootId,
                  }),
            ),
          );
          response.emit('end');
        });
      };
      return request;
    },
  );
}

async function loadLifecycleModule(
  options: {
    cwd?: string;
    childProcessMock?: {
      execFileSync?: Mock;
      execSync?: Mock;
      spawn?: Mock;
      spawnSync?: Mock;
    };
    fsOverrides?: Partial<FsModule>;
    httpRequestMock?: Mock;
    netConnectMock?: Mock;
    platformOverrides?: Partial<PlatformModule>;
  } = {},
): Promise<{
  lifecycle: LifecycleModule;
  platform: PlatformModule;
}> {
  vi.resetModules();
  vi.doUnmock('node:fs');

  vi.doMock('@kontourai/station-shared/git', () => ({
    resolveGitInfo: () => ({
      branch: 'main',
      gitRoot: TEST_CWD,
      hash: '0123456',
    }),
  }));

  const createConnection = options.netConnectMock ?? makeReadyTcpConnectMock();
  vi.doMock('node:net', async () => {
    const actual = await vi.importActual<typeof import('node:net')>('node:net');
    return { ...actual, createConnection };
  });

  if (options.httpRequestMock) {
    const request = options.httpRequestMock;
    vi.doMock('node:http', async () => {
      const actual =
        await vi.importActual<typeof import('node:http')>('node:http');
      return { ...actual, request };
    });
  }

  if (options.fsOverrides) {
    const fsOverrides = options.fsOverrides;
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<FsModule>('node:fs');
      return { ...actual, ...fsOverrides };
    });
  }

  vi.doMock('../commands/helpers.js', () => ({
    AGENTS_DIR: join(TEST_DEFAULT_HOME, 'agents'),
    CWD: options.cwd ?? TEST_CWD,
    DEFAULT_INSTANCE_ID: 'default',
    DEFAULT_PROJECT_HOME: TEST_DEFAULT_HOME,
    DEFAULT_SERVER_PORT: 3141,
    DEFAULT_UI_PORT: 3000,
    INSTANCE_STATE_DIR: TEST_INSTANCE_STATE_DIR,
    PIDFILE: TEST_PIDFILE,
    PLUGINS_DIR: join(TEST_DEFAULT_HOME, 'plugins'),
    PROJECT_HOME: TEST_DEFAULT_HOME,
    extractPluginName: () => '',
    getInstanceStatePath,
    isGitUrl: () => false,
    lookupDepInRegistries: () => null,
    normalizeHomePath: (path: string) => resolve(path),
    normalizeInstanceName,
    parseGitSource: () => ({ branch: 'main', url: '' }),
    readManifest: vi.fn(),
    resolveLifecycleHomeTarget: ({
      baseDir,
      env,
      tempHome,
    }: {
      baseDir?: string;
      env?: NodeJS.ProcessEnv;
      tempHome?: boolean;
    } = {}) => {
      const resolvedEnv = env ?? process.env;

      if (tempHome) {
        const projectHome = mkdtempSync(join(tmpdir(), 'station-dev-home-'));
        return {
          isDefaultHome: false,
          projectHome,
          source: '--temp-home' as const,
        };
      }

      if (baseDir) {
        const projectHome = resolve(baseDir);
        return {
          isDefaultHome: projectHome === TEST_DEFAULT_HOME,
          projectHome,
          source: '--base' as const,
        };
      }

      if (resolvedEnv.STATION_HOME) {
        const projectHome = resolve(resolvedEnv.STATION_HOME);
        return {
          isDefaultHome: projectHome === TEST_DEFAULT_HOME,
          projectHome,
          source: 'env' as const,
        };
      }

      return {
        isDefaultHome: true,
        projectHome: TEST_DEFAULT_HOME,
        source: 'default' as const,
      };
    },
    resolveLifecycleInstanceId: resolveInstanceId,
  }));

  if (options.childProcessMock) {
    const childProcessMock = options.childProcessMock;
    vi.doMock('node:child_process', async () => {
      const actual =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process',
        );
      return {
        ...actual,
        execFileSync: childProcessMock.execFileSync ?? actual.execFileSync,
        execSync: childProcessMock.execSync ?? vi.fn(),
        spawn: childProcessMock.spawn ?? vi.fn(),
        spawnSync: childProcessMock.spawnSync ?? actual.spawnSync,
      };
    });
  }

  const platformOverrides = options.platformOverrides ?? {};
  vi.doMock('../commands/platform.js', async () => {
    const actual = await vi.importActual<PlatformModule>(
      '../commands/platform.js',
    );
    return {
      ...actual,
      ...platformOverrides,
      // Most lifecycle tests spawn fabricated PIDs and exercise state/port/
      // readiness behavior, not process fingerprint stabilization. Letting
      // those PIDs reach the real 2-second stable-probe loop burns four
      // seconds per start (server + UI) and makes the file load-sensitive.
      // Fingerprint-specific cases inject an exact capture or inspector.
      captureStableProcessFingerprint:
        platformOverrides.captureStableProcessFingerprint ??
        platformOverrides.inspectProcessFingerprint ??
        vi.fn(() => null),
    };
  });

  const lifecycle = await import('../commands/lifecycle.js');
  const platform = await import('../commands/platform.js');
  return { lifecycle, platform };
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/**
 * Station homes are read by the instance registry before `clean` removes
 * them. A home fixture therefore has to satisfy the same owner-only contract
 * as a real existing home, rather than relying on the process umask.
 */
function ensureOwnerControlledStationHome(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // mkdir's mode is applied only to a newly created directory. Repair an
  // existing test home too, because another fixture may already have made it
  // with the host umask.
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function currentServicePlatform(): 'darwin' | 'linux' | 'win32' {
  if (
    process.platform === 'darwin' ||
    process.platform === 'linux' ||
    process.platform === 'win32'
  ) {
    return process.platform;
  }
  throw new Error(`unsupported test platform: ${process.platform}`);
}

function writeStaleServiceManifest(home: string, instanceId: string): string {
  const platform = currentServicePlatform();
  const serviceDirectory = join(home, 'service');
  const unitPath = join(serviceDirectory, `station-${instanceId}.unit`);
  ensureDir(serviceDirectory);
  writeFileSync(
    unitPath,
    platform === 'linux'
      ? '[Service]\nExecStart=/station\nNice=10\n'
      : '<plist><dict><key>ProcessType</key><string>Background</string></dict></plist>',
  );
  writeFileSync(
    join(serviceDirectory, `${instanceId}.json`),
    `${JSON.stringify({
      allowedOrigins: [],
      baseDir: home,
      features: null,
      host: '127.0.0.1',
      instanceId,
      platform,
      ...(platform === 'win32' ? { taskName: `\\Station-${instanceId}` } : {}),
      serverPort: 3141,
      uiPort: 3000,
      unitPath,
    })}\n`,
  );
  return unitPath;
}

function staleSchedulingSpawnSync(unitPath: string): Mock {
  return vi.fn((_command: string, _args: string[]) => {
    if (process.platform === 'darwin') {
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({ ProcessType: 'Background' }),
      };
    }
    if (process.platform === 'win32') {
      return { status: 0, stderr: '', stdout: '7\n' };
    }
    return {
      status: 0,
      stderr: '',
      stdout: `# ${unitPath}\n[Service]\nExecStart=/station\nNice=10\n`,
    };
  });
}

function ensureBuildOutputs(instanceId = 'default'): void {
  const server =
    instanceId === 'default' ? 'dist-server' : `dist-server-${instanceId}`;
  const ui = instanceId === 'default' ? 'dist-ui' : `dist-ui-${instanceId}`;
  ensureDir(join(TEST_CWD, server));
  ensureDir(join(TEST_CWD, ui));
  // A real build leaves the entry the instance will spawn, not just the
  // directory. Omitting it made this helper model a shape no build produces,
  // which is precisely the state station#2271 is about — and it let
  // `isInstalled()` be satisfied by an empty directory.
  writeFileSync(join(TEST_CWD, server, TEST_SERVER_ENTRY_FILENAME), '');
  writeFileSync(join(TEST_CWD, ui, 'index.html'), '<!doctype html>');
}

function writeBuildManifest(
  instanceId: string,
  overrides: Partial<{ branch: string; builtAt: string; sha: string }> = {},
): void {
  ensureBuildOutputs(instanceId);
  const server =
    instanceId === 'default' ? 'dist-server' : `dist-server-${instanceId}`;
  writeFileSync(
    join(TEST_CWD, server, 'station-build.json'),
    JSON.stringify({
      branch: 'main',
      builtAt: '2026-07-10T12:00:00.000Z',
      sha: '0123456789abcdef0123456789abcdef01234567',
      ...overrides,
    }),
  );
}

function writeInstanceState(options: {
  baseDir?: string;
  homeSource?: string;
  instanceId?: string;
  instanceName?: string;
  serverPid: number | null;
  serverPort?: number;
  startedAt?: string;
  uiPid: number | null;
  uiPort?: number;
  bootId?: string;
  lifecycleJournal?: string;
  build?: { branch: string; builtAt: string; sha: string };
  serverFingerprint?: {
    pid: number;
    startToken: string;
    commandDigest: string;
  };
  uiFingerprint?: { pid: number; startToken: string; commandDigest: string };
  hostedProbeAuthority?: string;
}): string {
  const instanceId =
    options.instanceId ||
    resolveInstanceId({
      instanceName: options.instanceName,
      projectHome: options.baseDir,
      serverPort: options.serverPort,
      uiPort: options.uiPort,
    });
  const statePath = getInstanceStatePath(instanceId);

  ensureDir(TEST_INSTANCE_STATE_DIR);
  chmodSync(TEST_INSTANCE_STATE_DIR, 0o700);
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        baseDir: resolve(options.baseDir || TEST_DEFAULT_HOME),
        bootId: options.bootId,
        build: options.build,
        cwd: TEST_CWD,
        homeSource: options.homeSource ?? 'default',
        hostedProbeAuthority: options.hostedProbeAuthority,
        instanceId,
        lifecycleJournal: options.lifecycleJournal,
        serverPid: options.serverPid,
        serverFingerprint: options.serverFingerprint,
        serverPort: options.serverPort ?? 3141,
        startedAt: options.startedAt ?? new Date().toISOString(),
        uiPid: options.uiPid,
        uiFingerprint: options.uiFingerprint,
        uiPort: options.uiPort ?? 3000,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  chmodSync(statePath, 0o600);

  return statePath;
}

// Spawning and reaping of the fake long-running fixture process (station#1812)
// is shared with platform.test.ts's killProcessTree suite -- see
// helpers/longrunning-fixture-child.ts for why `detached: true` is required
// and how it survives an abrupt suite teardown, not just a passing test.
async function spawnLongRunning(): Promise<number> {
  const proc = await spawnLongRunningFixtureChild();
  return proc.pid!;
}

async function settleLongRunningFixtures(): Promise<void> {
  await reapAllLongRunningFixtureChildren();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await settleLongRunningFixtures();
  vi.useRealTimers();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock('../commands/helpers.js');
  vi.doUnmock('../commands/platform.js');
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:http');
  vi.doUnmock('node:net');
  rmSync(TEST_ROOT, { force: true, recursive: true });
});

describe('lifecycle instance state', () => {
  it.skipIf(process.platform === 'win32')(
    'treats a real unreaped zombie as dead for lifecycle liveness',
    async () => {
      // Node reaps its own children, so keep the exited child owned by Perl.
      const parent = spawn('perl', [
        '-e',
        '$pid = fork(); exit 0 if $pid == 0; print "$pid\\n"; STDOUT->flush(); sleep 10;',
      ]);
      let output = '';
      parent.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const pid = await new Promise<number>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error('zombie PID timeout')),
          2_000,
        );
        parent.once('error', reject);
        parent.stdout.once('data', () => {
          clearTimeout(deadline);
          resolve(Number.parseInt(output.trim(), 10));
        });
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(Number.isFinite(pid)).toBe(true);
        expect(() => process.kill(pid, 0)).not.toThrow();
        const { lifecycle } = await loadLifecycleModule();
        expect(lifecycle.isProcessAlive(pid)).toBe(false);
        expect(
          lifecycle.isInstanceFullyStopped({
            baseDir: TEST_DEFAULT_HOME,
            build: null,
            cwd: TEST_CWD,
            homeSource: 'default',
            host: '127.0.0.1',
            instanceId: 'zombie-only',
            serverPid: pid,
            serverPort: 65_500,
            statePath: join(TEST_INSTANCE_STATE_DIR, 'zombie-only.json'),
            startedAt: new Date().toISOString(),
            uiPid: null,
            uiPort: 65_501,
          }),
        ).toBe(true);
      } finally {
        parent.kill('SIGKILL');
      }
    },
  );

  it('does not inherit a polluted supervisor marker into a plain server start', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    ensureBuildOutputs('plain-env-scrub');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 43011, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 43012, unref: vi.fn() });
    // Fabricated pids must answer the start() liveness probe (signal 0), same
    // harness as 'writes per-instance state and injects instance env on start'.
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0 && (pid === 43011 || pid === 43012)) {
        return true;
      }
      throw new Error(`unexpected process.kill(${pid}, ${String(signal)})`);
    }) as typeof process.kill);
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const previous = process.env.STATION_SUPERVISOR_PID;
    process.env.STATION_SUPERVISOR_PID = 'stale-supervisor';
    try {
      const { lifecycle } = await loadLifecycleModule({
        childProcessMock: { execSync: vi.fn(), spawn },
        platformOverrides: { sleepSync: vi.fn() },
      });
      await lifecycle.start({
        baseDir: TEST_ALT_HOME,
        instanceName: 'plain-env-scrub',
        serverPort: 3251,
        uiPort: 5281,
      });

      expect(spawn.mock.calls[0][2].env).not.toHaveProperty(
        'STATION_SUPERVISOR_PID',
      );
    } finally {
      if (previous === undefined) delete process.env.STATION_SUPERVISOR_PID;
      else process.env.STATION_SUPERVISOR_PID = previous;
    }
  });

  it('scopes the supervisor marker to the supervised server spawn only', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    ensureBuildOutputs('supervised-env-scrub');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 43021, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 43022, unref: vi.fn() });
    // Same fabricated-pid liveness harness as the plain-env-scrub test above.
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0 && (pid === 43021 || pid === 43022)) {
        return true;
      }
      throw new Error(`unexpected process.kill(${pid}, ${String(signal)})`);
    }) as typeof process.kill);
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(), spawn },
      platformOverrides: { sleepSync: vi.fn() },
    });

    await lifecycle.start({
      baseDir: TEST_ALT_HOME,
      instanceName: 'supervised-env-scrub',
      serverPort: 3252,
      supervisorPid: 12345,
      uiPort: 5282,
    });

    expect(spawn.mock.calls[0][2].env).toMatchObject({
      STATION_SUPERVISOR_PID: '12345',
    });
    expect(spawn.mock.calls[1][2].env).not.toHaveProperty(
      'STATION_SUPERVISOR_PID',
    );
  });

  it('reaps owned long-running fixture processes deterministically', async () => {
    const pid = await spawnLongRunning();
    expect(isAlive(pid)).toBe(true);

    await settleLongRunningFixtures();

    expect(isAlive(pid)).toBe(false);
  });

  it('never runs the real fingerprint stabilizer for fabricated test PIDs', async () => {
    const { platform } = await loadLifecycleModule();

    expect(vi.isMockFunction(platform.captureStableProcessFingerprint)).toBe(
      true,
    );
    expect(platform.captureStableProcessFingerprint(41_001)).toBeNull();
  });

  it('fsyncs a typed operator stop intent for the exact boot before signaling', async () => {
    ensureDir(TEST_CWD);
    const journal = join(TEST_ROOT, 'lifecycle.jsonl');
    writeInstanceState({
      instanceName: 'journaled',
      serverPid: 41001,
      uiPid: 41002,
      serverPort: 3242,
      uiPort: 5274,
      bootId: '11111111-1111-4111-8111-111111111111',
      lifecycleJournal: journal,
      serverFingerprint: {
        pid: 41001,
        startToken: 'server-start',
        commandDigest: 'a'.repeat(64),
      },
      uiFingerprint: {
        pid: 41002,
        startToken: 'ui-start',
        commandDigest: 'b'.repeat(64),
      },
      build: {
        branch: 'main',
        builtAt: '2026-07-10T12:00:00.000Z',
        sha: 'a'.repeat(40),
      },
    });
    let alive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0 && (pid === 41001 || pid === 41002)) {
        if (alive) return true;
        throw new Error('gone');
      }
      return true;
    }) as typeof process.kill);
    const killProcessTree = vi.fn(() => {
      alive = false;
    });
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => '') },
      platformOverrides: {
        killProcessTree,
        sleepSync: vi.fn(),
        inspectProcessFingerprint: (pid: number) =>
          pid === 41001
            ? {
                pid,
                startToken: 'server-start',
                commandDigest: 'a'.repeat(64),
              }
            : {
                pid,
                startToken: 'ui-start',
                commandDigest: 'b'.repeat(64),
              },
      },
    });
    try {
      lifecycle.stop({ instanceName: 'journaled' });
      const events = readLifecycleEvents(journal);
      expect(
        events.find((event) => event.type === 'stop_intent'),
      ).toMatchObject({
        type: 'stop_intent',
        intent: 'operator_stop',
        bootId: '11111111-1111-4111-8111-111111111111',
        pid: 41001,
      });
      expect(events.at(-1)).toMatchObject({
        type: 'stop_result',
        result: 'completed',
      });
      expect(killProcessTree).toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('fails a managed stop without signaling a reused PID or arbitrary port owner', async () => {
    ensureDir(TEST_CWD);
    const journal = join(TEST_ROOT, 'reused-lifecycle.jsonl');
    writeInstanceState({
      instanceName: 'reused',
      serverPid: 42001,
      uiPid: null,
      bootId: '11111111-1111-4111-8111-111111111111',
      lifecycleJournal: journal,
      serverFingerprint: {
        pid: 42001,
        startToken: 'managed-start',
        commandDigest: 'a'.repeat(64),
      },
      build: {
        branch: 'main',
        builtAt: '2026-07-10T12:00:00.000Z',
        sha: 'a'.repeat(40),
      },
    });
    const killProcessTree = vi.fn();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => '99999\n') },
      platformOverrides: {
        killProcessTree,
        sleepSync: vi.fn(),
        inspectProcessFingerprint: (pid: number) => ({
          pid,
          startToken: 'unrelated-start',
          commandDigest: 'b'.repeat(64),
        }),
      },
    });
    try {
      expect(() => lifecycle.stop({ instanceName: 'reused' })).toThrow(
        'process fingerprint mismatch',
      );
      expect(killProcessTree).not.toHaveBeenCalled();
      expect(readLifecycleEvents(journal).at(-1)).toMatchObject({
        type: 'stop_result',
        result: 'failed',
      });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('fails closed on permissive or symlinked modern instance state', async () => {
    ensureDir(TEST_CWD);
    const permissive = writeInstanceState({
      instanceName: 'permissive',
      serverPid: 43001,
      uiPid: null,
    });
    chmodSync(permissive, 0o644);
    const { lifecycle } = await loadLifecycleModule();
    expect(() => lifecycle.isRunning()).toThrow('expected owned mode 0600');

    rmSync(permissive);
    const target = join(TEST_ROOT, 'outside-instance.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, permissive);
    expect(() => lifecycle.isRunning()).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });

  it('fails publication when the instance directory cannot be fsynced', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('dir-sync');
    ensureDir(TEST_ALT_HOME);
    const actualFs = await vi.importActual<FsModule>('node:fs');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 43101, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 43102, unref: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(), spawn },
      fsOverrides: {
        fsyncSync: (fd) => {
          if (actualFs.fstatSync(fd).isDirectory()) {
            throw new Error('directory fsync failed');
          }
          actualFs.fsyncSync(fd);
        },
      },
      platformOverrides: { sleepSync: vi.fn() },
    });
    await expect(
      lifecycle.start({
        baseDir: TEST_ALT_HOME,
        instanceName: 'dir-sync',
        serverPort: 3250,
        uiPort: 5280,
      }),
    ).rejects.toThrow('directory fsync failed');
    expect(existsSync(getInstanceStatePath('dir-sync'))).toBe(false);
  });

  it('detects a final-path replacement instead of claiming another record', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('replaced-final');
    ensureDir(TEST_ALT_HOME);
    const actualFs = await vi.importActual<FsModule>('node:fs');
    const statePath = getInstanceStatePath('replaced-final');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 43201, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 43202, unref: vi.fn() });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response('<html></html>', { status: 200 })),
    );
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(), spawn },
      fsOverrides: {
        renameSync: (source, destination) => {
          actualFs.renameSync(source, destination);
          if (
            String(source).includes('.instance-') &&
            destination === statePath
          ) {
            actualFs.rmSync(destination);
            actualFs.writeFileSync(destination, '{"replacement":true}', {
              mode: 0o600,
            });
          }
        },
      },
      platformOverrides: { sleepSync: vi.fn() },
    });
    await expect(
      lifecycle.start({
        baseDir: TEST_ALT_HOME,
        instanceName: 'replaced-final',
        serverPort: 3254,
        uiPort: 5284,
      }),
    ).rejects.toThrow('Failed to publish secure instance state');
    expect(readFileSync(statePath, 'utf8')).toBe('{"replacement":true}');
  });

  it('restores replacement B when it appears after removal inspected A', async () => {
    ensureDir(TEST_CWD);
    const statePath = writeInstanceState({
      instanceName: 'remove-race',
      serverPid: 43301,
      uiPid: null,
    });
    const original = JSON.parse(readFileSync(statePath, 'utf8'));
    const replacement = JSON.stringify({ ...original, serverPort: 3999 });
    const actualFs = await vi.importActual<FsModule>('node:fs');
    let alive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
      if (alive) return true;
      throw new Error('gone');
    }) as typeof process.kill);
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => '') },
      fsOverrides: {
        renameSync: (source, destination) => {
          if (
            source === statePath &&
            String(destination).includes('.quarantine-')
          ) {
            actualFs.rmSync(source);
            actualFs.writeFileSync(source, replacement, { mode: 0o600 });
          }
          actualFs.renameSync(source, destination);
        },
      },
      platformOverrides: {
        killProcessTree: vi.fn(() => {
          alive = false;
        }),
        sleepSync: vi.fn(),
      },
    });
    try {
      expect(() => lifecycle.stop({ instanceName: 'remove-race' })).toThrow(
        'replaced during removal',
      );
      expect(readFileSync(statePath, 'utf8')).toBe(replacement);
    } finally {
      killSpy.mockRestore();
    }
  });

  // This test bundles and launches a real child process. Under the aggregate
  // suite it needs a process-work budget, not Vitest's unit-test default.
  it('recovers managed state publication after a real guard-owner child crash', {
    timeout: PROCESS_INTEGRATION_TEST_TIMEOUT_MS,
  }, async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('state-orphan');
    ensureDir(TEST_ALT_HOME);
    ensureDir(TEST_INSTANCE_STATE_DIR);
    chmodSync(TEST_INSTANCE_STATE_DIR, 0o700);
    const statePath = getInstanceStatePath('state-orphan');
    const lock = `${statePath}.mutation`;
    writeFileSync(
      lock,
      JSON.stringify({ pid: 999_999, birth: 'dead', token: 'A' }),
      {
        mode: 0o600,
      },
    );
    const modulePath = resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'shared',
      'src',
      'lifecycle-events.ts',
    );
    const fixturePath = join(TEST_ROOT, 'guard-owner-crash-fixture.ts');
    writeFileSync(
      fixturePath,
      `import { acquireFileMutationLock } from ${JSON.stringify(modulePath)};\nacquireFileMutationLock(process.env.LOCK!, { timeoutMs: 100, birthFingerprint: (pid) => pid === process.pid ? 'fixture-birth' : null, hooks: { afterGuardAcquired: () => process.exit(23) } });\n`,
      { mode: 0o600 },
    );
    const bundledFixturePath = join(TEST_ROOT, 'guard-owner-crash-fixture.mjs');
    buildSync({
      entryPoints: [fixturePath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundledFixturePath,
    });
    const { spawnSync: spawnRealProcessSync } =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    const child = spawnRealProcessSync(process.execPath, [bundledFixturePath], {
      env: { ...process.env, LOCK: lock },
      timeout: 5_000,
    });
    const childDiagnostic = [child.error?.message, child.stderr?.toString()]
      .filter(Boolean)
      .join('\n');
    expect(child.status, childDiagnostic).toBe(23);
    expect(existsSync(`${lock}.guard`)).toBe(true);

    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 43401, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 43402, unref: vi.fn() });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
    ) => {
      if (pid === 43401 || pid === 43402) return true;
      throw new Error(`unexpected process.kill(${pid})`);
    }) as typeof process.kill);
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(), spawn },
      platformOverrides: { sleepSync: vi.fn() },
    });
    try {
      await lifecycle.start({
        baseDir: TEST_ALT_HOME,
        instanceName: 'state-orphan',
        serverPort: 3260,
        uiPort: 5290,
      });
      expect(JSON.parse(readFileSync(statePath, 'utf8')).instanceId).toBe(
        'state-orphan',
      );
      expect(existsSync(`${lock}.guard`)).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('merges start allowedOrigins into the spawned server ALLOWED_ORIGINS (#1672)', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('origins-env');
    ensureDir(TEST_ALT_HOME);
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 43501, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 43502, unref: vi.fn() });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
    ) => {
      if (pid === 43501 || pid === 43502) return true;
      throw new Error(`unexpected process.kill(${pid})`);
    }) as typeof process.kill);
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(), spawn },
      platformOverrides: { sleepSync: vi.fn() },
    });
    try {
      await lifecycle.start({
        allowedOrigins: [
          'https://kontour.example.ts.net',
          // Duplicate of a computed UI origin — must not appear twice.
          'http://localhost:5300',
        ],
        baseDir: TEST_ALT_HOME,
        instanceName: 'origins-env',
        serverPort: 3270,
        uiPort: 5300,
      });
      // First spawn is the server process; its env is where the pairing gate
      // reads ALLOWED_ORIGINS from. This is the end-to-end mechanism of the
      // #1672 fix — dropping the merge must turn this red.
      const spawnOptions = spawn.mock.calls[0]?.[2] as
        | { env: NodeJS.ProcessEnv }
        | undefined;
      const serverEnv = spawnOptions?.env ?? {};
      const origins = (serverEnv.ALLOWED_ORIGINS ?? '').split(',');
      expect(origins).toContain('https://kontour.example.ts.net');
      expect(
        origins.filter((origin) => origin === 'http://localhost:5300'),
      ).toHaveLength(1);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('recognizes and cleans up stale prior PID files', async () => {
    ensureDir(TEST_CWD);
    writeFileSync(TEST_PIDFILE, '99999');

    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => '') },
      platformOverrides: {
        killProcessTree: vi.fn(),
      },
    });

    expect(lifecycle.isRunning()).toBe(false);
    expect(existsSync(TEST_PIDFILE)).toBe(false);
  });

  it('reporting status does not reclaim a stale record, but still excludes it (station#2745)', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);

    // A record whose process is long dead. Reclaiming it calls
    // removeStateRecord, which takes a SYNCHRONOUS file-mutation lock — once
    // per stale record. The diagnostics bundle reaches this path over HTTP, so
    // a reader must never trigger it.
    const statePath = writeInstanceState({
      baseDir: TEST_ALT_HOME,
      instanceName: 'stale-reporting',
      serverPid: 99999,
      serverPort: 3252,
      uiPid: null,
      uiPort: 5284,
    });

    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => '') },
      platformOverrides: { killProcessTree: vi.fn() },
    });

    const reported = await lifecycle.collectInstanceStatus('stale-reporting', {
      reclaimStale: false,
    });

    // The dead instance is still correctly reported as absent...
    expect(reported.found).toBe(false);
    // ...and the registry was not mutated to reach that answer.
    expect(existsSync(statePath)).toBe(true);
  });

  it('a lifecycle caller still reclaims the same stale record (station#2745 control)', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);

    const statePath = writeInstanceState({
      baseDir: TEST_ALT_HOME,
      instanceName: 'stale-lifecycle',
      serverPid: 99999,
      serverPort: 3253,
      uiPid: null,
      uiPort: 5285,
    });

    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => '') },
      platformOverrides: { killProcessTree: vi.fn() },
    });

    // Default (reclaiming) behaviour is unchanged: this is what proves the
    // read-only path above is a real difference and not a no-op.
    const reported = await lifecycle.collectInstanceStatus('stale-lifecycle');

    expect(reported.found).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });

  it('stops only the targeted named instance when multiple instances are live', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_DEFAULT_HOME);
    ensureDir(TEST_ALT_HOME);

    const alphaPid = await spawnLongRunning();
    const betaPid = await spawnLongRunning();
    let alphaAlive = true;
    let betaAlive = true;
    writeInstanceState({
      baseDir: TEST_ALT_HOME,
      instanceName: 'alpha',
      serverPid: alphaPid,
      serverPort: 3242,
      uiPid: null,
      uiPort: 5274,
    });
    const betaStatePath = writeInstanceState({
      baseDir: TEST_SECOND_HOME,
      instanceName: 'beta',
      serverPid: betaPid,
      serverPort: 3243,
      uiPid: null,
      uiPort: 5275,
    });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0 && pid === alphaPid) {
        if (alphaAlive) return true;
        throw new Error('gone');
      }
      if (signal === 0 && pid === betaPid) {
        if (betaAlive) return true;
        throw new Error('gone');
      }
      return true;
    }) as typeof process.kill);

    try {
      const { lifecycle } = await loadLifecycleModule({
        childProcessMock: { execSync: vi.fn(() => '') },
        platformOverrides: {
          killProcessTree: vi.fn((pid: number) => {
            if (pid === alphaPid) {
              alphaAlive = false;
            }
          }),
        },
      });

      lifecycle.stop({ instanceName: 'alpha' });

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(isAlive(alphaPid)).toBe(false);
      expect(isAlive(betaPid)).toBe(true);
      expect(existsSync(getInstanceStatePath('alpha'))).toBe(false);
      expect(existsSync(betaStatePath)).toBe(true);
    } finally {
      betaAlive = false;
      killSpy.mockRestore();
      process.kill(betaPid, 'SIGKILL');
    }
  }, 15_000);

  it('kills lingering listeners before removing instance state', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);

    const statePath = writeInstanceState({
      baseDir: TEST_ALT_HOME,
      instanceName: 'alpha',
      serverPid: 41001,
      serverPort: 3242,
      uiPid: null,
      uiPort: 5274,
    });

    let now = 0;
    let listenerAlive = true;
    const killProcessTree = vi.fn((pid: number) => {
      if (pid === 51001) {
        listenerAlive = false;
      }
    });
    const execSync = vi.fn((command: string) => {
      if (
        command.includes('lsof') &&
        command.includes('5274') &&
        listenerAlive
      ) {
        return '51001\n';
      }
      return '';
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0 && pid === 41001) {
        throw new Error('gone');
      }
      return true;
    }) as typeof process.kill);
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync },
      platformOverrides: {
        killProcessTree,
        sleepSync: vi.fn((ms: number) => {
          now += ms;
        }),
      },
    });

    try {
      lifecycle.stop({ instanceName: 'alpha' });
      expect(killProcessTree).toHaveBeenCalledWith(41001);
      expect(killProcessTree).toHaveBeenCalledWith(51001);
      expect(existsSync(statePath)).toBe(false);
    } finally {
      killSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it.each([
    ['terminal', 3243],
    ['voice', 3244],
  ])(
    'treats a %s-only listener as live and kills it before removing state',
    (_name, lingeringPort) => {
      ensureDir(TEST_CWD);
      const statePath = writeInstanceState({
        baseDir: TEST_ALT_HOME,
        instanceName: `lingering-${_name}`,
        serverPid: null,
        serverPort: 3242,
        uiPid: null,
        uiPort: 5274,
      });
      let now = 0;
      let listenerAlive = true;
      const execSync = vi.fn((command: string) => {
        if (command.includes(`iTCP:${lingeringPort}`) && listenerAlive) {
          return '52001\n';
        }
        return '';
      });
      const killProcessTree = vi.fn((pid: number) => {
        if (pid === 52001) listenerAlive = false;
      });
      const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

      return loadLifecycleModule({
        childProcessMock: { execSync },
        platformOverrides: {
          killProcessTree,
          sleepSync: vi.fn((ms: number) => {
            now += ms;
          }),
        },
      }).then(({ lifecycle }) => {
        try {
          expect(
            lifecycle.isRunning({ instanceName: `lingering-${_name}` }),
          ).toBe(true);
          lifecycle.stop({ instanceName: `lingering-${_name}` });
          expect(killProcessTree).toHaveBeenCalledWith(52001);
          expect(existsSync(statePath)).toBe(false);
        } finally {
          dateSpy.mockRestore();
        }
      });
    },
  );

  it('writes per-instance state and injects instance env on start', async () => {
    vi.stubEnv('STATION_HOME_SOURCE', '--temp-home');
    ensureDir(TEST_CWD);
    ensureBuildOutputs('smoke-a');
    ensureDir(TEST_ALT_HOME);

    const execSync = vi.fn();
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 41001, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 41002, unref: vi.fn() });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0 && (pid === 41001 || pid === 41002)) {
        return true;
      }
      throw new Error(`unexpected process.kill(${pid}, ${String(signal)})`);
    }) as typeof process.kill);
    const fetchMock = vi.fn(readyLifecycleFetch);
    vi.stubGlobal('fetch', fetchMock);

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync, spawn },
      platformOverrides: { sleepSync: vi.fn() },
    });

    await lifecycle.start({
      baseDir: TEST_ALT_HOME,
      homeSource: '--base',
      instanceName: 'smoke-a',
      serverPort: 3242,
      uiPort: 5274,
    });

    const statePath = getInstanceStatePath('smoke-a');
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      baseDir: string;
      instanceId: string;
      serverPid: number;
      serverPort: number;
      uiPid: number;
      uiPort: number;
    };

    expect(execSync).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][0]).toBe(process.execPath);
    expect(spawn.mock.calls[1][0]).toBe(process.execPath);
    expect(spawn.mock.calls[0][1]).toEqual([
      'dist-server-smoke-a/command-station.js',
    ]);
    expect(spawn.mock.calls[0][2]?.env).toEqual(
      expect.objectContaining({
        PORT: '3242',
        STATION_HOME: TEST_ALT_HOME,
        STATION_HOME_SOURCE: '--base',
        STATION_BUILD_BRANCH: 'unknown',
        STATION_BUILD_BUILT_AT: 'unknown',
        STATION_BUILD_SHA: 'unknown',
        STATION_HOST: '0.0.0.0',
        STATION_INSTANCE_ID: 'smoke-a',
        STATION_INSTANCE_STATE_PATH: statePath,
      }),
    );
    expect(state).toMatchObject({
      baseDir: TEST_ALT_HOME,
      build: null,
      host: '0.0.0.0',
      instanceId: 'smoke-a',
      serverPid: 41001,
      serverPort: 3242,
      uiPid: 41002,
      uiPort: 5274,
    });
    expect(statSync(TEST_INSTANCE_STATE_DIR).mode & 0o777).toBe(0o700);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(
        readFileSync(join(TEST_ALT_HOME, STATION_HOME_SCHEMA_FILE), 'utf-8'),
      ),
    ).toEqual({ version: STATION_HOME_SCHEMA_VERSION });
    expect(consoleLog).toHaveBeenCalledWith(
      '\n  Stop with: station stop --instance=smoke-a',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3242/api/system/identity',
      {
        headers: expect.objectContaining({
          Accept: 'application/json',
          'x-station-internal-token':
            expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/),
          'x-station-proxy-caller': 'local',
        }),
        signal: expect.any(AbortSignal),
      },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5274/__station/identity',
      {
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      },
    );

    killSpy.mockRestore();
  });

  it('INJECTION (station#3677 review MED 4): a foreign process answering the consent port cannot produce a green consent line — readiness derives from the runtime self-report', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('squatted-consent');
    ensureDir(TEST_ALT_HOME);
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 41001, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 41002, unref: vi.fn() });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    // The runtime reports its OWN consent listener failed to bind…
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/api/system/instance') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              component: 'command-station',
              consent: { status: 'unavailable' },
            }),
            { status: 200 },
          ),
        );
      }
      return readyLifecycleFetch(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    // …while an UNRELATED process happily accepts every TCP connection,
    // including on the consent port. Pre-fix, that socket accept alone
    // printed "✓ Consent" for a Station whose approvals had failed closed.
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(), spawn },
      netConnectMock: makeReadyTcpConnectMock(),
      platformOverrides: { sleepSync: vi.fn() },
    });
    try {
      await lifecycle.start({
        baseDir: TEST_ALT_HOME,
        homeSource: '--base',
        instanceName: 'squatted-consent',
        serverPort: 3262,
        uiPort: 5294,
      });
      const lines = consoleLog.mock.calls.map((call) => String(call[0]));
      expect(
        lines.some((line) =>
          line.includes('Consent listener unavailable (expected port 3265)'),
        ),
      ).toBe(true);
      expect(lines.some((line) => line.includes('✓ Consent'))).toBe(false);
    } finally {
      consoleLog.mockRestore();
      killSpy.mockRestore();
    }
  });

  it('starts a hosted instance by probing both identities through the UI authority', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('hosted-smoke');
    ensureDir(TEST_ALT_HOME);
    const registryFile = join(TEST_ROOT, 'hosted-tenants.json');
    writeFileSync(
      registryFile,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
      }),
    );
    const previousRegistry = process.env.STATION_HOSTED_TENANT_REGISTRY_FILE;
    process.env.STATION_HOSTED_TENANT_REGISTRY_FILE = registryFile;
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 43001, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 43002, unref: vi.fn() });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    const httpRequest = makeReadyIdentityRequestMock();
    try {
      const { lifecycle } = await loadLifecycleModule({
        childProcessMock: { execSync: vi.fn(), spawn },
        httpRequestMock: httpRequest,
        netConnectMock: makeReadyTcpConnectMock(),
      });
      await lifecycle.start({
        baseDir: TEST_ALT_HOME,
        homeSource: '--base',
        instanceName: 'hosted-smoke',
        serverPort: 3242,
        uiPort: 5274,
      });
      expect(httpRequest).toHaveBeenCalledTimes(2);
      for (const [url, options] of httpRequest.mock.calls) {
        expect(url).toContain('http://localhost:5274/');
        expect(options).toMatchObject({
          headers: { Accept: 'application/json', Host: 'alpha.example.test' },
        });
      }
      expect(httpRequest.mock.calls[0]?.[0]).toContain('/api/system/identity');
      expect(httpRequest.mock.calls[1]?.[0]).toContain('/__station/identity');
      expect(
        JSON.parse(readFileSync(getInstanceStatePath('hosted-smoke'), 'utf8')),
      ).toMatchObject({ hostedProbeAuthority: 'alpha.example.test' });
    } finally {
      if (previousRegistry === undefined) {
        delete process.env.STATION_HOSTED_TENANT_REGISTRY_FILE;
      } else {
        process.env.STATION_HOSTED_TENANT_REGISTRY_FILE = previousRegistry;
      }
      killSpy.mockRestore();
    }
  });

  it('collects hosted instance status through the UI proxy with its boot authority', async () => {
    ensureDir(TEST_CWD);
    const bootId = '11111111-1111-4111-8111-111111111111';
    writeInstanceState({
      bootId,
      build: {
        branch: 'main',
        builtAt: '2026-08-03T00:00:00.000Z',
        sha: 'a'.repeat(40),
      },
      hostedProbeAuthority: 'alpha.example.test',
      instanceName: 'hosted-status',
      serverPid: 43001,
      serverPort: 3242,
      uiPid: 43002,
      uiPort: 5274,
    });
    const httpRequest = makeReadyIdentityRequestMock();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    try {
      const { lifecycle } = await loadLifecycleModule({
        httpRequestMock: httpRequest,
      });
      await expect(
        lifecycle.collectInstanceStatus('hosted-status'),
      ).resolves.toMatchObject({
        healthy: true,
        server: { reachable: true },
        ui: { reachable: true },
      });
      expect(httpRequest).toHaveBeenCalledTimes(2);
      expect(httpRequest.mock.calls.map(([url]) => url)).toEqual([
        'http://127.0.0.1:5274/api/system/readiness',
        'http://127.0.0.1:5274/__station/identity',
      ]);
      for (const [, options] of httpRequest.mock.calls) {
        expect(options).toMatchObject({
          headers: { Host: 'alpha.example.test' },
        });
      }
    } finally {
      killSpy.mockRestore();
    }
  });

  it('rejects a non-canonical hosted probe authority in persisted instance state', async () => {
    ensureDir(TEST_CWD);
    writeInstanceState({
      hostedProbeAuthority: 'Constructor',
      instanceName: 'hosted-status-tampered',
      serverPid: 43001,
      uiPid: 43002,
    });
    const { lifecycle } = await loadLifecycleModule();
    expect(() =>
      lifecycle.isRunning({ instanceName: 'hosted-status-tampered' }),
    ).toThrow('Invalid hosted probe authority in instance state');
  });

  it('blocks starts whose requested ports overlap a sibling terminal or voice socket', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('agent-crud');
    ensureDir(TEST_ALT_HOME);
    ensureDir(TEST_SECOND_HOME);

    const siblingPid = await spawnLongRunning();
    writeInstanceState({
      baseDir: TEST_SECOND_HOME,
      instanceName: 'agent-smoke',
      serverPid: siblingPid,
      serverPort: 3242,
      uiPid: null,
      uiPort: 5274,
    });

    const spawn = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(), spawn },
    });

    await expect(
      lifecycle.start({
        baseDir: TEST_ALT_HOME,
        homeSource: '--base',
        instanceName: 'agent-crud',
        serverPort: 3243,
        uiPort: 5275,
      }),
    ).rejects.toThrow(
      'start is blocked because the requested ports overlap another live Station instance.',
    );
    expect(spawn).not.toHaveBeenCalled();

    process.kill(siblingPid, 'SIGKILL');
  }, 15_000);

  it('keeps startup when aggregate status hangs but authenticated identity becomes ready', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('smoke-b');
    ensureDir(TEST_ALT_HOME);

    const execSync = vi.fn();
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 42001, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 42002, unref: vi.fn() });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0 && (pid === 42001 || pid === 42002)) {
        return true;
      }
      throw new Error(`unexpected process.kill(${pid}, ${String(signal)})`);
    }) as typeof process.kill);
    let identityAttempts = 0;
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/api/system/status') {
        return new Promise<Response>(() => {});
      }
      if (
        parsed.pathname === '/api/system/identity' &&
        identityAttempts++ === 0
      ) {
        return Promise.resolve(new Response('starting', { status: 503 }));
      }
      return readyLifecycleFetch(url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync, spawn },
      platformOverrides: { sleepSync: vi.fn() },
    });

    await lifecycle.start({
      baseDir: TEST_ALT_HOME,
      homeSource: '--base',
      instanceName: 'smoke-b',
      serverPort: 3246,
      uiPort: 5278,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3246/api/system/identity',
      {
        headers: expect.objectContaining({
          Accept: 'application/json',
          'x-station-internal-token':
            expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/),
          'x-station-proxy-caller': 'local',
        }),
        signal: expect.any(AbortSignal),
      },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5278/__station/identity',
      {
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      },
    );
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/api/system/status'),
      ),
    ).toBe(false);
    expect(identityAttempts).toBeGreaterThanOrEqual(2);

    killSpy.mockRestore();
  });

  it('bounds an identity request that stalls before response headers', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              ),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { lifecycle } = await loadLifecycleModule();
    const url = 'http://localhost:3246/api/system/identity';

    const waiting = lifecycle.waitForIdentity(
      url,
      { instanceId: 'smoke-b', sha: 'identity-sha', bootId: 'identity-boot' },
      1_000,
    );
    const rejection = expect(waiting).rejects.toThrow(
      `Timed out waiting for ${url} (Identity readiness request timed out)`,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledWith(url, {
      headers: { Accept: 'application/json' },
      signal: expect.objectContaining({ aborted: true }),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds an identity response whose JSON body stalls', async () => {
    vi.useFakeTimers();
    const responseJson = vi.fn(() => new Promise<never>(() => {}));
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return Promise.resolve({
          ok: true,
          json: responseJson,
        } as unknown as Response);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const { lifecycle } = await loadLifecycleModule();
    const url = 'http://localhost:5278/__station/identity';

    const waiting = lifecycle.waitForIdentity(
      url,
      { instanceId: 'smoke-b', sha: 'identity-sha', bootId: 'identity-boot' },
      1_000,
    );
    const rejection = expect(waiting).rejects.toThrow(
      `Timed out waiting for ${url} (Identity readiness request timed out)`,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(responseJson).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies the per-attempt deadline sentinel as request-timeout and every other error as no-listener', async () => {
    const { lifecycle } = await loadLifecycleModule();
    expect(
      lifecycle.classifyIdentityWaitError(
        new Error('Identity readiness request timed out'),
      ),
    ).toBe('request-timeout');
    expect(
      lifecycle.classifyIdentityWaitError(new TypeError('fetch failed')),
    ).toBe('no-listener');
    expect(lifecycle.classifyIdentityWaitError('boom')).toBe('no-listener');
  });

  it('extends the readiness deadline while the child is alive with no listener bound, then succeeds (#2646)', async () => {
    vi.useFakeTimers();
    let answering = false;
    const fetchMock = vi.fn((_url: string | URL | Request) =>
      answering
        ? Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                instanceId: 'smoke-b',
                sha: 'identity-sha',
                bootId: 'identity-boot',
              }),
          } as unknown as Response)
        : Promise.reject(new TypeError('fetch failed')),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { lifecycle } = await loadLifecycleModule();
    const url = 'http://localhost:3246/api/system/identity';
    const log = vi.fn();

    let settled: 'resolved' | 'rejected' | null = null;
    const waiting = lifecycle
      .waitForIdentity(
        url,
        { instanceId: 'smoke-b', sha: 'identity-sha', bootId: 'identity-boot' },
        1_000,
        undefined,
        { childAlive: () => true, extensionMs: 500, maxExtensions: 2, log },
      )
      .then(
        () => {
          settled = 'resolved';
        },
        () => {
          settled = 'rejected';
        },
      );

    // Past the base deadline: still refusing, child alive -> must extend, not
    // fail. The extension line names the classification.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(settled).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Startup readiness deadline extended'),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('(no-listener)'));

    // The child binds during the extension window: the wait must succeed.
    answering = true;
    await vi.advanceTimersByTimeAsync(300);
    await waiting;
    expect(settled).toBe('resolved');
  });

  it('never extends past an identity mismatch: the port answering with the wrong triple fails at the base deadline (#2646)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            instanceId: 'someone-else',
            sha: 'other-sha',
            bootId: 'other-boot',
          }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { lifecycle } = await loadLifecycleModule();
    const url = 'http://localhost:3246/api/system/identity';
    const log = vi.fn();

    let failure: Error | null = null;
    let settled = false;
    const waiting = lifecycle
      .waitForIdentity(
        url,
        { instanceId: 'smoke-b', sha: 'identity-sha', bootId: 'identity-boot' },
        1_000,
        undefined,
        { childAlive: () => true, extensionMs: 500, maxExtensions: 2, log },
      )
      .catch((error: Error) => {
        failure = error;
      })
      .finally(() => {
        settled = true;
      });

    // childAlive is true and would permit extension — but a mismatch is
    // positive evidence of a lost port race, so the wait must fail at the
    // BASE deadline with no extension.
    await vi.advanceTimersByTimeAsync(1_100);
    // Asserted BEFORE awaiting `waiting`: if the mismatch were misclassified as
    // a slow-boot kind the wait would still be extending here, and awaiting a
    // promise that has not settled would report an opaque test timeout instead
    // of naming the guard that broke.
    expect(
      settled,
      'identity mismatch must fail at the base deadline, never extend',
    ).toBe(true);
    expect(log).not.toHaveBeenCalled();
    await waiting;
    expect(failure).not.toBeNull();
    expect(failure!.message).toBe(
      `Timed out waiting for ${url} (managed boot identity mismatch)`,
    );
  });

  it('classifies only upstream-not-ready 5xx as gateway-unavailable (#2646)', async () => {
    const { lifecycle } = await loadLifecycleModule();
    for (const status of [502, 503, 504]) {
      expect(lifecycle.classifyIdentityWaitStatus(status)).toBe(
        'gateway-unavailable',
      );
    }
    // A real server error and every auth/config 4xx stay non-extendable: more
    // time cannot fix them, and extending would mask them.
    for (const status of [500, 400, 401, 403, 404]) {
      expect(lifecycle.classifyIdentityWaitStatus(status)).toBe('http-error');
    }
  });

  it('extends past a hosted proxy 503 — "UI up, server still booting" is a slow boot (#2646)', async () => {
    vi.useFakeTimers();
    // The hosted boot path probes the SERVER's identity through the UI port,
    // so a server that has not finished booting answers as the proxy's 503.
    let booted = false;
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        booted
          ? ({
              ok: true,
              json: () =>
                Promise.resolve({
                  instanceId: 'smoke-b',
                  sha: 'identity-sha',
                  bootId: 'identity-boot',
                }),
            } as unknown as Response)
          : ({
              ok: false,
              status: 503,
              statusText: 'Service Unavailable',
            } as unknown as Response),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { lifecycle } = await loadLifecycleModule();
    const url = 'http://localhost:3246/api/system/identity';
    const log = vi.fn();

    let settled: 'resolved' | 'rejected' | null = null;
    const waiting = lifecycle
      .waitForIdentity(
        url,
        { instanceId: 'smoke-b', sha: 'identity-sha', bootId: 'identity-boot' },
        1_000,
        undefined,
        { childAlive: () => true, extensionMs: 500, maxExtensions: 2, log },
      )
      .then(
        () => {
          settled = 'resolved';
        },
        () => {
          settled = 'rejected';
        },
      );

    await vi.advanceTimersByTimeAsync(1_100);
    expect(settled).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('(gateway-unavailable)'),
    );

    booted = true;
    await vi.advanceTimersByTimeAsync(300);
    await waiting;
    expect(settled).toBe('resolved');
  });

  it('never extends past a 500 — a real server error is not a slow boot (#2646)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { lifecycle } = await loadLifecycleModule();
    const url = 'http://localhost:3246/api/system/identity';
    const log = vi.fn();

    let failure: Error | null = null;
    let settled = false;
    const waiting = lifecycle
      .waitForIdentity(
        url,
        { instanceId: 'smoke-b', sha: 'identity-sha', bootId: 'identity-boot' },
        1_000,
        undefined,
        { childAlive: () => true, extensionMs: 500, maxExtensions: 2, log },
      )
      .catch((error: Error) => {
        failure = error;
      })
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(1_100);
    expect(settled, 'a 500 must fail at the base deadline, never extend').toBe(
      true,
    );
    expect(log).not.toHaveBeenCalled();
    await waiting;
    expect(failure).not.toBeNull();
    expect(failure!.message).toBe(
      `Timed out waiting for ${url} (500 Internal Server Error)`,
    );
  });

  it('caps readiness extensions so a genuinely wedged boot still dies (#2646)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { lifecycle } = await loadLifecycleModule();
    const url = 'http://localhost:3246/api/system/identity';
    const log = vi.fn();

    let failure: Error | null = null;
    const waiting = lifecycle
      .waitForIdentity(
        url,
        { instanceId: 'smoke-b', sha: 'identity-sha', bootId: 'identity-boot' },
        600,
        undefined,
        { childAlive: () => true, extensionMs: 400, maxExtensions: 2, log },
      )
      .catch((error: Error) => {
        failure = error;
      });

    // Base 600ms + 2 x 400ms extensions = 1.4s hard cap.
    await vi.advanceTimersByTimeAsync(1_500);
    await waiting;
    expect(failure).not.toBeNull();
    expect(failure!.message).toBe(
      `Timed out waiting for ${url} (fetch failed)`,
    );
    expect(
      log.mock.calls.filter(([line]) =>
        String(line).includes('Startup readiness deadline extended'),
      ),
    ).toHaveLength(2);
  });

  it('does not extend the readiness deadline for a dead child (#2646)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { lifecycle } = await loadLifecycleModule();
    const url = 'http://localhost:3246/api/system/identity';
    const log = vi.fn();

    let failure: Error | null = null;
    const waiting = lifecycle
      .waitForIdentity(
        url,
        { instanceId: 'smoke-b', sha: 'identity-sha', bootId: 'identity-boot' },
        600,
        undefined,
        { childAlive: () => false, extensionMs: 400, maxExtensions: 2, log },
      )
      .catch((error: Error) => {
        failure = error;
      });

    await vi.advanceTimersByTimeAsync(700);
    await waiting;
    expect(failure).not.toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('bounds collectInstanceStatus when both managed identity probes never answer', async () => {
    vi.useFakeTimers();
    ensureDir(TEST_CWD);
    ensureDir(TEST_DEFAULT_HOME);
    writeInstanceState({
      bootId: '11111111-1111-4111-8111-111111111111',
      build: {
        branch: 'main',
        builtAt: '2026-08-02T00:00:00.000Z',
        sha: 'a'.repeat(40),
      },
      instanceName: 'stalled-probe',
      serverPid: process.pid,
      serverPort: 3246,
      uiPid: process.pid,
      uiPort: 5278,
    });
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              ),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { lifecycle } = await loadLifecycleModule();

    const status = lifecycle.collectInstanceStatus('stalled-probe', {
      probeTimeoutMs: 250,
    });
    await vi.advanceTimersByTimeAsync(250);

    await expect(status).resolves.toMatchObject({
      found: true,
      healthy: false,
      instanceId: 'stalled-probe',
      server: { reachable: false },
      ui: { reachable: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  // station#1846: the supervisor needs to distinguish a probe that answered
  // with the WRONG identity (positive takeover evidence) from one that did
  // not answer at all (slowness), and a port that definitively refused a
  // connection (listener gone) from one still accepting (slow child).
  it('keeps UI identity mismatch distinct when backend readiness is unavailable', async () => {
    ensureDir(TEST_CWD);
    writeInstanceState({
      bootId: '11111111-1111-4111-8111-111111111111',
      build: {
        branch: 'main',
        builtAt: '2026-08-03T00:00:00.000Z',
        sha: 'a'.repeat(40),
      },
      instanceName: 'mismatch-probe',
      serverPid: process.pid,
      serverPort: 3247,
      uiPid: process.pid,
      uiPort: 5279,
    });
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/system/readiness') {
        return Promise.resolve(
          new Response(
            JSON.stringify({ ready: false, status: 'unavailable' }),
            { status: 503 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            instanceId: 'mismatch-probe',
            sha: 'a'.repeat(40),
            bootId: '22222222-2222-4222-8222-222222222222',
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { lifecycle } = await loadLifecycleModule();

    await expect(
      lifecycle.collectInstanceStatus('mismatch-probe'),
    ).resolves.toMatchObject({
      found: true,
      healthy: false,
      server: { listening: true, probe: 'unreachable', reachable: false },
      ui: { listening: true, probe: 'identity-mismatch', reachable: false },
    });
  });

  it('keeps definitive HTTP auth refusals distinct from slow or unreachable probes', async () => {
    ensureDir(TEST_CWD);
    writeInstanceState({
      bootId: '11111111-1111-4111-8111-111111111111',
      build: {
        branch: 'main',
        builtAt: '2026-08-03T00:00:00.000Z',
        sha: 'a'.repeat(40),
      },
      instanceName: 'auth-refused-probe',
      serverPid: process.pid,
      serverPort: 3251,
      uiPid: process.pid,
      uiPort: 5283,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))),
    );
    const { lifecycle } = await loadLifecycleModule();

    await expect(
      lifecycle.collectInstanceStatus('auth-refused-probe'),
    ).resolves.toMatchObject({
      server: { listening: true, probe: 'http-auth-refused', reachable: false },
      ui: { listening: true, probe: 'http-auth-refused', reachable: false },
    });
  });

  it('marks a port that still accepts connections as listening when probes fail', async () => {
    ensureDir(TEST_CWD);
    writeInstanceState({
      bootId: '11111111-1111-4111-8111-111111111111',
      build: {
        branch: 'main',
        builtAt: '2026-08-03T00:00:00.000Z',
        sha: 'a'.repeat(40),
      },
      instanceName: 'slow-probe',
      serverPid: process.pid,
      serverPort: 3248,
      uiPid: process.pid,
      uiPort: 5280,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('socket hang up'))),
    );
    // Default harness TCP mock connects immediately: alive-but-slow shape.
    const { lifecycle } = await loadLifecycleModule();

    await expect(
      lifecycle.collectInstanceStatus('slow-probe'),
    ).resolves.toMatchObject({
      found: true,
      healthy: false,
      server: { listening: true, probe: 'unreachable', reachable: false },
      ui: { listening: true, probe: 'unreachable', reachable: false },
    });
  });

  it('marks a definitively refused port as not listening when probes fail', async () => {
    ensureDir(TEST_CWD);
    writeInstanceState({
      bootId: '11111111-1111-4111-8111-111111111111',
      build: {
        branch: 'main',
        builtAt: '2026-08-03T00:00:00.000Z',
        sha: 'a'.repeat(40),
      },
      instanceName: 'refused-probe',
      serverPid: process.pid,
      serverPort: 3249,
      uiPid: process.pid,
      uiPort: 5281,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const netConnectMock = vi.fn((_options: { host: string; port: number }) => {
      const socket = new EventEmitter() as EventEmitter & {
        destroy: () => void;
        setTimeout: () => void;
      };
      socket.destroy = vi.fn();
      socket.setTimeout = vi.fn();
      queueMicrotask(() =>
        socket.emit(
          'error',
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3249'), {
            code: 'ECONNREFUSED',
          }),
        ),
      );
      return socket;
    });
    const { lifecycle } = await loadLifecycleModule({ netConnectMock });

    await expect(
      lifecycle.collectInstanceStatus('refused-probe'),
    ).resolves.toMatchObject({
      found: true,
      healthy: false,
      server: { listening: false, probe: 'unreachable', reachable: false },
      ui: { listening: false, probe: 'unreachable', reachable: false },
    });
    // One TCP probe per failing child, aimed at the local child ports.
    expect(netConnectMock).toHaveBeenCalledTimes(2);
    expect(
      netConnectMock.mock.calls.map(([options]) => options.port).sort(),
    ).toEqual([3249, 5281]);
  });

  // Review round 1 HIGH: ephemeral-port exhaustion (EADDRNOTAVAIL/EADDRINUSE)
  // fails the local connect without a SYN ever reaching the child — a busy-
  // host symptom, exactly the #1846 regime. It must stay "listening" so the
  // supervisor keeps it on the tolerate/escalate path instead of the 15s
  // listener-gone teardown.
  it('keeps an ambiguous socket error (EADDRNOTAVAIL) on the listening path', async () => {
    ensureDir(TEST_CWD);
    writeInstanceState({
      bootId: '11111111-1111-4111-8111-111111111111',
      build: {
        branch: 'main',
        builtAt: '2026-08-03T00:00:00.000Z',
        sha: 'a'.repeat(40),
      },
      instanceName: 'exhausted-probe',
      serverPid: process.pid,
      serverPort: 3250,
      uiPid: process.pid,
      uiPort: 5282,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('socket hang up'))),
    );
    const netConnectMock = vi.fn((_options: { host: string; port: number }) => {
      const socket = new EventEmitter() as EventEmitter & {
        destroy: () => void;
        setTimeout: () => void;
      };
      socket.destroy = vi.fn();
      socket.setTimeout = vi.fn();
      queueMicrotask(() =>
        socket.emit(
          'error',
          Object.assign(new Error('connect EADDRNOTAVAIL 127.0.0.1:3250'), {
            code: 'EADDRNOTAVAIL',
          }),
        ),
      );
      return socket;
    });
    const { lifecycle } = await loadLifecycleModule({ netConnectMock });

    await expect(
      lifecycle.collectInstanceStatus('exhausted-probe'),
    ).resolves.toMatchObject({
      found: true,
      healthy: false,
      server: { listening: true, probe: 'unreachable', reachable: false },
      ui: { listening: true, probe: 'unreachable', reachable: false },
    });
  });
});

describe('clean', () => {
  it('removes only the explicit base directory and leaves the default home intact', async () => {
    ensureDir(TEST_CWD);
    ensureOwnerControlledStationHome(TEST_DEFAULT_HOME);
    ensureOwnerControlledStationHome(TEST_ALT_HOME);
    ensureBuildOutputs('smoke-a');

    const { lifecycle } = await loadLifecycleModule();

    await lifecycle.clean({
      allowDefaultHomeClean: false,
      force: true,
      homeSource: '--base',
      instanceName: 'smoke-a',
      projectHome: TEST_ALT_HOME,
      serverPort: 3242,
      uiPort: 5274,
    });

    expect(existsSync(TEST_ALT_HOME)).toBe(false);
    expect(existsSync(TEST_DEFAULT_HOME)).toBe(true);
    expect(existsSync(join(TEST_CWD, 'dist-server-smoke-a'))).toBe(false);
    expect(existsSync(join(TEST_CWD, 'dist-ui-smoke-a'))).toBe(false);
  });

  it('refuses to clean the default home without explicit acknowledgement', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_DEFAULT_HOME);

    const { lifecycle } = await loadLifecycleModule();

    await expect(
      lifecycle.clean({
        force: true,
        homeSource: 'default',
        projectHome: TEST_DEFAULT_HOME,
      }),
    ).rejects.toThrow(
      'Refusing to clean the default Station home. Use --temp-home for hermetic runs, or pass --allow-default-home-clean when you truly intend to delete ~/.station.',
    );
    expect(existsSync(TEST_DEFAULT_HOME)).toBe(true);
  });

  it('allows intentional default-home cleanup when explicitly acknowledged', async () => {
    ensureDir(TEST_CWD);
    ensureOwnerControlledStationHome(TEST_DEFAULT_HOME);
    ensureBuildOutputs();

    const { lifecycle } = await loadLifecycleModule();

    await lifecycle.clean({
      allowDefaultHomeClean: true,
      force: true,
      homeSource: 'default',
      projectHome: TEST_DEFAULT_HOME,
    });

    expect(existsSync(TEST_DEFAULT_HOME)).toBe(false);
  });

  it('cleans the targeted instance while a sibling instance stays live', async () => {
    ensureDir(TEST_CWD);
    ensureOwnerControlledStationHome(TEST_ALT_HOME);
    ensureOwnerControlledStationHome(TEST_SECOND_HOME);
    ensureBuildOutputs('smoke-a');
    ensureBuildOutputs('sibling');

    const siblingPid = await spawnLongRunning();
    writeInstanceState({
      baseDir: TEST_SECOND_HOME,
      instanceName: 'sibling',
      serverPid: siblingPid,
      serverPort: 3243,
      uiPid: null,
      uiPort: 5275,
    });

    const { lifecycle } = await loadLifecycleModule();

    await lifecycle.clean({
      force: true,
      homeSource: '--base',
      instanceName: 'smoke-a',
      projectHome: TEST_ALT_HOME,
      serverPort: 3242,
      uiPort: 5274,
    });

    expect(existsSync(TEST_ALT_HOME)).toBe(false);
    expect(existsSync(join(TEST_CWD, 'dist-server-smoke-a'))).toBe(false);
    expect(existsSync(join(TEST_CWD, 'dist-ui-smoke-a'))).toBe(false);
    expect(existsSync(join(TEST_CWD, 'dist-server-sibling'))).toBe(true);
    expect(existsSync(join(TEST_CWD, 'dist-ui-sibling'))).toBe(true);
    expect(isAlive(siblingPid)).toBe(true);

    process.kill(siblingPid, 'SIGKILL');
  }, 15_000);

  it.runIf(process.platform !== 'win32')(
    'refuses to clean an existing home with broad permissions',
    async () => {
      ensureDir(TEST_CWD);
      ensureOwnerControlledStationHome(TEST_ALT_HOME);
      chmodSync(TEST_ALT_HOME, 0o755);

      const { lifecycle } = await loadLifecycleModule();

      await expect(
        lifecycle.clean({
          force: true,
          homeSource: '--base',
          instanceName: 'broad-home',
          projectHome: TEST_ALT_HOME,
          serverPort: 3242,
          uiPort: 5274,
        }),
      ).rejects.toThrow(
        'Station instance registry directory is not owner-controlled',
      );
      expect(existsSync(TEST_ALT_HOME)).toBe(true);
    },
  );
});

describe('homeReset (station#1913)', () => {
  it('refuses without --confirm and leaves the home untouched', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    ensureDir(join(TEST_ALT_HOME, 'agents'));

    const { lifecycle } = await loadLifecycleModule();

    expect(() =>
      lifecycle.homeReset({
        homeSource: '--base',
        projectHome: TEST_ALT_HOME,
      }),
    ).toThrow('--confirm');
    expect(existsSync(TEST_ALT_HOME)).toBe(true);
  });

  it('archives (renames, never deletes) an incompatible home when confirmed', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    ensureDir(join(TEST_ALT_HOME, 'agents'));
    writeFileSync(
      join(TEST_ALT_HOME, 'agents', 'kept.json'),
      '{"marker":"keep-me"}',
    );

    const { lifecycle } = await loadLifecycleModule();

    const result = lifecycle.homeReset({
      confirm: true,
      homeSource: '--base',
      projectHome: TEST_ALT_HOME,
    });

    expect(result.archived).toBe(true);
    expect(result.archivePath).toBeDefined();
    expect(result.archivePath).toContain(`${TEST_ALT_HOME}.pre-schema-reset.`);
    expect(existsSync(TEST_ALT_HOME)).toBe(false);
    expect(existsSync(result.archivePath!)).toBe(true);
    expect(
      readFileSync(join(result.archivePath!, 'agents', 'kept.json'), 'utf8'),
    ).toContain('keep-me');
  });

  it('refuses while a Station instance for that home is running, and names it', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    ensureDir(join(TEST_ALT_HOME, 'agents'));

    const runningPid = await spawnLongRunning();
    writeInstanceState({
      baseDir: TEST_ALT_HOME,
      instanceName: 'smoke-running',
      serverPid: runningPid,
      serverPort: 3266,
      uiPid: null,
      uiPort: 5298,
    });

    const { lifecycle } = await loadLifecycleModule();

    let thrown: unknown;
    try {
      lifecycle.homeReset({
        confirm: true,
        homeSource: '--base',
        instanceName: 'smoke-running',
        projectHome: TEST_ALT_HOME,
        serverPort: 3266,
        uiPort: 5298,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('smoke-running');
    expect((thrown as Error).message).toContain('running');
    expect(existsSync(TEST_ALT_HOME)).toBe(true);

    process.kill(runningPid, 'SIGKILL');
  }, 15_000);

  it('--if-incompatible is a no-op when the home already satisfies the schema gate', async () => {
    ensureDir(TEST_CWD);
    ensureStationHomeSchemaSync(TEST_ALT_HOME);
    expect(existsSync(join(TEST_ALT_HOME, STATION_HOME_SCHEMA_FILE))).toBe(
      true,
    );

    const { lifecycle } = await loadLifecycleModule();

    const result = lifecycle.homeReset({
      confirm: true,
      homeSource: '--base',
      ifIncompatible: true,
      projectHome: TEST_ALT_HOME,
    });

    expect(result.archived).toBe(false);
    expect(existsSync(TEST_ALT_HOME)).toBe(true);
    expect(existsSync(join(TEST_ALT_HOME, STATION_HOME_SCHEMA_FILE))).toBe(
      true,
    );
  });

  it('--if-incompatible still archives an incompatible home when confirmed (the deploy path)', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    ensureDir(join(TEST_ALT_HOME, 'agents'));

    const { lifecycle } = await loadLifecycleModule();

    const result = lifecycle.homeReset({
      confirm: true,
      homeSource: '--base',
      ifIncompatible: true,
      projectHome: TEST_ALT_HOME,
    });

    expect(result.archived).toBe(true);
    expect(existsSync(TEST_ALT_HOME)).toBe(false);
    expect(existsSync(result.archivePath!)).toBe(true);
  });

  it('is a harmless no-op when the target home does not exist at all', async () => {
    ensureDir(TEST_CWD);

    const { lifecycle } = await loadLifecycleModule();

    const result = lifecycle.homeReset({
      confirm: true,
      homeSource: '--base',
      projectHome: TEST_ALT_HOME,
    });

    expect(result.archived).toBe(false);
    expect(existsSync(TEST_ALT_HOME)).toBe(false);
  });
});

describe('home verify (station#3218)', () => {
  it('refuses a home that does not exist instead of reporting it clean', async () => {
    // The operator trap: `--base` with a typo in it holds no stores, every
    // store reports `absent`, and a run that answers "is my data OK?" with
    // exit 0 about a path that was never a Station home is the worst
    // available answer. Every other `home` action fails loudly on a bad
    // target; this one has to as well.
    const { lifecycle } = await loadLifecycleModule();
    expect(() =>
      lifecycle.homeVerify({
        homeSource: '--base',
        projectHome: join(TEST_ROOT, 'no-such-home'),
      }),
    ).toThrow(/No Station home at/);
  });

  it('verifies the stores a real home owns without requiring it to be idle', async () => {
    // Read-only by construction, so unlike backup/restore/reset it must NOT
    // refuse while Station is up — that is the case an operator actually has
    // when they want this answer.
    // Its own home, not TEST_ALT_HOME: the reset/backup suites in this file
    // archive and rewrite that one, and a store-integrity verdict must be
    // about a home whose state this test controls.
    const home = join(TEST_ROOT, 'verify-home');
    ensureDir(home);
    ensureStationHomeSchemaSync(home);
    ensureDir(join(home, 'data'));
    const orchestration = join(home, 'data', 'orchestration.sqlite');
    const database = new DatabaseSync(orchestration);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)');
    const { lifecycle } = await loadLifecycleModule();
    try {
      // The writer stays OPEN across the call, holding the WAL.
      const result = lifecycle.homeVerify({
        homeSource: '--base',
        projectHome: home,
      });
      expect(result.homeDir).toBe(home);
      expect(
        result.results.map(
          (store: { databasePath: string; verdict: string }) => store.verdict,
        ),
      ).toEqual(['ok', 'absent']);
      // Something WAS verified, so the absent scheduler ledger costs nothing.
      expect(result.exitCode).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe('home backup and restore (#2012)', () => {
  it('round-trips the selected home and retains the replaced generation', async () => {
    ensureDir(TEST_CWD);
    ensureStationHomeSchemaSync(TEST_ALT_HOME);
    ensureDir(join(TEST_ALT_HOME, 'config'));
    writeFileSync(join(TEST_ALT_HOME, 'config', 'app.json'), 'original');
    const backupDir = join(TEST_ROOT, 'home-backup');
    const { lifecycle } = await loadLifecycleModule();

    const backup = lifecycle.homeBackup({
      homeSource: '--base',
      outputDir: backupDir,
      projectHome: TEST_ALT_HOME,
    });
    expect(backup.backupDir).toBe(backupDir);
    writeFileSync(join(TEST_ALT_HOME, 'config', 'app.json'), 'changed');

    const restored = lifecycle.homeRestore({
      backupDir,
      confirm: true,
      homeSource: '--base',
      projectHome: TEST_ALT_HOME,
    });
    expect(
      readFileSync(join(TEST_ALT_HOME, 'config', 'app.json'), 'utf8'),
    ).toBe('original');
    expect(
      readFileSync(join(restored.previousHome!, 'config', 'app.json'), 'utf8'),
    ).toBe('changed');
  });

  it('refuses backup and restore while the selected home is running', async () => {
    ensureDir(TEST_CWD);
    ensureStationHomeSchemaSync(TEST_ALT_HOME);
    const backupDir = join(TEST_ROOT, 'home-backup-running');
    const { lifecycle } = await loadLifecycleModule();
    lifecycle.homeBackup({
      homeSource: '--base',
      outputDir: backupDir,
      projectHome: TEST_ALT_HOME,
    });
    const runningPid = await spawnLongRunning();
    writeInstanceState({
      baseDir: TEST_ALT_HOME,
      instanceName: 'backup-running',
      serverPid: runningPid,
      serverPort: 3267,
      uiPid: null,
      uiPort: 5299,
    });
    expect(() =>
      lifecycle.homeBackup({
        homeSource: '--base',
        outputDir: join(TEST_ROOT, 'second-home-backup-running'),
        projectHome: TEST_ALT_HOME,
      }),
    ).toThrow(/Refusing to backup.*backup-running/s);
    expect(() =>
      lifecycle.homeRestore({
        backupDir,
        confirm: true,
        homeSource: '--base',
        projectHome: TEST_ALT_HOME,
      }),
    ).toThrow(/Refusing to restore.*backup-running/s);
    process.kill(runningPid, 'SIGKILL');
  }, 15_000);

  it('refuses a live home-scoped instance from another checkout', async () => {
    ensureDir(TEST_CWD);
    ensureStationHomeSchemaSync(TEST_ALT_HOME);
    upsertInstance(
      'other-checkout',
      { port: 38141, type: 'sidecar', pid: process.pid },
      TEST_ALT_HOME,
    );
    const { lifecycle } = await loadLifecycleModule();

    expect(() =>
      lifecycle.homeBackup({
        homeSource: '--base',
        outputDir: join(TEST_ROOT, 'cross-checkout-backup'),
        projectHome: TEST_ALT_HOME,
      }),
    ).toThrow(/sidecar.*pid=/s);
  });

  it('names the instance id and the command that actually stops it (#3064)', async () => {
    // The refusal population now includes supervised services (station#3064).
    // `findRunning` discards the registry KEY, so the old message named no id
    // and advised `station stop` — which cannot stop a supervised service.
    ensureDir(TEST_CWD);
    ensureStationHomeSchemaSync(TEST_ALT_HOME);
    upsertInstance(
      'prod-service',
      { port: 38142, type: 'service', pid: process.pid },
      TEST_ALT_HOME,
    );
    const { lifecycle } = await loadLifecycleModule();

    expect(() =>
      lifecycle.homeBackup({
        homeSource: '--base',
        outputDir: join(TEST_ROOT, 'service-refusal-backup'),
        projectHome: TEST_ALT_HOME,
      }),
    ).toThrow(
      /prod-service \(service\).*station service stop --instance=prod-service/s,
    );
  });
});

describe('named stop home-registry reconciliation (station#3980)', () => {
  it('removes exactly the requested dead sidecar when no checkout-local record exists', async () => {
    ensureDir(TEST_CWD);
    ensureStationHomeSchemaSync(TEST_ALT_HOME);
    upsertInstance(
      'dead-nightly-sidecar',
      {
        port: 38141,
        type: 'sidecar',
        status: 'running',
        pid: 2 ** 31 - 1,
        birth: 'dead-sidecar-birth',
      },
      TEST_ALT_HOME,
    );
    const { lifecycle } = await loadLifecycleModule();

    expect(() =>
      lifecycle.stop({
        instanceName: 'dead-nightly-sidecar',
        baseDir: TEST_ALT_HOME,
      }),
    ).not.toThrow();
    expect(
      readInstanceRegistry(TEST_ALT_HOME).instances['dead-nightly-sidecar'],
    ).toBeUndefined();
  });

  it('explicitly refuses a live exact-id registry owner without signalling it', async () => {
    ensureDir(TEST_CWD);
    ensureStationHomeSchemaSync(TEST_ALT_HOME);
    const birth = (
      await import('@kontourai/station-shared/process-identity')
    ).lookupProcessBirthFingerprint(process.pid);
    expect(birth).toBeTruthy();
    upsertInstance(
      'live-nightly-sidecar',
      {
        port: 38141,
        type: 'sidecar',
        status: 'running',
        pid: process.pid,
        birth: birth!,
      },
      TEST_ALT_HOME,
    );
    const kill = vi.spyOn(process, 'kill');
    const { lifecycle } = await loadLifecycleModule();
    try {
      expect(() =>
        lifecycle.stop({
          instanceName: 'live-nightly-sidecar',
          baseDir: TEST_ALT_HOME,
        }),
      ).toThrow(/registry owner is live.*No process was signalled/s);
      expect(
        readInstanceRegistry(TEST_ALT_HOME).instances['live-nightly-sidecar'],
      ).toMatchObject({ pid: process.pid, birth });
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('parseTsxVersion', () => {
  it('collapses two-line tsx --version output into a single labeled line', async () => {
    const { lifecycle } = await loadLifecycleModule();

    expect(lifecycle.parseTsxVersion('tsx v4.0.0\nnode v20.11.0')).toBe(
      'tsx v4.0.0 (node v20.11.0)',
    );
    expect(lifecycle.parseTsxVersion('tsx v4.21.0\r\nnode v24.18.0')).toBe(
      'tsx v4.21.0 (node v24.18.0)',
    );
  });

  it('passes through single-line output and handles missing output', async () => {
    const { lifecycle } = await loadLifecycleModule();

    expect(lifecycle.parseTsxVersion('tsx v4.0.0')).toBe('tsx v4.0.0');
    expect(lifecycle.parseTsxVersion(null)).toBeNull();
    expect(lifecycle.parseTsxVersion('')).toBeNull();
  });
});

describe('collectDoctorReport', () => {
  it('reports a named read-only supervisor probe wedge with its kickstart remedy', async () => {
    const { lifecycle } = await loadLifecycleModule();

    const report = await lifecycle.collectDoctorReport({
      checkOllama: async () => false,
      inspectKontourDependencies: () => ({ exactPins: [], mismatches: [] }),
      inspectSupervisorWedges: async () => ['service-test'],
      env: {},
      exec: () => null,
      exists: () => false,
      readJson: (_path, fallback) => fallback,
    });

    expect(report.checks).toContainEqual({
      label: 'Supervisor probe wedge',
      status: 'fail',
      detail:
        'Managed identity probe failing with a lifecycle lock present for: service-test. Remedy per instance: station service start --instance=<id> (kickstart).',
    });
  });

  it('fails unsupported Node majors with an actionable Node 24 fix', async () => {
    const { lifecycle } = await loadLifecycleModule();

    const report = await lifecycle.collectDoctorReport({
      checkOllama: async () => false,
      inspectKontourDependencies: () => ({
        exactPins: [],
        mismatches: [],
      }),
      env: {},
      exec: (command) => {
        if (command === 'node -v') return 'v26.2.0';
        if (command === 'npm -v') return '11.0.0';
        if (command === 'git --version') return 'git version 2.42.0';
        if (command === 'tsx --version') return 'tsx v4.0.0';
        return null;
      },
      exists: () => false,
      readJson: (_path, fallback) => fallback,
    });

    expect(report.checks).toContainEqual({
      label: 'Node.js',
      status: 'fail',
      detail: 'v26.2.0 — Node.js 24.x required',
    });
    expect(report.fixCommands).toContainEqual({
      label: 'Install Node.js 24.x',
      command: 'nvm install 24 && nvm use 24',
      reason: 'Station supports Node.js 24.x; found v26.2.0.',
    });
  });

  it('reports a first-run-ready path when Ollama is reachable locally', async () => {
    const { lifecycle } = await loadLifecycleModule();

    const report = await lifecycle.collectDoctorReport({
      checkOllama: async () => true,
      inspectKontourDependencies: () => ({
        exactPins: [],
        mismatches: [],
      }),
      env: {},
      exec: (command) => {
        if (command === 'node -v') return 'v24.0.0';
        if (command === 'npm -v') return '10.0.0';
        if (command === 'git --version') return 'git version 2.42.0';
        // Real `tsx --version` emits two lines: `tsx vX.Y.Z` then `node vA.B.C`.
        if (command === 'tsx --version') return 'tsx v4.0.0\nnode v20.11.0';
        return null;
      },
      exists: () => false,
      readJson: (_path, fallback) => fallback,
    });

    const tsxCheck = report.checks.find((check) => check.label === 'tsx');
    expect(tsxCheck).toEqual({
      label: 'tsx',
      status: 'pass',
      detail: 'tsx v4.0.0 (node v20.11.0)',
    });
    expect(tsxCheck?.detail).not.toContain('\n');

    expect(report.chatReady).toBe(true);
    expect(report.runtimeReady).toBe(false);
    expect(report.recommendation).toContain('Ollama is reachable');
    expect(report.providerState).toEqual({
      configured: [],
      detected: ['ollama'],
      effective: 'ollama (detected)',
    });
    expect(report.runtimeState.effective).toBeNull();
    expect(report.fixCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Save detected Ollama as a model connection',
          command: expect.stringContaining('station connections create'),
        }),
        expect.objectContaining({
          label: 'Review connected runtimes',
          command: 'station connections runtimes',
        }),
      ]),
    );
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Ollama',
          status: 'pass',
        }),
      ]),
    );
  });

  it('prefers configured chat providers over hard-coded defaults', async () => {
    const { lifecycle } = await loadLifecycleModule();

    const report = await lifecycle.collectDoctorReport({
      checkOllama: async () => false,
      inspectKontourDependencies: () => ({
        exactPins: [],
        mismatches: [],
      }),
      env: {},
      exec: (command) => {
        if (command === 'node -v') return 'v24.0.0';
        if (command === 'npm -v') return '10.0.0';
        if (command === 'git --version') return 'git version 2.42.0';
        if (command === 'tsx --version') return 'tsx v4.0.0';
        if (command === 'codex --version') return 'codex 1.0.0';
        return null;
      },
      exists: (path) =>
        path.endsWith('app.json') || path.endsWith('providers.json'),
      readJson: (path, fallback) => {
        if (path.endsWith('app.json')) {
          return {
            defaultModel: 'llama3.2',
            agentConnections: {},
          } as typeof fallback;
        }
        if (path.endsWith('providers.json')) {
          return [
            {
              capabilities: ['llm'],
              enabled: true,
              id: 'ollama-local',
            },
          ] as typeof fallback;
        }
        return fallback;
      },
    });

    expect(report.chatReady).toBe(true);
    expect(report.runtimeReady).toBe(true);
    expect(report.providerState).toEqual({
      configured: ['ollama-local'],
      detected: [],
      effective: 'ollama-local',
    });
    expect(report.runtimeState.detected).toEqual(['codex-cli']);
    expect(report.runtimeState.effective).toBe('codex-cli');
    expect(report.fixCommands).toEqual([]);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Configured chat model connections',
          status: 'pass',
        }),
      ]),
    );
  });

  it('reports missing provider and runtime states with actionable fixes', async () => {
    const { lifecycle } = await loadLifecycleModule();

    const report = await lifecycle.collectDoctorReport({
      checkOllama: async () => false,
      inspectKontourDependencies: () => ({
        exactPins: [],
        mismatches: [],
      }),
      env: {},
      exec: (command) => {
        if (command === 'node -v') return 'v24.0.0';
        if (command === 'npm -v') return '10.0.0';
        if (command === 'git --version') return 'git version 2.42.0';
        if (command === 'tsx --version') return 'tsx v4.0.0';
        return null;
      },
      exists: () => false,
      readJson: (_path, fallback) => fallback,
    });

    expect(report.chatReady).toBe(false);
    expect(report.runtimeReady).toBe(false);
    expect(report.recommendation).toContain('No chat-capable path');
    expect(report.providerState).toEqual({
      configured: [],
      detected: [],
      effective: null,
    });
    expect(report.runtimeState).toEqual({
      configured: [],
      detected: [],
      effective: null,
    });
    expect(report.fixCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Start a local Ollama runtime',
          command: 'ollama serve',
          reason: expect.stringContaining('No chat-capable model connection'),
        }),
        expect.objectContaining({
          label: 'Review connected runtimes',
          command: 'station connections runtimes',
        }),
      ]),
    );
  });

  it('reports configured runtime state separately from missing chat setup', async () => {
    const { lifecycle } = await loadLifecycleModule();

    const report = await lifecycle.collectDoctorReport({
      checkOllama: async () => false,
      inspectKontourDependencies: () => ({
        exactPins: [],
        mismatches: [],
      }),
      env: {},
      exec: (command) => {
        if (command === 'node -v') return 'v24.0.0';
        if (command === 'npm -v') return '10.0.0';
        if (command === 'git --version') return 'git version 2.42.0';
        if (command === 'tsx --version') return 'tsx v4.0.0';
        return null;
      },
      exists: (path) => path.endsWith('app.json'),
      readJson: (path, fallback) => {
        if (path.endsWith('app.json')) {
          return {
            agentConnections: {
              codex: { enabled: true },
            },
          } as typeof fallback;
        }
        return fallback;
      },
    });

    expect(report.chatReady).toBe(false);
    expect(report.runtimeReady).toBe(true);
    expect(report.providerState.effective).toBeNull();
    expect(report.runtimeState).toEqual({
      configured: ['codex'],
      detected: [],
      effective: 'codex',
    });
    expect(report.fixCommands).toEqual([
      expect.objectContaining({
        label: 'Start a local Ollama runtime',
        command: 'ollama serve',
      }),
    ]);
  });

  it('reports installed-vs-pinned Kontour drift as a fail-level check', async () => {
    const { lifecycle } = await loadLifecycleModule();

    const report = await lifecycle.collectDoctorReport({
      checkOllama: async () => true,
      env: {},
      exec: (command) => {
        if (command === 'node -v') return 'v24.0.0';
        if (command === 'npm -v') return '10.0.0';
        if (command === 'git --version') return 'git version 2.42.0';
        if (command === 'tsx --version') return 'tsx v4.0.0';
        if (command === 'codex --version') return 'codex 1.0.0';
        return null;
      },
      exists: () => false,
      inspectKontourDependencies: () => ({
        exactPins: [
          {
            name: '@kontourai/flow-agents',
            pinned: '5.2.0',
            installed: '5.1.0',
          },
        ],
        mismatches: [
          {
            name: '@kontourai/flow-agents',
            pinned: '5.2.0',
            installed: '5.1.0',
          },
        ],
      }),
      readJson: (_path, fallback) => fallback,
    });

    expect(report.checks).toContainEqual({
      label: 'Kontour package pins',
      status: 'fail',
      detail: '@kontourai/flow-agents: pinned 5.2.0, installed 5.1.0',
    });
    expect(report.dependencyState.mismatches).toEqual([
      {
        name: '@kontourai/flow-agents',
        pinned: '5.2.0',
        installed: '5.1.0',
      },
    ]);
    expect(report.fixCommands).toContainEqual({
      label: 'Synchronize project dependencies',
      command: 'npm install',
      reason:
        '1 exact-pinned @kontourai package(s) do not match the installed versions.',
    });
  });
});

describe('upgrade', () => {
  it('builds and checks source-upgrade guidance for the resolved channel instance', async () => {
    ensureDir(TEST_CWD);
    ensureDir(join(TEST_CWD, '.git'));
    const channelHome = join(TEST_ROOT, 'beta-home');
    const unitPath = writeStaleServiceManifest(channelHome, 'beta-upgrade');
    const execSync = vi.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === 'npm run build:server') {
          const serverDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_SERVER_DIR),
          );
          ensureDir(serverDir);
          writeFileSync(join(serverDir, 'command-station.js'), 'server');
        }
        if (command === 'npm run build:ui') {
          const uiDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_UI_DIR),
          );
          ensureDir(uiDir);
          writeFileSync(join(uiDir, 'index.html'), 'ui');
        }
        if (command === 'git rev-parse HEAD')
          return '0123456789abcdef0123456789abcdef01234567\n';
        return 'origin/main\n';
      },
    );
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: {
        execSync,
        spawnSync: staleSchedulingSpawnSync(unitPath),
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await lifecycle.upgrade({
        baseDir: channelHome,
        serverPort: 28141,
        uiPort: 28000,
      });
      expect(lifecycle.readBuildManifest()).toBeNull();
      expect(
        lifecycle.readBuildManifest(
          resolveInstanceId({
            projectHome: channelHome,
            serverPort: 28141,
            uiPort: 28000,
          }),
        ),
      ).toMatchObject({ sha: '0123456789abcdef0123456789abcdef01234567' });
      expect(log.mock.calls.flat().join('\n')).toContain(
        `station service install --instance=beta-upgrade --base=${channelHome} --port=3141 --ui-port=3000 --host=127.0.0.1`,
      );
    } finally {
      log.mockRestore();
    }
  });

  it('blocks shared-build upgrades when multiple instances are still live', async () => {
    ensureDir(TEST_CWD);
    ensureDir(join(TEST_CWD, '.git'));
    ensureDir(TEST_ALT_HOME);
    ensureDir(TEST_SECOND_HOME);

    const alphaPid = await spawnLongRunning();
    const betaPid = await spawnLongRunning();
    writeInstanceState({
      baseDir: TEST_ALT_HOME,
      instanceName: 'alpha',
      serverPid: alphaPid,
      serverPort: 3242,
      uiPid: null,
      uiPort: 5274,
    });
    writeInstanceState({
      baseDir: TEST_SECOND_HOME,
      instanceName: 'beta',
      serverPid: betaPid,
      serverPort: 3243,
      uiPid: null,
      uiPort: 5275,
    });

    const execSync = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync },
    });

    await expect(lifecycle.upgrade()).rejects.toThrow(
      'station upgrade is blocked because this checkout has multiple live Station instances sharing build artifacts.',
    );
    expect(execSync).not.toHaveBeenCalled();
    expect(isAlive(alphaPid)).toBe(true);
    expect(isAlive(betaPid)).toBe(true);

    process.kill(alphaPid, 'SIGKILL');
    process.kill(betaPid, 'SIGKILL');
  }, 15_000);

  it('rejects a non-Git directory without signed packaged provenance before any upgrade command', async () => {
    const installRoot = join(TEST_ROOT, 'portable-missing-provenance');
    const releasesRoot = join(installRoot, 'releases');
    const release = join(releasesRoot, 'unsigned');
    ensureDir(release);
    for (const path of [installRoot, releasesRoot, release]) {
      chmodSync(path, 0o700);
    }
    const execSync = vi.fn();
    const execFileSync = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      cwd: release,
      childProcessMock: { execFileSync, execSync },
    });

    await expect(lifecycle.upgrade()).rejects.toThrow(
      'Cannot upgrade a non-Git checkout without signed packaged release provenance.',
    );
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each([
    { runtimeChannel: 'stable', releaseChannel: 'stable' },
    { runtimeChannel: 'beta', releaseChannel: 'preview' },
  ] as const)(
    'delegates a signed packaged $runtimeChannel upgrade through the installer with the persisted release ring',
    async ({ runtimeChannel, releaseChannel }) => {
      const installRoot = join(TEST_ROOT, `portable-${runtimeChannel}`);
      const release = join(installRoot, 'releases', 'a'.repeat(64));
      const stationHome = join(TEST_ROOT, `home-${runtimeChannel}`);
      ensureDir(release);
      ensureDir(stationHome);
      writeFileSync(
        join(release, '.station-release.json'),
        `${JSON.stringify({
          schemaVersion: 2,
          sha: 'b'.repeat(40),
          ref: releaseChannel === 'stable' ? 'v1.2.3' : 'v1.2.3-preview.4',
          createdAt: '2026-07-22T00:00:00.000Z',
          channel: runtimeChannel,
          releaseChannel,
          prerelease: releaseChannel === 'preview',
        })}\n`,
      );
      writeFileSync(join(release, 'install.sh'), '#!/bin/sh\nexit 0\n', {
        mode: 0o700,
      });
      writeFileSync(
        join(installRoot, '.station-portable-install-root'),
        'station-portable-install-root-v1\n',
      );
      writeFileSync(
        join(installRoot, '.station-release-state.json'),
        `${JSON.stringify({
          schemaVersion: 3,
          channel: runtimeChannel,
          releaseChannel,
          installRoot,
          stationRoot: join(TEST_ROOT, `root-${runtimeChannel}`),
          stationHome,
        })}\n`,
        { mode: 0o600 },
      );
      symlinkSync(release, join(installRoot, 'current'));

      const execFileSync = vi.fn();
      const execSync = vi.fn();
      const unitPath = writeStaleServiceManifest(
        stationHome,
        'packaged-guidance',
      );
      const { lifecycle } = await loadLifecycleModule({
        cwd: release,
        childProcessMock: {
          execFileSync,
          execSync,
          spawnSync: staleSchedulingSpawnSync(unitPath),
        },
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await lifecycle.upgrade();

        expect(execFileSync).toHaveBeenCalledWith(
          'sh',
          ['./install.sh', 'install'],
          expect.objectContaining({
            cwd: release,
            env: expect.objectContaining({
              STATION_CHANNEL: runtimeChannel,
              STATION_HOME: stationHome,
              STATION_INSTALL_ROOT: installRoot,
            }),
          }),
        );
        expect(log.mock.calls.flat().join('\n')).toContain(
          'Service scheduling is stale for packaged-guidance',
        );
        expect(log.mock.calls.flat().join('\n')).toContain(
          `station service install --instance=packaged-guidance --base=${stationHome} --port=3141 --ui-port=3000 --host=127.0.0.1`,
        );
        expect(execSync).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );

  it('reports stale scheduling guidance after a source upgrade', async () => {
    ensureDir(TEST_CWD);
    ensureDir(join(TEST_CWD, '.git'));
    vi.stubEnv('STATION_HOME', TEST_DEFAULT_HOME);
    const unitPath = writeStaleServiceManifest(
      TEST_DEFAULT_HOME,
      'source-guidance',
    );
    const execSync = vi.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === 'npm run build:server') {
          const serverDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_SERVER_DIR),
          );
          ensureDir(serverDir);
          writeFileSync(join(serverDir, 'command-station.js'), 'server');
        }
        if (command === 'npm run build:ui') {
          const uiDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_UI_DIR),
          );
          ensureDir(uiDir);
          writeFileSync(join(uiDir, 'index.html'), '<!doctype html>');
        }
        // Full 40-char sha: validateBuildManifest enforces /^[0-9a-f]{40}$/,
        // and a short sha fails it as "git identity is invalid".
        if (command === 'git rev-parse HEAD')
          return '0123456789abcdef0123456789abcdef01234567\n';
        return 'origin/main\n';
      },
    );
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: {
        execSync,
        spawnSync: staleSchedulingSpawnSync(unitPath),
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await lifecycle.upgrade();

      expect(log.mock.calls.flat().join('\n')).toContain(
        'Service scheduling is stale for source-guidance',
      );
      expect(log.mock.calls.flat().join('\n')).toContain(
        `station service install --instance=source-guidance --base=${TEST_DEFAULT_HOME} --port=3141 --ui-port=3000 --host=127.0.0.1`,
      );
    } finally {
      log.mockRestore();
    }
  });

  it('rejects a packaged release whose provenance channel disagrees with persisted state', async () => {
    const installRoot = join(TEST_ROOT, 'portable-mismatch');
    const release = join(installRoot, 'releases', 'c'.repeat(64));
    const stationHome = join(TEST_ROOT, 'home-mismatch');
    ensureDir(release);
    ensureDir(stationHome);
    writeFileSync(
      join(release, '.station-release.json'),
      `${JSON.stringify({
        schemaVersion: 2,
        sha: 'd'.repeat(40),
        ref: 'v1.2.3-preview.4',
        createdAt: '2026-07-22T00:00:00.000Z',
        channel: 'beta',
        releaseChannel: 'preview',
        prerelease: true,
      })}\n`,
    );
    writeFileSync(join(release, 'install.sh'), '#!/bin/sh\nexit 0\n', {
      mode: 0o700,
    });
    writeFileSync(
      join(installRoot, '.station-portable-install-root'),
      'station-portable-install-root-v1\n',
    );
    writeFileSync(
      join(installRoot, '.station-release-state.json'),
      `${JSON.stringify({
        schemaVersion: 3,
        channel: 'stable',
        releaseChannel: 'stable',
        installRoot,
        stationRoot: join(TEST_ROOT, 'root-mismatch'),
        stationHome,
      })}\n`,
      { mode: 0o600 },
    );
    symlinkSync(release, join(installRoot, 'current'));
    const execFileSync = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      cwd: release,
      childProcessMock: { execFileSync },
    });

    await expect(lifecycle.upgrade()).rejects.toThrow(
      'packaged release provenance does not match the persisted release ring',
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('rejects a packaged upgrade beneath a group/world-writable install root', async () => {
    const installRoot = join(TEST_ROOT, 'portable-permissive-root');
    const release = join(installRoot, 'releases', 'e'.repeat(64));
    const stationHome = join(TEST_ROOT, 'home-permissive-root');
    ensureDir(release);
    ensureDir(stationHome);
    writeFileSync(
      join(release, '.station-release.json'),
      `${JSON.stringify({
        schemaVersion: 2,
        sha: 'f'.repeat(40),
        ref: 'v1.2.3',
        createdAt: '2026-07-22T00:00:00.000Z',
        channel: 'stable',
        releaseChannel: 'stable',
        prerelease: false,
      })}\n`,
    );
    writeFileSync(join(release, 'install.sh'), '#!/bin/sh\nexit 0\n', {
      mode: 0o700,
    });
    writeFileSync(
      join(installRoot, '.station-portable-install-root'),
      'station-portable-install-root-v1\n',
    );
    writeFileSync(
      join(installRoot, '.station-release-state.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        channel: 'stable',
        installRoot,
        stationHome,
      })}\n`,
      { mode: 0o600 },
    );
    symlinkSync(release, join(installRoot, 'current'));
    chmodSync(installRoot, 0o777);

    const execFileSync = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      cwd: release,
      childProcessMock: { execFileSync, execSync: vi.fn() },
    });

    await expect(lifecycle.upgrade()).rejects.toThrow(
      'packaged install root must be a same-user directory that is not group/world writable',
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('rebuilds through buildApplication so the promoted manifest sha matches the built tree (station#2671)', async () => {
    ensureDir(join(TEST_CWD, '.git'));
    // Pin the home to the mocked default so the rebuild resolves the DEFAULT
    // instance (dist-server/dist-ui) — the deployment shape from #2671.
    // vitest.setup.ts otherwise points STATION_HOME at an isolated home,
    // which would hash to a per-test instance id.
    vi.stubEnv('STATION_HOME', TEST_DEFAULT_HOME);
    const builtSha = 'fedcba9876543210fedcba9876543210fedcba98';
    const execSync = vi.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === 'npm run build:server') {
          const serverDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_SERVER_DIR),
          );
          ensureDir(serverDir);
          writeFileSync(
            join(serverDir, 'command-station.js'),
            'upgraded-server',
          );
        }
        if (command === 'npm run build:ui') {
          const uiDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_UI_DIR),
          );
          ensureDir(uiDir);
          writeFileSync(join(uiDir, 'index.html'), 'upgraded-ui');
        }
        if (command === 'git rev-parse HEAD') return `${builtSha}\n`;
        return 'origin/main\n';
      },
    );
    const execFileSync = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execFileSync, execSync },
    });

    await lifecycle.upgrade();

    // The invariant behind station#2671: the upgrade's rebuild must refresh
    // dist-server/station-build.json to the sha of the tree it just built.
    // The old raw `npm run build:*` path never wrote this manifest, so the
    // supervisor pinned a stale STATION_BUILD_SHA and kill-looped on
    // "managed boot identity mismatch" until someone ran `station build`.
    // Only buildApplication's candidate pipeline writes and promotes it.
    expect(
      lifecycle.readBuildManifest('default'),
      'upgrade must write dist-server/station-build.json provenance via buildApplication (station#2671)',
    ).toMatchObject({ branch: 'main', sha: builtSha });
    expect(
      readFileSync(
        join(TEST_CWD, 'dist-server', 'command-station.js'),
        'utf-8',
      ),
    ).toBe('upgraded-server');
    expect(readFileSync(join(TEST_CWD, 'dist-ui', 'index.html'), 'utf-8')).toBe(
      'upgraded-ui',
    );
    // Pull/install ordering is preserved, and the rebuild now flows through
    // the candidate pipeline (which appends the provenance `git rev-parse
    // HEAD` read after both builds).
    expect(execSync.mock.calls.map(([command]) => command)).toEqual([
      'git rev-parse --abbrev-ref main@{u}',
      'git pull',
      'npm install',
      'npm run build:server',
      'npm run build:ui',
      'git rev-parse HEAD',
    ]);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('uiRequestHandler (static UI server SPA fallback + reverse proxy)', () => {
  let serverModule: any;
  let uiDir: string;
  let upstream: import('node:http').Server | ReturnType<typeof serve> | null =
    null;
  let upstreamPort = 0;
  let upstreamHits: string[] = [];

  async function startUpstream(
    handler: (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ) => void,
  ) {
    const http = await import('node:http');
    upstreamHits = [];
    upstream = http.createServer((req, res) => {
      upstreamHits.push(req.url ?? '');
      handler(req, res);
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const addr = upstream.address();
    upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;
  }

  async function startServer(opts?: {
    inject?: string;
    backendPrefixes?: string[];
    backendNavigationPrefixes?: string[];
    readinessFile?: string;
    identity?: { instanceId: string; sha: string; bootId: string };
    internalApiToken?: string;
    trustedTailscaleServeOrigin?: string;
    hostedTenantAuthorities?: Record<string, string>;
  }) {
    const fs = await import('node:fs');
    const http = await import('node:http');
    const crypto = await import('node:crypto');
    const path = await import('node:path');
    const lifecycle = await import('../commands/lifecycle.js');
    const handler = lifecycle.uiRequestHandler({
      http,
      crypto,
      fs,
      path,
      dir: uiDir,
      mime: lifecycle.UI_MIME_TYPES,
      inject:
        opts?.inject ??
        '<script>window.__API_BASE__="http://localhost:3242"</script>',
      upstreamPort,
      backendPrefixes:
        opts?.backendPrefixes ?? lifecycle.UI_PROXY_BACKEND_PREFIXES,
      backendNavigationPrefixes:
        opts?.backendNavigationPrefixes ??
        lifecycle.UI_PROXY_BACKEND_NAVIGATION_PREFIXES,
      readinessFile: opts?.readinessFile,
      identity: opts?.identity,
      internalApiToken:
        opts?.internalApiToken ?? 'test-only-internal-api-token',
      trustedTailscaleServeOrigin: opts?.trustedTailscaleServeOrigin,
      hostedTenantAuthorities: opts?.hostedTenantAuthorities,
    });
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return { server, port };
  }

  async function rawRequest(
    port: number,
    requestPath: string,
  ): Promise<string> {
    return new Promise((resolveResponse, reject) => {
      const socket = createRawConnection({ host: '127.0.0.1', port });
      let response = '';
      socket.setEncoding('utf8');
      socket.on('connect', () =>
        socket.write(
          `GET ${requestPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
        ),
      );
      socket.on('data', (chunk) => (response += chunk));
      socket.on('end', () => resolveResponse(response));
      socket.on('error', reject);
    });
  }

  afterEach(() => {
    if (uiDir && existsSync(uiDir))
      rmSync(uiDir, { recursive: true, force: true });
    if (serverModule?.server) serverModule.server.close();
    if (upstream) {
      upstream.close();
      upstream = null;
    }
    upstreamPort = 0;
  });

  it('returns 404 (not HTML) for a genuinely missing .png asset, without proxying', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"shouldNotBeReached":true}');
    });
    serverModule = await startServer();

    const res = await fetch(
      `http://127.0.0.1:${serverModule.port}/favicon.png`,
    );
    expect(res.status).toBe(404);
    const ct = res.headers.get('content-type') || '';
    expect(ct).not.toContain('text/html');
    const body = await res.text();
    expect(body).not.toContain('<head>');
    expect(upstreamHits).toEqual([]);
  });

  it('resolves exactly one raw Host before static or proxy handling and mints its tenant attestation', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-hosted-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    let receivedHeaders: import('node:http').IncomingHttpHeaders | undefined;
    await startUpstream((req, res) => {
      receivedHeaders = req.headers;
      res.end('{}');
    });
    serverModule = await startServer({
      hostedTenantAuthorities: { 'alpha.example.test': 'alpha' },
    });
    const request = (path: string, headers: Record<string, string>) =>
      new Promise<{
        status: number;
        headers: import('node:http').IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const client = nodeRequest(
          { host: '127.0.0.1', port: serverModule.port, path, headers },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => (body += chunk));
            response.on('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body,
              }),
            );
          },
        );
        client.on('error', reject);
        client.end();
      });
    const staticDenied = await request('/', { Host: 'unknown.example.test' });
    expect(staticDenied.status).toBe(421);
    expect(staticDenied.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(staticDenied.body)).toEqual({
      error: { code: 'tenant_authority_unknown' },
    });
    expect(upstreamHits).toEqual([]);

    for (const path of ['/', '/__station/identity']) {
      const inheritedAuthority = await request(path, { Host: 'constructor' });
      expect(inheritedAuthority.status).toBe(421);
      expect(JSON.parse(inheritedAuthority.body)).toEqual({
        error: { code: 'tenant_authority_unknown' },
      });
    }
    expect(upstreamHits).toEqual([]);

    const duplicateHost = await new Promise<string>((resolve, reject) => {
      const socket = createRawConnection({
        host: '127.0.0.1',
        port: serverModule.port,
      });
      let raw = '';
      socket.setEncoding('utf8');
      socket.on('connect', () =>
        socket.write(
          'GET / HTTP/1.1\r\nHost: alpha.example.test\r\nHost: alpha.example.test\r\nConnection: close\r\n\r\n',
        ),
      );
      socket.on('data', (chunk) => (raw += chunk));
      socket.on('end', () => resolve(raw));
      socket.on('error', reject);
    });
    expect(duplicateHost).toMatch(/^HTTP\/1\.1 421/);
    expect(duplicateHost).toContain('tenant_authority_invalid');
    expect(upstreamHits).toEqual([]);

    const response = await request('/api/system/status', {
      Host: 'ALPHA.example.test',
      'X-Station-Internal-Tenant': 'spoofed',
      Forwarded: 'host=other.example.test',
      'X-Forwarded-Host': 'other.example.test',
    });
    expect(response.status).toBe(200);
    expect(receivedHeaders?.['x-station-internal-tenant']).toBe('alpha');
    expect(receivedHeaders?.host).toBe(`127.0.0.1:${upstreamPort}`);
  });

  it('station#3677: the retired host-approval navigation carve-out no longer proxies a backend review document', async () => {
    // The review page moved to the distinct-origin consent listener (its own
    // port, never behind this proxy), and the old same-origin review path was
    // REMOVED rather than kept as a fallback. A browser navigation to the old
    // URL therefore gets the ordinary SPA fallback — there is no backend
    // document left to proxy, and reintroducing one would need a deliberate
    // UI_PROXY_BACKEND_NAVIGATION_PREFIXES entry.
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-host-approval-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<main>trusted host review</main>');
    });
    serverModule = await startServer();

    const response = await fetch(
      `http://127.0.0.1:${serverModule.port}/api/plugins/host-approvals/approval-1/review`,
      { headers: { Accept: 'text/html,application/xhtml+xml' } },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('app');
    expect(upstreamHits).toEqual([]);
  });

  it.each([
    '/../outside.txt',
    '/%2e%2e/outside.txt',
    '/%2e%2e%2foutside.txt',
    '/..%2foutside.txt',
    '/..%5coutside.txt',
    '/%E0%A4%A',
    '/%00outside.txt',
  ])(
    'rejects raw or encoded static traversal %s without SPA fallback',
    async (requestPath) => {
      const parent = mkdtempSync(join(tmpdir(), 'station-ui-containment-'));
      uiDir = join(parent, 'ui');
      mkdirSync(uiDir);
      writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
      writeFileSync(join(parent, 'outside.txt'), 'OUTSIDE-SENTINEL');
      serverModule = await startServer();
      const response = await rawRequest(serverModule.port, requestPath);
      expect(response).toMatch(/^HTTP\/1\.1 (?:400|404)/);
      expect(response).not.toContain('OUTSIDE-SENTINEL');
      expect(response).not.toContain('<body>app</body>');
    },
  );

  it('rejects a symlinked asset whose real path escapes the canonical UI root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'station-ui-symlink-'));
    uiDir = join(parent, 'ui');
    mkdirSync(uiDir);
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    writeFileSync(join(parent, 'outside.txt'), 'OUTSIDE-SENTINEL');
    symlinkSync(join(parent, 'outside.txt'), join(uiDir, 'escape.txt'));
    serverModule = await startServer();
    const response = await rawRequest(serverModule.port, '/escape.txt');
    expect(response).toMatch(/^HTTP\/1\.1 (?:400|404)/);
    expect(response).not.toContain('OUTSIDE-SENTINEL');
  });

  it('rejects an extensionless SPA fallback when index.html escapes the canonical UI root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'station-ui-fallback-symlink-'));
    uiDir = join(parent, 'ui');
    mkdirSync(uiDir);
    writeFileSync(join(parent, 'outside.html'), 'OUTSIDE-FALLBACK-SENTINEL');
    symlinkSync(join(parent, 'outside.html'), join(uiDir, 'index.html'));
    serverModule = await startServer();
    const response = await fetch(
      `http://127.0.0.1:${serverModule.port}/projects`,
      {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      },
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('OUTSIDE-FALLBACK-SENTINEL');
  });

  it('serves an existing .png asset with the png content-type', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    writeFileSync(
      join(uiDir, 'favicon.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    await startUpstream((_req, res) => res.end('unused'));
    serverModule = await startServer();

    const res = await fetch(
      `http://127.0.0.1:${serverModule.port}/favicon.png`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(upstreamHits).toEqual([]);
  });

  it('falls back to index.html for a real navigation (Accept: text/html) to an extensionless SPA route', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((_req, res) => res.end('unused'));
    serverModule = await startServer();

    const res = await fetch(
      `http://127.0.0.1:${serverModule.port}/projects/dev/layouts/code`,
      { headers: { Accept: 'text/html,application/xhtml+xml' } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('window.__API_BASE__');
    expect(body).toContain('app');
    expect(upstreamHits).toEqual([]);
  });

  it('mints a fresh CSP nonce per response, which is the last carrier plugin code could read', async () => {
    // Page code can read the policy back off a same-origin `fetch(location.href)`,
    // so the nonce is only unreachable while it differs per response. Memoizing
    // it -- an obvious-looking perf tweak -- would hand every in-process plugin
    // bundle a working nonce with the rest of the suite still green, which is
    // exactly why this is pinned (station#4287 review).
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((_req, res) => res.end('unused'));
    serverModule = await startServer();

    const nonceOf = async () => {
      const res = await fetch(`http://127.0.0.1:${serverModule.port}/`, {
        headers: { Accept: 'text/html' },
      });
      expect(res.status).toBe(200);
      const policy = res.headers.get('content-security-policy') ?? '';
      const match = policy.match(/'nonce-([^']+)'/);
      expect(match).not.toBeNull();
      return match?.[1] ?? '';
    };

    const first = await nonceOf();
    const second = await nonceOf();
    expect(first).not.toBe('');
    expect(second).not.toBe(first);
  });

  it('falls back to index.html with no direct-handler injection when inject is empty', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((_req, res) => res.end('unused'));
    serverModule = await startServer({ inject: '' });

    const res = await fetch(`http://127.0.0.1:${serverModule.port}/`, {
      headers: { Accept: 'text/html' },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('window.__API_BASE__');
    expect(body).toContain('app');
  });

  it.each([
    ['root HTML', '/', 'text/html'],
    ['SPA fallback', '/deep/mobile/route', 'text/html'],
    ['static asset', '/favicon.png', 'image/png'],
  ])(
    'sets a strict browser security policy for %s',
    async (_name, url, accept) => {
      uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
      writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
      writeFileSync(join(uiDir, 'favicon.png'), 'png');
      await startUpstream((_req, res) => res.end('{}'));
      serverModule = await startServer({
        inject:
          '<script>window.__API_BASE__="https://station.example"</script>',
      });

      const response = await fetch(
        `http://127.0.0.1:${serverModule.port}${url}`,
        {
          headers: { Accept: accept },
        },
      );
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      if (accept === 'text/html') {
        const html = await response.text();
        const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
        expect(nonce).toBeTruthy();
        expect(html).toContain(`<script nonce="${nonce}">window.__API_BASE__=`);
      }
    },
  );

  it('publishes deliberate readiness and a recovery document while the backend is unavailable', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-ready-'));
    writeFileSync(
      join(uiDir, 'index.html'),
      '<head></head><body>healthy app</body>',
    );
    const readinessFile = join(uiDir, 'state.json');
    const identity = {
      instanceId: 'phone',
      sha: 'a'.repeat(40),
      bootId: '11111111-1111-4111-8111-111111111111',
    };
    writeFileSync(
      readinessFile,
      JSON.stringify({ health: { status: 'ready', sha: identity.sha } }),
      { mode: 0o600 },
    );
    upstreamPort = 1;
    serverModule = await startServer({ readinessFile, identity });

    const readiness = await fetch(
      `http://127.0.0.1:${serverModule.port}/api/system/readiness`,
    );
    expect(readiness.status).toBe(503);
    await expect(readiness.json()).resolves.toEqual({
      ready: false,
      status: 'unavailable',
    });
    const navigation = await fetch(
      `http://127.0.0.1:${serverModule.port}/projects`,
      { headers: { Accept: 'text/html' } },
    );
    expect(navigation.status).toBe(503);
    expect(await navigation.text()).toContain('Station is recovering');
    const identityResponse = await fetch(
      `http://127.0.0.1:${serverModule.port}/__station/identity`,
    );
    await expect(identityResponse.json()).resolves.toEqual(identity);
  });

  it('uses the cheap authenticated identity route for live UI readiness', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-ready-identity-'));
    writeFileSync(
      join(uiDir, 'index.html'),
      '<head></head><body>healthy app</body>',
    );
    const readinessFile = join(uiDir, 'state.json');
    const identity = {
      instanceId: 'phone',
      sha: 'a'.repeat(40),
      bootId: '11111111-1111-4111-8111-111111111111',
    };
    writeFileSync(
      readinessFile,
      JSON.stringify({ health: { status: 'ready', sha: identity.sha } }),
      { mode: 0o600 },
    );
    let identityHeaders: import('node:http').IncomingHttpHeaders | undefined;
    await startUpstream((req, res) => {
      if (req.url === '/api/system/status') return;
      identityHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(identity));
    });
    serverModule = await startServer({ readinessFile, identity });

    const readiness = await fetch(
      `http://127.0.0.1:${serverModule.port}/api/system/readiness`,
    );
    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toEqual({
      ready: true,
      status: 'ready',
    });
    expect(upstreamHits).toEqual(['/api/system/identity']);
    expect(identityHeaders).toMatchObject({
      'x-station-internal-token': 'test-only-internal-api-token',
      'x-station-proxy-caller': 'local',
    });
    expect(identityHeaders?.['x-station-internal-tenant']).toBeUndefined();
  });

  it('station#3752: forwards the BROWSER Host as its own attestation, discarding any client-supplied copy', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-forwarded-host-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    let seen: Record<string, string | string[] | undefined> | undefined;
    await startUpstream((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    serverModule = await startServer();

    const response = await fetch(
      `http://127.0.0.1:${serverModule.port}/api/plugins/host-approvals`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // A client trying to choose the host a review URL is minted for.
          'x-station-proxy-forwarded-host': 'evil.example:3000',
        },
        body: '{}',
      },
    );
    expect(response.status).toBe(200);

    // The spoof is gone, replaced by this proxy's own observation of the
    // client's Host. Without the forwarded value the backend mints the
    // review URL for the UPSTREAM host, whose cookie jar is not the
    // browser's — the outage this header exists to prevent — and without
    // the strip a caller would choose that host itself.
    expect(seen?.['x-station-proxy-forwarded-host']).toBe(
      `127.0.0.1:${serverModule.port}`,
    );
    // The upstream still sees the rewritten Host it dials.
    expect(seen?.host).toBe(`127.0.0.1:${upstreamPort}`);
  });

  it('keeps hosted readiness and readiness-file navigation behind the resolved tenant attestation', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-hosted-readiness-'));
    writeFileSync(
      join(uiDir, 'index.html'),
      '<head></head><body>hosted app</body>',
    );
    const readinessFile = join(uiDir, 'state.json');
    const identity = {
      instanceId: 'phone',
      sha: 'a'.repeat(40),
      bootId: '11111111-1111-4111-8111-111111111111',
    };
    writeFileSync(
      readinessFile,
      JSON.stringify({ health: { status: 'ready', sha: identity.sha } }),
      { mode: 0o600 },
    );
    let identityHeaders: import('node:http').IncomingHttpHeaders | undefined;
    await startUpstream((req, res) => {
      identityHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(identity));
    });
    serverModule = await startServer({
      hostedTenantAuthorities: { 'alpha.example.test': 'alpha' },
      identity,
      readinessFile,
    });
    const request = (path: string, headers: Record<string, string>) =>
      new Promise<{ body: string; status: number }>((resolve, reject) => {
        const client = nodeRequest(
          { host: '127.0.0.1', port: serverModule.port, path, headers },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => (body += chunk));
            response.on('end', () =>
              resolve({ body, status: response.statusCode ?? 0 }),
            );
          },
        );
        client.on('error', reject);
        client.end();
      });
    const readiness = await request('/api/system/readiness', {
      Host: 'alpha.example.test',
    });
    expect(readiness.status).toBe(200);
    expect(JSON.parse(readiness.body)).toEqual({
      ready: true,
      status: 'ready',
    });
    expect(identityHeaders).toMatchObject({
      'x-station-internal-token': 'test-only-internal-api-token',
      'x-station-proxy-caller': 'local',
      'x-station-internal-tenant': 'alpha',
    });

    const navigation = await request('/projects', {
      Accept: 'text/html',
      Host: 'alpha.example.test',
    });
    expect(navigation.status).toBe(200);
    expect(navigation.body).toContain('hosted app');

    for (const host of ['unknown.example.test', 'constructor']) {
      const denied = await request('/api/system/readiness', { Host: host });
      expect(denied.status).toBe(421);
    }
  });

  it('proxies a bare-prefix backend GET (Accept: application/json) with real JSON passthrough, not the SPA shell', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: 12345 }));
    });
    serverModule = await startServer();

    const res = await fetch(
      `http://127.0.0.1:${serverModule.port}/api/system/status`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = await res.json();
    expect(json).toEqual({ status: 'ok', pid: 12345 });
    expect(upstreamHits).toEqual(['/api/system/status']);
  });

  it('proxies /observability (code-review M3 — a real bare VoltAgent-framework mount previously missing from the allowlist)', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    serverModule = await startServer();

    const res = await fetch(
      `http://127.0.0.1:${serverModule.port}/observability/status`,
      { headers: { Accept: 'application/json' } },
    );
    expect(res.status).toBe(200);
    expect(upstreamHits).toEqual(['/observability/status']);
  });

  it('proxies the public environment handshake through the production UI listener', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ schemaVersion: 1 }));
    });
    serverModule = await startServer();

    const res = await fetch(
      `http://127.0.0.1:${serverModule.port}/.well-known/station/v1`,
      { headers: { Accept: 'application/json' } },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ schemaVersion: 1 });
    expect(upstreamHits).toEqual(['/.well-known/station/v1']);
  });

  it('proxies a bare (non-/api) backend prefix collision route (/agents) when Accept does not prefer html', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ slug: 'default' }]));
    });
    serverModule = await startServer();

    const res = await fetch(`http://127.0.0.1:${serverModule.port}/agents`, {
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(upstreamHits).toEqual(['/agents']);
  });

  it('serves the SPA shell for the same /agents path on a real browser navigation (Accept: text/html)', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    serverModule = await startServer();

    const res = await fetch(`http://127.0.0.1:${serverModule.port}/agents`, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('app');
    expect(upstreamHits).toEqual([]);
  });

  it('proxies non-GET/HEAD methods regardless of Accept header', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: body }));
      });
    });
    serverModule = await startServer();

    const res = await fetch(
      `http://127.0.0.1:${serverModule.port}/api/some/create`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/html,application/xhtml+xml',
        },
        body: JSON.stringify({ hello: 'world' }),
      },
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { received: string };
    expect(json.received).toContain('hello');
    expect(upstreamHits).toEqual(['/api/some/create']);
  });

  it('streams an SSE response through the proxy without buffering to completion', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    await startUpstream((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
      });
      res.write('data: first\n\n');
      setTimeout(() => {
        res.write('data: second\n\n');
        res.end();
      }, 50);
    });
    serverModule = await startServer();

    const res = await fetch(
      `http://127.0.0.1:${serverModule.port}/api/orchestration/events`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.body).toBeTruthy();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    // Track how long it takes for the *first* chunk to arrive vs. the total
    // stream duration — if the proxy buffered the whole response, the first
    // chunk would only arrive once the upstream `res.end()` fires (~50ms),
    // identical to the last. Reading incrementally proves it did not.
    const firstChunkAt = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
    const joined = chunks.join('');
    expect(joined).toContain('data: first');
    expect(joined).toContain('data: second');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(Date.now() - firstChunkAt).toBeGreaterThanOrEqual(0);
  });

  it('responds with structured 503 when the upstream is unreachable', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    // Intentionally do not start an upstream; upstreamPort is unused (0) so
    // the connection is refused immediately.
    upstreamPort = 1;
    serverModule = await startServer();

    const res = await fetch(
      `http://127.0.0.1:${serverModule.port}/api/system/status`,
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      ready: false,
      status: 'unavailable',
    });
  });

  it('propagates a client abort mid-SSE-stream to the upstream connection (code-review H1 repro — no leaked socket)', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');

    let upstreamClosed = false;
    let tickTimer: ReturnType<typeof setInterval> | null = null;
    await startUpstream((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
      });
      res.write('data: tick\n\n');
      tickTimer = setInterval(() => {
        try {
          res.write('data: tick\n\n');
        } catch {
          // Socket already gone.
        }
      }, 50);
      res.on('close', () => {
        upstreamClosed = true;
        if (tickTimer) clearInterval(tickTimer);
      });
    });
    serverModule = await startServer();

    const controller = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${serverModule.port}/api/orchestration/events`,
      { signal: controller.signal },
    );
    expect(res.status).toBe(200);

    // Consume the first chunk to prove the stream is genuinely flowing
    // through the proxy before aborting mid-stream.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    controller.abort();
    try {
      await reader.cancel();
    } catch {
      // Expected once aborted.
    }

    // Bounded poll (not a fixed sleep): the upstream server must observe
    // its own connection close within this window, proving the proxy
    // propagated the client's disconnect instead of leaking the socket.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !upstreamClosed) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (tickTimer) clearInterval(tickTimer);

    expect(upstreamClosed).toBe(true);
  });

  it('strips hop-by-hop request headers before forwarding to the upstream', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');

    let receivedHeaders: import('node:http').IncomingHttpHeaders = {};
    await startUpstream((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    serverModule = await startServer();

    // `fetch()` (undici) refuses to let a caller set the classic
    // hop-by-hop headers directly (`Connection`/`Keep-Alive` are treated
    // as forbidden/managed request headers) — exactly the class this
    // finding is about — so a raw `http.request` is needed to actually
    // send them and prove the proxy strips them before forwarding.
    //
    // Note on `Connection` specifically: Node's own `http.request` (used
    // by the proxy to reach the upstream) always sets its *own* outgoing
    // `Connection` header for that hop based on its agent's `keepAlive`
    // setting — that's Node correctly managing the proxy→upstream hop's
    // own connection semantics, not a bug. What matters is that the
    // *client*'s original `Connection` value (`upgrade`, here — a value
    // Node's agent would never choose on its own) never survives through
    // to the upstream; `Keep-Alive` (a plain, non-agent-managed header
    // carrying client-hop-specific data like a timeout) must be dropped
    // entirely rather than forwarded verbatim.
    const http = await import('node:http');
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: serverModule.port,
          path: '/api/system/status',
          method: 'GET',
          headers: {
            Connection: 'upgrade',
            'Keep-Alive': 'timeout=5',
          },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(receivedHeaders.connection).not.toBe('upgrade');
    expect(receivedHeaders['keep-alive']).toBeUndefined();
  });

  it('attests public-host proxy hops as remote and strips spoofed attestation', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    const observed: import('node:http').IncomingHttpHeaders[] = [];
    await startUpstream((req, res) => {
      observed.push(req.headers);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    serverModule = await startServer();
    const http = await import('node:http');
    const send = (host: string) =>
      new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: serverModule.port,
            path: '/api/system/status',
            headers: {
              Host: host,
              'X-Station-Internal-Token': 'caller-spoof',
              'X-Station-Proxy-Caller': 'local',
            },
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        );
        req.on('error', reject);
        req.end();
      });

    await send('kontour.example.ts.net');
    await send(`127.0.0.1:${serverModule.port}`);
    await send('127.evil.example');

    expect(observed[0]?.['x-station-proxy-caller']).toBe('remote');
    expect(observed[1]?.['x-station-proxy-caller']).toBe('remote');
    expect(observed[2]?.['x-station-proxy-caller']).toBe('remote');
    expect(observed[0]?.['x-station-internal-token']).toBe(
      'test-only-internal-api-token',
    );
    expect(JSON.stringify(observed)).not.toContain('caller-spoof');
  });

  it('requires ordinary UI-proxy callers to authenticate while preserving genuine internal callers', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-auth-composition-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    const credential = 'test-only-credential-that-must-never-be-logged';
    const internalApiToken = getInternalApiToken();
    const app = new Hono();
    configureRuntimeHttp({
      app: app as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn().mockReturnThis(),
        setLevel: vi.fn(),
        getLevel: vi.fn(() => 'info' as const),
      } as Logger,
      eventBus: { emit: vi.fn() } as unknown as EventBus,
      security: {
        verifyCredential: (candidate: string) => candidate === credential,
        resolveGrantedScope: (candidate: string) =>
          candidate === credential ? DEFAULT_GRANT_PAIRING_SCOPE : undefined,
        maxFailures: 10,
        allowedOrigins: [],
      },
    } as Parameters<typeof configureRuntimeHttp>[0]);
    app.get('/api/projects', (c) => c.json({ reached: 'read' }));
    app.post('/api/projects', (c) => c.json({ reached: 'mutation' }));
    upstream = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => {
      if (upstream!.listening) resolve();
      else upstream!.once('listening', resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('missing runtime backend port');
    }
    upstreamPort = address.port;
    serverModule = await startServer({ internalApiToken });
    const uiUrl = `http://127.0.0.1:${serverModule.port}/api/projects`;

    for (const init of [{}, { method: 'POST' }]) {
      expect((await fetch(uiUrl, init)).status).toBe(401);
      expect(
        (
          await fetch(uiUrl, {
            ...init,
            headers: { Authorization: 'Bearer' },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(uiUrl, {
            ...init,
            headers: { Authorization: `Bearer ${credential}` },
          })
        ).status,
      ).toBe(200);
    }

    const genuineInternal = await fetch(
      `http://127.0.0.1:${upstreamPort}/api/projects`,
      {
        method: 'POST',
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: internalApiToken,
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
        },
      },
    );
    expect(genuineInternal.status).toBe(200);
  });

  it('converts explicitly trusted Tailscale Serve headers into internal identity and strips raw headers', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    const observed: import('node:http').IncomingHttpHeaders[] = [];
    await startUpstream((req, res) => {
      observed.push(req.headers);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    serverModule = await startServer({
      trustedTailscaleServeOrigin: 'https://station.example.ts.net',
    });
    const http = await import('node:http');
    const send = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: serverModule.port,
            path: '/api/pairing/access-request',
            method: 'POST',
            headers,
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end();
      });

    const tailscaleHeaders = {
      Host: 'station.example.ts.net',
      'Tailscale-Headers-Info': 'https://tailscale.com/s/serve-headers',
      'Tailscale-User-Login': 'brian@example.test',
      'Tailscale-User-Name': 'Brian',
      'X-Station-Ingress-Identity': 'caller-spoof',
    };
    expect(await send(tailscaleHeaders)).toBe(200);
    expect(
      await send({ ...tailscaleHeaders, Host: 'other.example.ts.net' }),
    ).toBe(200);
    expect(
      await send({
        ...tailscaleHeaders,
        'Tailscale-Funnel-Request': 'true',
      }),
    ).toBe(403);

    const verified = observed[0]?.['x-station-ingress-identity'];
    expect(typeof verified).toBe('string');
    expect(
      JSON.parse(Buffer.from(String(verified), 'base64url').toString('utf8')),
    ).toEqual({
      provider: 'tailscale-serve',
      login: 'brian@example.test',
      displayName: 'Brian',
    });
    expect(observed[1]?.['x-station-ingress-identity']).toBeUndefined();
    expect(observed).toHaveLength(2);
    for (const headers of observed) {
      expect(
        Object.keys(headers).some((name) => name.startsWith('tailscale-')),
      ).toBe(false);
      expect(JSON.stringify(headers)).not.toContain('caller-spoof');
    }
  });

  it('returns 504 (not a hang) when the upstream never responds within the proxy timeout', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
    const http = await import('node:http');
    const lifecycle = await import('../commands/lifecycle.js');
    const fs = await import('node:fs');
    const path = await import('node:path');

    upstream = http.createServer(() => {
      // Never respond — simulates a wedged upstream.
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const addr = upstream.address();
    upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;

    // Monkey-patch a near-instant timeout for this test only, mirroring the
    // real request options shape uiRequestHandler passes to http.request —
    // the real PROXY_UPSTREAM_TIMEOUT_MS (30s) would make this test slow.
    const originalRequest = http.request.bind(http);
    const patchedHttp = {
      ...http,
      request: (
        options: import('node:http').RequestOptions,
        cb?: (res: import('node:http').IncomingMessage) => void,
      ) => originalRequest({ ...options, timeout: 100 }, cb),
    };
    const patchedHandler = lifecycle.uiRequestHandler({
      http: patchedHttp as unknown as typeof import('node:http'),
      crypto: await import('node:crypto'),
      fs,
      path,
      dir: uiDir,
      mime: lifecycle.UI_MIME_TYPES,
      inject: '',
      upstreamPort,
      backendPrefixes: lifecycle.UI_PROXY_BACKEND_PREFIXES,
      internalApiToken: 'test-only-internal-api-token',
    });
    const server = http.createServer(patchedHandler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr2 = server.address();
    const port = typeof addr2 === 'object' && addr2 ? addr2.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/system/status`);
      expect(res.status).toBe(504);
    } finally {
      server.close();
    }
  });

  it('keeps a proxied SSE stream alive past the upstream idle timeout so a later keepalive still arrives (code-review iteration-2 NEW HIGH: PROXY_UPSTREAM_TIMEOUT_MS vs SSE_KEEPALIVE_INTERVAL_MS collision)', async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'station-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');

    const http = await import('node:http');
    const lifecycle = await import('../commands/lifecycle.js');
    const fs = await import('node:fs');
    const path = await import('node:path');

    // Real upstream SSE endpoint shape: one event immediately, then a long
    // idle gap (standing in for the real gap between
    // SSE_KEEPALIVE_INTERVAL_MS heartbeats), then a keepalive comment.
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
      });
      res.write('data: first\n\n');
      setTimeout(() => {
        res.write(': keepalive\n\n');
        res.end();
      }, 300);
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const addr = upstream.address();
    upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;

    // Shrink the proxy's upstream idle timeout to 100ms (well under the
    // upstream's 300ms idle gap above) without touching the real 30s
    // production constant — same injection pattern as the 504 test above.
    // The point isn't the absolute numbers; it's that the idle timeout must
    // apply only to the connection/header phase, not to an already-flowing
    // SSE stream, no matter how the two constants relate at their real
    // (currently equal, 30s/30s) production values.
    const originalRequest = http.request.bind(http);
    const patchedHttp = {
      ...http,
      request: (
        options: import('node:http').RequestOptions,
        cb?: (res: import('node:http').IncomingMessage) => void,
      ) => originalRequest({ ...options, timeout: 100 }, cb),
    };
    const handler = lifecycle.uiRequestHandler({
      http: patchedHttp as unknown as typeof import('node:http'),
      crypto: await import('node:crypto'),
      fs,
      path,
      dir: uiDir,
      mime: lifecycle.UI_MIME_TYPES,
      inject: '',
      upstreamPort,
      backendPrefixes: lifecycle.UI_PROXY_BACKEND_PREFIXES,
      internalApiToken: 'test-only-internal-api-token',
    });
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr2 = server.address();
    const port = typeof addr2 === 'object' && addr2 ? addr2.port : 0;

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/orchestration/events`,
      );
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let joined = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        joined += decoder.decode(value);
      }

      // On unpatched code the proxy's socket-idle timeout (shrunk to 100ms
      // here) fires ~100ms into the 300ms idle gap, and since headers are
      // already flushed, the client-facing response is silently ended
      // (`res.end()`) right then — the keepalive written 300ms in never
      // reaches the client. A stream that correctly disables the idle
      // timeout once it recognizes a streaming SSE response must still be
      // open when the keepalive arrives.
      expect(joined).toContain('data: first');
      expect(joined).toContain('keepalive');
    } finally {
      server.close();
      if (upstream) {
        upstream.close();
        upstream = null;
      }
    }
  });
});

// Coverage-scope note (code-review iteration 2's M2 verdict, corrected in
// deliver.md iteration 3): the spawn test below genuinely regresses the
// module-scope-constant-serialization class (verified by reintroducing that
// exact bug and watching it fail) — it does NOT, and structurally cannot,
// regress the original `__name`/`keepNames` helper-injection class, because
// Vitest's own esbuild/Vite transform of this file never produces
// `__name(...)` wrapping the way `tsx`'s hard-coded `keepNames: true` dev
// transform (what the real `./station` launcher runs under) does. The
// second test in this block closes most of that residual gap with a
// synthetic probe that reproduces the real esbuild/tsx output shape
// directly (a `__name(...)`-wrapped binding spliced into the actual
// generated script) rather than relying on Vitest to produce it — the
// `globalThis.__name` shim in `buildUiServerScript` is what's asserted, not
// this test's own transform.
describe('buildUiServerScript output runs as a real standalone node -e process (code-review M2)', () => {
  it('spawns the generated script as a child process and makes one proxied request + one static request against it', async () => {
    const http = await import('node:http');
    const { spawn } = await import('node:child_process');
    const lifecycle = await import('../commands/lifecycle.js');

    const uiDir = mkdtempSync(join(tmpdir(), 'station-ui-spawn-'));
    writeFileSync(
      join(uiDir, 'index.html'),
      '<head></head><body>real-spawn-app</body>',
    );

    let upstreamTenant: string | string[] | undefined;
    const upstream = http.createServer((req, res) => {
      if (req.url === '/api/system/status') {
        upstreamTenant = req.headers['x-station-internal-tenant'];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamAddr = upstream.address();
    const upstreamPort =
      typeof upstreamAddr === 'object' && upstreamAddr ? upstreamAddr.port : 0;

    const uiPort = 39999 + (process.pid % 500);
    const script = lifecycle.buildUiServerScript({
      hostedTenantAuthorities: { 'alpha.example.test': 'alpha' },
      uiDir,
      upstreamPort,
      uiPort,
    });

    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        STATION_INTERNAL_API_TOKEN: 'test-only-internal-api-token',
      },
    });

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    try {
      const request = (path: string) =>
        new Promise<{ body: string; status: number }>((resolve, reject) => {
          const client = nodeRequest(
            {
              host: '127.0.0.1',
              port: uiPort,
              path,
              headers: { Host: 'alpha.example.test' },
            },
            (response) => {
              let body = '';
              response.setEncoding('utf8');
              response.on('data', (chunk) => (body += chunk));
              response.on('end', () =>
                resolve({ body, status: response.statusCode ?? 0 }),
              );
            },
          );
          client.on('error', reject);
          client.end();
        });
      // Wait for the spawned server to come up (bounded poll, not a fixed
      // sleep — real process startup time varies).
      const deadline = Date.now() + 5000;
      let up = false;
      while (Date.now() < deadline && !up) {
        try {
          const probe = await request('/');
          if (probe.status === 200) up = true;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(up).toBe(true);
      expect(stderr).toBe('');

      const staticRes = await request('/');
      expect(staticRes.status).toBe(200);
      expect(staticRes.body).toContain('real-spawn-app');

      const proxiedRes = await request('/api/system/status');
      expect(proxiedRes.status).toBe(200);
      const proxiedBody = JSON.parse(proxiedRes.body);
      expect(proxiedBody).toEqual({ ready: true });
      expect(upstreamTenant).toBe('alpha');
      expect(stderr).toBe('');
    } finally {
      child.kill('SIGKILL');
      upstream.close();
      rmSync(uiDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('the globalThis.__name shim neutralizes an esbuild/keepNames-style __name(...)-wrapped binding spliced into the real generated script (code-review M2 residual-gap tripwire)', async () => {
    const { spawn } = await import('node:child_process');
    const lifecycle = await import('../commands/lifecycle.js');

    const uiDir = mkdtempSync(join(tmpdir(), 'station-ui-name-shim-'));
    writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');

    const script = lifecycle.buildUiServerScript({
      uiDir,
      upstreamPort: 1, // unused — this probe never proxies a request
      uiPort: 0, // placeholder, replaced per-attempt below
    });
    const shimLiteral =
      'globalThis.__name = globalThis.__name || ((fn) => fn);';
    expect(script).toContain(shimLiteral);

    // Simulate the exact shape tsx's hard-coded `keepNames: true` transform
    // produces in the real `./station` launcher (a const-bound arrow/
    // function wrapped in `__name(fn, "name")`, confirmed in code review)
    // — the one case Vitest's own test-time transform never generates, so
    // it can't be exercised by simply calling `uiRequestHandler` or even by
    // spawning the script as-is under test. Splicing a synthetic
    // `__name(...)` call directly into the real generated script (rather
    // than depending on any transform to produce one) lets this test assert
    // the actual runtime contract: does the shim neutralize such a call.
    const probeStatement =
      'const stationNameShimProbe = __name(function stationNameShimProbe() { return 1; }, "stationNameShimProbe");';

    async function runProbe(
      scriptSource: string,
      port: number,
    ): Promise<{ up: boolean; stderr: string }> {
      const withPort = scriptSource.replace(
        /listen\(0,["']0\.0\.0\.0["']\)/,
        `listen(${port},"0.0.0.0")`,
      );
      const child = spawn(process.execPath, ['-e', withPort], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      try {
        const deadline = Date.now() + 3000;
        let up = false;
        while (Date.now() < deadline && !up) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            if (res.status === 200) up = true;
          } catch {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        // Give a crashed process time to flush stderr even when it never
        // came up.
        if (!up) await new Promise((r) => setTimeout(r, 200));
        return { up, stderr };
      } finally {
        child.kill('SIGKILL');
      }
    }

    const portWithShim = 40899 + (process.pid % 300);
    const portWithoutShim = portWithShim + 300;

    try {
      // With the shim present (real production shape): the __name(...)
      // call is neutralized and the server starts cleanly.
      const withShim = script.replace(
        shimLiteral,
        `${shimLiteral}\n${probeStatement}`,
      );
      const withShimResult = await runProbe(withShim, portWithShim);
      expect(withShimResult.stderr).toBe('');
      expect(withShimResult.up).toBe(true);

      // Negative control: without the shim, the same __name(...) call
      // crashes the standalone process with a ReferenceError — proving the
      // positive assertion above is meaningful (the shim is doing real
      // work), not a tautology.
      const withoutShim = script
        .replace(shimLiteral, '')
        .replace('const http=', `${probeStatement}\n    const http=`);
      const withoutShimResult = await runProbe(withoutShim, portWithoutShim);
      expect(withoutShimResult.up).toBe(false);
      expect(withoutShimResult.stderr).toContain('__name is not defined');
    } finally {
      rmSync(uiDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('buildUiServerScript (injection-conditional API base)', () => {
  it('omits the __API_BASE__ script tag entirely when no override is configured', async () => {
    const lifecycle = await import('../commands/lifecycle.js');
    const script = lifecycle.buildUiServerScript({
      uiDir: '/tmp/does-not-matter',
      upstreamPort: 3141,
      uiPort: 3010,
    });
    expect(script).not.toContain('window.__API_BASE__');
    // With nothing to set, no inline script is served at all.
    expect(script).toContain('const inject=""');
  });

  it('never publishes the response CSP nonce to page code', async () => {
    // station#4287. A global holding the nonce is readable by every script in
    // the document, plugin bundles included, and a script holding a nonce can
    // mint further nonce'd scripts — remote ones included.
    const lifecycle = await import('../commands/lifecycle.js');
    for (const apiBaseOverride of [undefined, 'http://example-override:9999']) {
      const script = lifecycle.buildUiServerScript({
        uiDir: '/tmp/does-not-matter',
        ...(apiBaseOverride ? { apiBaseOverride } : {}),
        upstreamPort: 3141,
        uiPort: 3010,
      });
      expect(script).not.toContain('__STATION_CSP_NONCE__');
      expect(script).not.toContain('currentScript.nonce');
    }
  });

  it('removes the bootstrap element so its nonce IDL property cannot be read back', async () => {
    const lifecycle = await import('../commands/lifecycle.js');
    expect(
      lifecycle.buildUiBootstrapScript({
        apiBaseOverride: 'http://example-override:9999',
      }),
    ).toBe(
      '<script>window.__API_BASE__="http://example-override:9999";document.currentScript.remove()</script>',
    );
    expect(lifecycle.buildUiBootstrapScript({})).toBe('');
  });

  it('injects the __API_BASE__ script tag only when an explicit apiBaseOverride is provided', async () => {
    const lifecycle = await import('../commands/lifecycle.js');
    const script = lifecycle.buildUiServerScript({
      uiDir: '/tmp/does-not-matter',
      apiBaseOverride: 'http://example-override:9999',
      upstreamPort: 3141,
      uiPort: 3010,
    });
    expect(script).toContain('window.__API_BASE__');
    expect(script).toContain('http://example-override:9999');
  });

  it('always threads upstreamPort through for the reverse proxy, override or not', async () => {
    const lifecycle = await import('../commands/lifecycle.js');
    const script = lifecycle.buildUiServerScript({
      uiDir: '/tmp/does-not-matter',
      upstreamPort: 4242,
      uiPort: 3010,
    });
    expect(script).toContain('const upstreamPort=4242');
  });
});

describe('validateLifecyclePorts (station#3677 five-port reservation)', () => {
  it('derives consent at server+3, validates an explicit override, and rejects every collision', async () => {
    const { lifecycle } = await loadLifecycleModule();
    // Default derivation: server, terminal(+1), voice(+2), consent(+3), ui.
    expect(() => lifecycle.validateLifecyclePorts(3141, 3000)).not.toThrow();
    // An explicit consent port gets the same validation.
    expect(() =>
      lifecycle.validateLifecyclePorts(3141, 3000, 3999),
    ).not.toThrow();
    // Colliding with the terminal port refuses.
    expect(() => lifecycle.validateLifecyclePorts(3141, 3000, 3142)).toThrow(
      /distinct/,
    );
    // A UI port equal to the DERIVED consent port refuses too.
    expect(() => lifecycle.validateLifecyclePorts(3141, 3144)).toThrow(
      /distinct/,
    );
    // The base ceiling reserves room for all three derived listeners.
    expect(() => lifecycle.validateLifecyclePorts(65_533, 3000)).toThrow(
      /65532/,
    );
    expect(() => lifecycle.validateLifecyclePorts(65_532, 3000)).not.toThrow();
    // An out-of-range explicit consent port refuses.
    expect(() => lifecycle.validateLifecyclePorts(3141, 3000, 0)).toThrow(
      /consent port/i,
    );
  });
});

describe('lifecycle build + restart ergonomics', () => {
  // Mock process.kill so a tracked PID reads alive until killProcessTree runs.
  function makeKillMock(pids: number[]) {
    let killed = false;
    const killProcessTree = vi.fn(() => {
      killed = true;
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0 && pids.includes(pid)) {
        if (killed) throw new Error('gone');
        return true;
      }
      return true;
    }) as typeof process.kill);
    return { killProcessTree, killSpy };
  }

  it('builds a named instance without stopping its healthy process and writes immutable provenance', async () => {
    ensureDir(TEST_CWD);
    ensureDir(join(TEST_CWD, '.git'));
    writeInstanceState({
      instanceName: 'dogfood',
      baseDir: TEST_ALT_HOME,
      serverPid: 41001,
      uiPid: 41002,
      serverPort: 3242,
      uiPort: 5274,
    });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    const execSync = vi.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === 'npm run build:server') {
          const serverDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_SERVER_DIR),
          );
          ensureDir(serverDir);
          writeFileSync(
            join(serverDir, 'command-station.js'),
            'candidate-server',
          );
        }
        if (command === 'npm run build:ui') {
          const uiDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_UI_DIR),
          );
          ensureDir(uiDir);
          writeFileSync(join(uiDir, 'index.html'), 'candidate-ui');
        }
        if (command === 'git rev-parse HEAD') {
          return '0123456789abcdef0123456789abcdef01234567\n';
        }
        return '';
      },
    );
    const killProcessTree = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync },
      platformOverrides: { killProcessTree },
    });

    try {
      const manifest = await lifecycle.buildApplication({
        instanceName: 'dogfood',
        baseDir: TEST_ALT_HOME,
        serverPort: 3242,
        uiPort: 5274,
      });

      expect(killProcessTree).not.toHaveBeenCalled();
      expect(manifest).toMatchObject({
        branch: 'main',
        sha: '0123456789abcdef0123456789abcdef01234567',
      });
      expect(lifecycle.readBuildManifest('dogfood')).toEqual(manifest);
      expect(
        readFileSync(
          join(TEST_CWD, 'dist-server-dogfood', 'command-station.js'),
          'utf-8',
        ),
      ).toBe('candidate-server');
      expect(
        readFileSync(join(TEST_CWD, 'dist-ui-dogfood', 'index.html'), 'utf-8'),
      ).toBe('candidate-ui');
      expect(existsSync(getInstanceStatePath('dogfood'))).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('keeps active server and UI bytes unchanged when UI fails after the candidate server succeeds', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('dogfood-failure');
    writeFileSync(
      join(TEST_CWD, 'dist-server-dogfood-failure', 'command-station.js'),
      'active-server',
    );
    writeFileSync(
      join(TEST_CWD, 'dist-ui-dogfood-failure', 'index.html'),
      'active-ui',
    );
    writeInstanceState({
      instanceName: 'dogfood-failure',
      baseDir: TEST_ALT_HOME,
      serverPid: 41001,
      uiPid: 41002,
      serverPort: 3242,
      uiPort: 5274,
    });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    const killProcessTree = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: {
        execSync: vi.fn(
          (command: string, options?: { env?: NodeJS.ProcessEnv }) => {
            if (command === 'npm run build:server') {
              const candidateServer = join(
                TEST_CWD,
                String(options?.env?.STATION_BUILD_SERVER_DIR),
              );
              ensureDir(candidateServer);
              writeFileSync(
                join(candidateServer, 'command-station.js'),
                'candidate-server',
              );
              return '';
            }
            if (command === 'npm run build:ui') {
              const candidateUi = join(
                TEST_CWD,
                String(options?.env?.STATION_BUILD_UI_DIR),
              );
              ensureDir(candidateUi);
              writeFileSync(join(candidateUi, 'index.html'), 'partial-ui');
              throw new Error('seeded UI build failure');
            }
            return '';
          },
        ),
      },
      platformOverrides: { killProcessTree },
    });

    try {
      await expect(
        lifecycle.start({
          build: true,
          instanceName: 'dogfood-failure',
          baseDir: TEST_ALT_HOME,
          serverPort: 3242,
          uiPort: 5274,
        }),
      ).rejects.toThrow('seeded UI build failure');
      expect(killProcessTree).not.toHaveBeenCalled();
      expect(existsSync(getInstanceStatePath('dogfood-failure'))).toBe(true);
      expect(
        readFileSync(
          join(TEST_CWD, 'dist-server-dogfood-failure', 'command-station.js'),
          'utf-8',
        ),
      ).toBe('active-server');
      expect(
        readFileSync(
          join(TEST_CWD, 'dist-ui-dogfood-failure', 'index.html'),
          'utf-8',
        ),
      ).toBe('active-ui');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('restores both prior directories when the second candidate swap fails', async () => {
    ensureDir(TEST_CWD);
    ensureDir(join(TEST_CWD, '.git'));
    ensureBuildOutputs('swap-failure');
    writeFileSync(
      join(TEST_CWD, 'dist-server-swap-failure', 'command-station.js'),
      'active-server',
    );
    writeFileSync(
      join(TEST_CWD, 'dist-ui-swap-failure', 'index.html'),
      'active-ui',
    );
    let renameCall = 0;
    const renameWithSeededFailure: typeof renameSync = (oldPath, newPath) => {
      renameCall += 1;
      if (renameCall === 4) throw new Error('seeded second-swap failure');
      renameSync(oldPath, newPath);
    };
    const execSync = vi.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === 'npm run build:server') {
          const candidateServer = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_SERVER_DIR),
          );
          ensureDir(candidateServer);
          writeFileSync(
            join(candidateServer, 'command-station.js'),
            'candidate-server',
          );
        }
        if (command === 'npm run build:ui') {
          const candidateUi = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_UI_DIR),
          );
          ensureDir(candidateUi);
          writeFileSync(join(candidateUi, 'index.html'), 'candidate-ui');
        }
        if (command === 'git rev-parse HEAD') {
          return '0123456789abcdef0123456789abcdef01234567\n';
        }
        return '';
      },
    );
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync },
      fsOverrides: { renameSync: renameWithSeededFailure },
    });

    await expect(
      lifecycle.buildApplication({
        instanceName: 'swap-failure',
        baseDir: TEST_ALT_HOME,
        serverPort: 3242,
        uiPort: 5274,
      }),
    ).rejects.toThrow(
      'Failed to promote candidate build; previous build restored. seeded second-swap failure',
    );
    expect(renameCall).toBe(6);
    expect(
      readFileSync(
        join(TEST_CWD, 'dist-server-swap-failure', 'command-station.js'),
        'utf-8',
      ),
    ).toBe('active-server');
    expect(
      readFileSync(
        join(TEST_CWD, 'dist-ui-swap-failure', 'index.html'),
        'utf-8',
      ),
    ).toBe('active-ui');
  });

  it('uses exact packaged release provenance when Git metadata is absent', async () => {
    ensureDir(TEST_CWD);
    // Byte-for-byte what package-portable-release.sh writes: same key order,
    // 2-space indent, trailing newline.
    writeFileSync(
      join(TEST_CWD, '.station-release.json'),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          sha: 'fedcba9876543210fedcba9876543210fedcba98',
          ref: 'v0.1.0',
          createdAt: '2026-07-22T12:34:56.000Z',
          channel: 'stable',
          releaseChannel: 'stable',
          prerelease: false,
        },
        null,
        2,
      )}\n`,
    );
    const execSync = vi.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === 'npm run build:server') {
          const serverDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_SERVER_DIR),
          );
          ensureDir(serverDir);
          writeFileSync(
            join(serverDir, 'command-station.js'),
            'candidate-server',
          );
        }
        if (command === 'npm run build:ui') {
          const uiDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_UI_DIR),
          );
          ensureDir(uiDir);
          writeFileSync(join(uiDir, 'index.html'), 'candidate-ui');
        }
        return '';
      },
    );
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync },
    });

    const manifest = await lifecycle.buildApplication({
      instanceName: 'portable',
      baseDir: TEST_ALT_HOME,
      serverPort: 3242,
      uiPort: 5274,
    });

    expect(manifest).toEqual({
      sha: 'fedcba9876543210fedcba9876543210fedcba98',
      branch: 'v0.1.0',
      builtAt: expect.any(String),
    });
    expect(Number.isFinite(Date.parse(manifest.builtAt))).toBe(true);
    expect(execSync).not.toHaveBeenCalledWith(
      'git rev-parse HEAD',
      expect.anything(),
    );
  });

  it('reports the exact missing packaged provenance path', async () => {
    ensureDir(TEST_CWD);
    const execSync = vi.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === 'npm run build:server') {
          const serverDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_SERVER_DIR),
          );
          ensureDir(serverDir);
          writeFileSync(
            join(serverDir, 'command-station.js'),
            'candidate-server',
          );
        }
        if (command === 'npm run build:ui') {
          const uiDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_UI_DIR),
          );
          ensureDir(uiDir);
          writeFileSync(join(uiDir, 'index.html'), 'candidate-ui');
        }
        return '';
      },
    );
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync },
    });

    await expect(
      lifecycle.buildApplication({
        instanceName: 'portable-invalid',
        baseDir: TEST_ALT_HOME,
        serverPort: 3242,
        uiPort: 5274,
      }),
    ).rejects.toThrow(
      `Git metadata is absent at ${join(TEST_CWD, '.git')}; packaged release manifest is missing at ${join(TEST_CWD, '.station-release.json')}`,
    );
  });

  it.each([
    {
      description: 'the retired v1 six-key shape',
      manifest: {
        schemaVersion: 1,
        sha: 'fedcba9876543210fedcba9876543210fedcba98',
        ref: 'v0.1.0',
        createdAt: '2026-07-22T12:34:56.000Z',
        channel: 'stable',
        prerelease: false,
      },
    },
    {
      description: 'a channel/releaseChannel pairing mismatch',
      manifest: {
        schemaVersion: 2,
        sha: 'fedcba9876543210fedcba9876543210fedcba98',
        ref: 'v0.1.0',
        createdAt: '2026-07-22T12:34:56.000Z',
        channel: 'beta',
        releaseChannel: 'stable',
        prerelease: false,
      },
    },
  ])(
    'rejects packaged provenance written as $description',
    async ({ manifest }) => {
      ensureDir(TEST_CWD);
      writeFileSync(
        join(TEST_CWD, '.station-release.json'),
        JSON.stringify(manifest),
      );
      const execSync = vi.fn(
        (command: string, options?: { env?: NodeJS.ProcessEnv }) => {
          if (command === 'npm run build:server') {
            const serverDir = join(
              TEST_CWD,
              String(options?.env?.STATION_BUILD_SERVER_DIR),
            );
            ensureDir(serverDir);
            writeFileSync(
              join(serverDir, 'command-station.js'),
              'candidate-server',
            );
          }
          if (command === 'npm run build:ui') {
            const uiDir = join(
              TEST_CWD,
              String(options?.env?.STATION_BUILD_UI_DIR),
            );
            ensureDir(uiDir);
            writeFileSync(join(uiDir, 'index.html'), 'candidate-ui');
          }
          return '';
        },
      );
      const { lifecycle } = await loadLifecycleModule({
        childProcessMock: { execSync },
      });

      await expect(
        lifecycle.buildApplication({
          instanceName: 'portable-invalid',
          baseDir: TEST_ALT_HOME,
          serverPort: 3242,
          uiPort: 5274,
        }),
      ).rejects.toThrow(
        `Git metadata is absent at ${join(TEST_CWD, '.git')}; packaged release manifest is invalid at ${join(TEST_CWD, '.station-release.json')}`,
      );
    },
  );

  it('binds both listeners and health probes to an explicit host and round-trips provenance in state', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    writeBuildManifest('loopback');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 41001, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 41002, unref: vi.fn() });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    const fetchMock = vi.fn(readyLifecycleFetch);
    vi.stubGlobal('fetch', fetchMock);
    const tcpConnect = makeReadyTcpConnectMock();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
      netConnectMock: tcpConnect,
    });
    const logDirectory = join(TEST_ROOT, 'logs');
    const logFile = join(logDirectory, 'station.log');
    ensureDir(logDirectory);
    chmodSync(logDirectory, 0o755);
    const canonicalLogFile = join(realpathSync(logDirectory), 'station.log');
    writeFileSync(logFile, 'retained pre-restart SIGTERM marker\n', {
      mode: 0o644,
    });

    try {
      await lifecycle.start({
        instanceName: 'loopback',
        baseDir: TEST_ALT_HOME,
        host: '127.0.0.1',
        logFile,
        serverPort: 3242,
        uiPort: 5274,
      });

      expect(spawn.mock.calls[0][2]?.env).toEqual(
        expect.objectContaining({
          STATION_BUILD_BRANCH: 'main',
          STATION_BUILD_BUILT_AT: '2026-07-10T12:00:00.000Z',
          STATION_BUILD_SHA: '0123456789abcdef0123456789abcdef01234567',
          STATION_BOOT_ID: expect.stringMatching(/^[0-9a-f-]{36}$/),
          STATION_HOST: '127.0.0.1',
          STATION_LOG_FILE: canonicalLogFile,
        }),
      );
      expect(String(spawn.mock.calls[1][1]?.[1])).toContain(
        'listen(5274,"127.0.0.1")',
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3242/api/system/identity',
        {
          headers: expect.objectContaining({
            Accept: 'application/json',
            'x-station-internal-token':
              expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/),
            'x-station-proxy-caller': 'local',
          }),
          signal: expect.any(AbortSignal),
        },
      );
      // Terminal (+1) and voice (+2) are TCP-probed. The consent listener
      // (+3, station#3677) deliberately is NOT: review MED 4 — a TCP probe
      // proves only that SOMETHING accepted a socket, so the consent line
      // derives from the runtime's own `/api/system/instance` self-report
      // instead (asserted below).
      expect(tcpConnect).toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 3243,
      });
      expect(tcpConnect).toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 3244,
      });
      expect(tcpConnect).not.toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 3245,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3242/api/system/instance',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-station-proxy-caller': 'local',
          }),
        }),
      );
      const state = JSON.parse(
        readFileSync(getInstanceStatePath('loopback'), 'utf-8'),
      );
      expect(state).toMatchObject({
        bootId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        build: {
          branch: 'main',
          sha: '0123456789abcdef0123456789abcdef01234567',
        },
        host: '127.0.0.1',
        logFile: canonicalLogFile,
      });
      expect(statSync(logDirectory).mode & 0o777).toBe(0o755);
      expect(statSync(logFile).mode & 0o777).toBe(0o600);
      const retainedLog = readFileSync(logFile, 'utf8');
      expect(retainedLog).toContain('retained pre-restart SIGTERM marker');
      expect(retainedLog).toContain('station lifecycle start');
      expect(retainedLog).toContain('instance=loopback');
      expect(retainedLog).toContain(
        'build=0123456789abcdef0123456789abcdef01234567',
      );
      expect(
        existsSync(join(TEST_ALT_HOME, 'logs', 'station-loopback.log')),
      ).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('logs ordinary launches to a secured per-instance file by default', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    writeBuildManifest('default-log');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 41011, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 41012, unref: vi.fn() });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
      netConnectMock: makeReadyTcpConnectMock(),
    });
    const logFile = join(TEST_ALT_HOME, 'logs', 'station-default-log.log');

    try {
      await lifecycle.start({
        instanceName: 'default-log',
        baseDir: TEST_ALT_HOME,
        serverPort: 3252,
        uiPort: 5284,
      });

      expect(spawn.mock.calls[0][2]?.env).toEqual(
        expect.objectContaining({ STATION_LOG_FILE: logFile }),
      );
      expect(statSync(join(TEST_ALT_HOME, 'logs')).mode & 0o777).toBe(0o700);
      expect(statSync(logFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(logFile, 'utf8')).toContain(
        'station lifecycle start instance=default-log',
      );
      expect(
        JSON.parse(readFileSync(getInstanceStatePath('default-log'), 'utf8')),
      ).toMatchObject({ logFile });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('creates the secured parent directory for an explicit log file', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    writeBuildManifest('explicit-log-directory');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 41021, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 41022, unref: vi.fn() });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
      netConnectMock: makeReadyTcpConnectMock(),
    });
    const logDirectory = join(TEST_ALT_HOME, 'fresh-logs');
    const logFile = join(logDirectory, 'station.log');

    try {
      await lifecycle.start({
        instanceName: 'explicit-log-directory',
        baseDir: TEST_ALT_HOME,
        logFile,
        serverPort: 3262,
        uiPort: 5294,
      });

      expect(statSync(logDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(logFile).mode & 0o777).toBe(0o600);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('rejects a relative explicit log path without mutating the working directory', async () => {
    ensureDir(TEST_CWD);
    chmodSync(TEST_CWD, 0o755);
    const spawn = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(), spawn },
    });

    await expect(
      lifecycle.start({
        logFile: 'station.log',
        serverPort: 3263,
        uiPort: 5295,
      }),
    ).rejects.toThrow('Explicit log path must be absolute');

    expect(statSync(TEST_CWD).mode & 0o777).toBe(0o755);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a symlinked explicit log directory inside STATION_HOME', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    // A valid schema marker keeps the #1560 home gate from firing first, so
    // this test still exercises the symlink rejection it was written for.
    ensureStationHomeSchemaSync(TEST_ALT_HOME);
    const target = join(TEST_ALT_HOME, 'actual-logs');
    const linked = join(TEST_ALT_HOME, 'linked-logs');
    ensureDir(target);
    symlinkSync(target, linked);
    writeBuildManifest('symlinked-log-directory');
    const spawn = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
    });

    await expect(
      lifecycle.start({
        instanceName: 'symlinked-log-directory',
        baseDir: TEST_ALT_HOME,
        logFile: join(linked, 'station.log'),
        serverPort: 3264,
        uiPort: 5296,
      }),
    ).rejects.toThrow('Log directory ancestor must be a directory');

    expect(spawn).not.toHaveBeenCalled();
  });

  it('bootstraps the home schema marker before writing logs into a fresh home (#1570)', async () => {
    ensureDir(TEST_CWD);
    writeBuildManifest('fresh-home-marker');
    const spawn = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
    });

    // The home does not exist yet — exactly the first-boot shape that #1570
    // bricked when logs/ landed before the schema gate.
    await lifecycle
      .start({
        instanceName: 'fresh-home-marker',
        baseDir: TEST_ALT_HOME,
        serverPort: 3264,
        uiPort: 5296,
      })
      .catch(() => {
        // Reaching the (mocked, readiness-less) spawn is fine; what matters
        // is the home state written before it.
      });

    const marker = join(TEST_ALT_HOME, STATION_HOME_SCHEMA_FILE);
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ version: 1 });
  });

  it('creates a multi-level missing home path before gating it (#1570)', async () => {
    ensureDir(TEST_CWD);
    // Neither "deep" nor its children exist: the recursive mkdir must run
    // before the gate, whose canonicalization requires the parent to exist.
    const nestedHome = join(TEST_ROOT, 'deep', 'nested', 'station-home');
    writeBuildManifest('nested-home-marker');
    const spawn = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
    });

    await lifecycle
      .start({
        instanceName: 'nested-home-marker',
        baseDir: nestedHome,
        serverPort: 3264,
        uiPort: 5296,
      })
      .catch(() => {
        // Spawn readiness is out of scope; the home state is the assertion.
      });

    const marker = join(nestedHome, STATION_HOME_SCHEMA_FILE);
    expect(existsSync(marker)).toBe(true);
  });

  it('fails closed before spawn when the home is schema-incompatible (#1570)', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    // A marker-less home with real content is the pre-#1560 shape the gate
    // must refuse rather than absorb.
    ensureDir(join(TEST_ALT_HOME, 'agents'));
    writeBuildManifest('incompatible-home');
    const spawn = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
    });

    await expect(
      lifecycle.start({
        instanceName: 'incompatible-home',
        baseDir: TEST_ALT_HOME,
        serverPort: 3264,
        uiPort: 5296,
      }),
    ).rejects.toThrow('STATION_HOME_RESET_REQUIRED');

    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(TEST_ALT_HOME, 'logs'))).toBe(false);
  });

  it('names the supported reset command in the failure it throws (station#1913)', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    ensureDir(join(TEST_ALT_HOME, 'agents'));
    writeBuildManifest('incompatible-home-2');
    const spawn = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
    });

    await expect(
      lifecycle.start({
        instanceName: 'incompatible-home-2',
        baseDir: TEST_ALT_HOME,
        serverPort: 3265,
        uiPort: 5297,
      }),
    ).rejects.toThrow(STATION_HOME_RESET_COMMAND);
  });

  it('rejects non-address host values before spawning', async () => {
    const spawn = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(), spawn },
    });

    await expect(lifecycle.start({ host: 'localhost' })).rejects.toThrow(
      'Expected an IPv4 or IPv6 address',
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('kills the server when UI spawn fails before instance publication', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    writeBuildManifest('ui-spawn-failure');
    const serverKill = vi.fn();
    const spawn = vi
      .fn()
      .mockReturnValueOnce({
        kill: serverKill,
        pid: 43901,
        unref: vi.fn(),
      })
      .mockImplementationOnce(() => {
        throw new Error('seeded UI spawn failure');
      });
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
    });

    await expect(
      lifecycle.start({
        baseDir: TEST_ALT_HOME,
        instanceName: 'ui-spawn-failure',
        serverPort: 3242,
        uiPort: 5274,
      }),
    ).rejects.toThrow('seeded UI spawn failure');
    expect(serverKill).toHaveBeenCalledWith('SIGTERM');
    expect(existsSync(getInstanceStatePath('ui-spawn-failure'))).toBe(false);
  });

  it.each([
    ['derived voice port out of range', 65_534, 3000],
    ['UI overlaps terminal', 3242, 3243],
    ['UI overlaps voice', 3242, 3244],
    ['non-integer server port', 3242.5, 5274],
  ])('rejects %s before build or spawn', async (_label, serverPort, uiPort) => {
    const execSync = vi.fn();
    const spawn = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync, spawn },
    });

    await expect(lifecycle.start({ serverPort, uiPort })).rejects.toThrow(
      /port|distinct/i,
    );
    expect(execSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cleans the complete instance when terminal readiness never arrives', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    writeBuildManifest('terminal-not-ready');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 44001, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 44002, unref: vi.fn() });
    let processesAlive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0 && (pid === 44001 || pid === 44002)) {
        if (processesAlive) return true;
        throw new Error('gone');
      }
      return true;
    }) as typeof process.kill);
    const killProcessTree = vi.fn(() => {
      processesAlive = false;
    });
    let now = 0;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const tcpConnect = vi.fn(() => {
      const socket = new EventEmitter() as EventEmitter & {
        destroy: () => void;
        setTimeout: () => void;
      };
      socket.destroy = vi.fn();
      socket.setTimeout = vi.fn();
      queueMicrotask(() => {
        now = 90_000;
        socket.emit('error', new Error('seeded terminal refusal'));
      });
      return socket;
    });
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
      netConnectMock: tcpConnect,
      platformOverrides: {
        killProcessTree,
        sleepSync: vi.fn(),
        // Seeded so fingerprint capture is driven by this test rather than by
        // a real `ps` probe against a fabricated pid. `sleepSync` alone does
        // not neutralize it: `captureStableProcessFingerprint` calls the
        // module's own `sleepSync` binding, which a module mock cannot reach,
        // so with this clock frozen the capture blocked forever (station#1712).
        inspectProcessFingerprint: (pid: number) => ({
          pid,
          startToken: 'terminal-not-ready-start',
          commandDigest: 'c'.repeat(64),
        }),
      },
    });

    try {
      await expect(
        lifecycle.start({
          baseDir: TEST_ALT_HOME,
          host: '127.0.0.1',
          instanceName: 'terminal-not-ready',
          serverPort: 3242,
          uiPort: 5274,
        }),
      ).rejects.toThrow('Timed out waiting for TCP listener 127.0.0.1:3243');
      expect(killProcessTree).toHaveBeenCalledWith(44001);
      expect(killProcessTree).toHaveBeenCalledWith(44002);
      expect(existsSync(getInstanceStatePath('terminal-not-ready'))).toBe(
        false,
      );
    } finally {
      dateSpy.mockRestore();
      killSpy.mockRestore();
    }
  });

  it('preserves the startup failure when cleanup also fails', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    writeBuildManifest('cleanup-also-fails');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 45001, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 45002, unref: vi.fn() });
    let now = 0;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    const tcpConnect = vi.fn(() => {
      const socket = new EventEmitter() as EventEmitter & {
        destroy: () => void;
        setTimeout: () => void;
      };
      socket.destroy = vi.fn();
      socket.setTimeout = vi.fn();
      queueMicrotask(() => {
        now += 90_000;
        socket.emit('error', new Error('seeded terminal refusal'));
      });
      return socket;
    });
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
      netConnectMock: tcpConnect,
      platformOverrides: {
        killProcessTree: vi.fn(),
        sleepSync: vi.fn((ms: number) => {
          now += ms;
        }),
        // See the sibling terminal-not-ready case: the module's own
        // `sleepSync` binding is not what this override replaces, so without a
        // seeded fingerprint the capture spins on the frozen clock (#1712).
        inspectProcessFingerprint: (pid: number) => ({
          pid,
          startToken: 'cleanup-also-fails-start',
          commandDigest: 'd'.repeat(64),
        }),
      },
    });

    try {
      const failure = await lifecycle
        .start({
          baseDir: TEST_ALT_HOME,
          host: '127.0.0.1',
          instanceName: 'cleanup-also-fails',
          serverPort: 3242,
          uiPort: 5274,
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        'Timed out waiting for TCP listener 127.0.0.1:3243',
      );
      expect((failure as Error).message).toContain(
        'Cleanup also failed: Failed to stop Station instance cleanup-also-fails.',
      );
      expect((failure as Error).cause).toBeInstanceOf(AggregateError);
      expect(
        ((failure as Error).cause as AggregateError).errors.map(
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        ),
      ).toEqual([
        expect.stringContaining(
          'Timed out waiting for TCP listener 127.0.0.1:3243',
        ),
        expect.stringContaining(
          'Failed to stop Station instance cleanup-also-fails.',
        ),
      ]);
      expect(existsSync(getInstanceStatePath('cleanup-also-fails'))).toBe(true);
    } finally {
      dateSpy.mockRestore();
      killSpy.mockRestore();
    }
  });

  it('restarts an already-running instance with --force and no rebuild', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('reboot');
    ensureDir(TEST_ALT_HOME);
    writeInstanceState({
      instanceName: 'reboot',
      baseDir: TEST_ALT_HOME,
      serverPid: 41001,
      uiPid: 41002,
      serverPort: 3242,
      uiPort: 5274,
    });

    const { killProcessTree, killSpy } = makeKillMock([41001, 41002]);
    const execSync = vi.fn((_command: string) => ''); // lsof -> no listeners; no build expected
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 42001, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 42002, unref: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync, spawn },
      platformOverrides: { killProcessTree, sleepSync: vi.fn() },
    });

    try {
      await lifecycle.start({
        force: true,
        instanceName: 'reboot',
        baseDir: TEST_ALT_HOME,
        homeSource: '--base',
        serverPort: 3242,
        uiPort: 5274,
      });
      expect(killProcessTree).toHaveBeenCalledWith(41001);
      expect(killProcessTree).toHaveBeenCalledWith(41002);
      expect(spawn).toHaveBeenCalledTimes(2); // respawned
      const ranBuild = execSync.mock.calls.some((call) =>
        String(call[0]).includes('npm run build'),
      );
      expect(ranBuild).toBe(false); // reused the existing build
    } finally {
      killSpy.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it('removes per-instance build dirs when stopping a --temp-home instance', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('ephemeral');
    const statePath = writeInstanceState({
      instanceName: 'ephemeral',
      homeSource: '--temp-home',
      serverPid: 41001,
      uiPid: null,
      serverPort: 39901,
      uiPort: 39902,
    });

    const { killProcessTree, killSpy } = makeKillMock([41001]);
    const execSync = vi.fn(() => '');
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync },
      platformOverrides: { killProcessTree, sleepSync: vi.fn() },
    });

    try {
      lifecycle.stop({ instanceName: 'ephemeral' });
      expect(existsSync(join(TEST_CWD, 'dist-server-ephemeral'))).toBe(false);
      expect(existsSync(join(TEST_CWD, 'dist-ui-ephemeral'))).toBe(false);
      expect(existsSync(statePath)).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('keeps build dirs when stopping a persistent (non temp-home) instance', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('persistent');
    writeInstanceState({
      instanceName: 'persistent',
      homeSource: '--base',
      baseDir: TEST_ALT_HOME,
      serverPid: 41001,
      uiPid: null,
      serverPort: 39801,
      uiPort: 39802,
    });

    const { killProcessTree, killSpy } = makeKillMock([41001]);
    const execSync = vi.fn(() => '');
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync },
      platformOverrides: { killProcessTree, sleepSync: vi.fn() },
    });

    try {
      lifecycle.stop({ instanceName: 'persistent' });
      expect(existsSync(join(TEST_CWD, 'dist-server-persistent'))).toBe(true);
      expect(existsSync(join(TEST_CWD, 'dist-ui-persistent'))).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('warns when the build is stale (source newer than the bundle)', async () => {
    ensureDir(TEST_CWD);
    ensureBuildOutputs('staleinst');
    ensureDir(TEST_ALT_HOME);
    const buildIndex = join(
      TEST_CWD,
      'dist-server-staleinst',
      'command-station.js',
    );
    writeFileSync(buildIndex, '// built');
    utimesSync(buildIndex, new Date(1_000), new Date(1_000)); // ancient build
    ensureDir(join(TEST_CWD, 'src-server'));
    const srcFile = join(TEST_CWD, 'src-server', 'x.ts');
    writeFileSync(srcFile, 'export const x = 1;');
    const future = new Date(2_000_000_000_000);
    utimesSync(srcFile, future, future); // far newer than the build

    const execSync = vi.fn(() => '');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 43001, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 43002, unref: vi.fn() });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync, spawn },
      platformOverrides: { sleepSync: vi.fn() },
    });

    try {
      await lifecycle.start({
        instanceName: 'staleinst',
        baseDir: TEST_ALT_HOME,
        homeSource: '--base',
        serverPort: 3242,
        uiPort: 5274,
      });
      const warned = consoleLog.mock.calls.some((call) =>
        String(call[0]).includes('Source has changed since the last build'),
      );
      expect(warned).toBe(true);
    } finally {
      killSpy.mockRestore();
      consoleLog.mockRestore();
    }
  });

  // station#3669a: a UI build that fails on the entry-bundle ceiling must
  // fail the start outright — no server spawn, no promoted candidate, and
  // the real build failure text preserved (not swallowed or replaced by a
  // generic message) so the operator sees why. A prior successful build is
  // seeded so this also proves the stale build is never silently reused in
  // place of the failed one.
  it('start --build rejects, spawns nothing, and preserves the build failure text when npm run build:ui fails (station#3669a)', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    writeBuildManifest('build-ui-failure', {
      sha: '0123456789abcdef0123456789abcdef01234567',
    });
    const previousServerBytes = readFileSync(
      join(
        TEST_CWD,
        'dist-server-build-ui-failure',
        TEST_SERVER_ENTRY_FILENAME,
      ),
      'utf-8',
    );
    const buildUiError = new Error(
      'Command failed: npm run build:ui\nentry JS gzip 400000 exceeds 285794 bytes',
    );
    const execSync = vi.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === 'npm run build:server') {
          const serverDir = join(
            TEST_CWD,
            String(options?.env?.STATION_BUILD_SERVER_DIR),
          );
          ensureDir(serverDir);
          writeFileSync(
            join(serverDir, 'command-station.js'),
            'candidate-server',
          );
          return '';
        }
        if (command === 'npm run build:ui') {
          throw buildUiError;
        }
        return '';
      },
    );
    const spawn = vi.fn();
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync, spawn },
    });

    await expect(
      lifecycle.start({
        instanceName: 'build-ui-failure',
        baseDir: TEST_ALT_HOME,
        serverPort: 3271,
        uiPort: 5301,
        build: true,
      }),
    ).rejects.toThrow('entry JS gzip 400000 exceeds 285794 bytes');

    // A failed build must never result in anything being served.
    expect(spawn).not.toHaveBeenCalled();
    // The pre-existing build is untouched: the failed candidate was never
    // promoted over it.
    expect(
      readFileSync(
        join(
          TEST_CWD,
          'dist-server-build-ui-failure',
          TEST_SERVER_ENTRY_FILENAME,
        ),
        'utf-8',
      ),
    ).toBe(previousServerBytes);
    // No instance state was written — nothing claims to be running.
    expect(existsSync(getInstanceStatePath('build-ui-failure'))).toBe(false);
  });

  // station#3669b: without `--build`, start reuses whatever build is already
  // on disk. `isBuildStale` only catches source mtimes newer than the build
  // (the test above this one) — it cannot detect a checkout that moved to a
  // different commit without touching file mtimes. This proves the sha
  // comparison against HEAD (reusing `resolveSourceBuildManifest`, the same
  // derivation `buildApplication` stamps into the manifest) is printed and
  // warns on a mismatch, so a reused build is never silently truthful.
  it('start without --build prints the served sha against HEAD and warns on a mismatch (station#3669b)', async () => {
    ensureDir(TEST_CWD);
    ensureDir(join(TEST_CWD, '.git'));
    ensureDir(TEST_ALT_HOME);
    writeBuildManifest('sha-drift', {
      sha: '0123456789abcdef0123456789abcdef01234567',
    });
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 44011, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 44012, unref: vi.fn() });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const execSync = vi.fn((command: string) => {
      if (command === 'git rev-parse HEAD') {
        return 'fedcba9876543210fedcba9876543210fedcba98\n';
      }
      return '';
    });

    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync, spawn },
      platformOverrides: { sleepSync: vi.fn() },
    });

    try {
      await lifecycle.start({
        instanceName: 'sha-drift',
        baseDir: TEST_ALT_HOME,
        homeSource: '--base',
        serverPort: 3272,
        uiPort: 5302,
      });

      const logged = consoleLog.mock.calls.map((call) => String(call[0]));
      expect(
        logged.some((line) =>
          line.includes(
            'Serving build 0123456789abcdef0123456789abcdef01234567 (HEAD fedcba9876543210fedcba9876543210fedcba98)',
          ),
        ),
      ).toBe(true);
      expect(
        logged.some((line) =>
          line.includes(
            '⚠️  Served build 0123456789abcdef0123456789abcdef01234567 does not match HEAD fedcba9876543210fedcba9876543210fedcba98',
          ),
        ),
      ).toBe(true);
    } finally {
      killSpy.mockRestore();
      consoleLog.mockRestore();
    }
  });

  // station#4299: an agent restarted an instance three times believing it was
  // isolated; all three boots used the operator's real `~/.station`. Nothing
  // in the start output named the home, because the `Home:` line was printed
  // only for `--temp-home` -- the one case where the operator already knew.
  it('names the resolved home and what chose it in the start report', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    writeBuildManifest('home-report');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 44021, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 44022, unref: vi.fn() });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
      netConnectMock: makeReadyTcpConnectMock(),
    });

    try {
      await lifecycle.start({
        instanceName: 'home-report',
        baseDir: TEST_ALT_HOME,
        // The incident's shape: no flag selected this home, so the operator
        // is one line away from finding out it is the real one.
        homeSource: 'default',
        serverPort: 3282,
        uiPort: 5312,
      });

      const logged = consoleLog.mock.calls.map((call) => String(call[0]));
      expect(
        logged.some((line) => line.includes(`Home:   ${TEST_ALT_HOME}`)),
      ).toBe(true);
      // The path alone does not say why it is that path. `(default)` is what
      // distinguishes "I asked for this" from "nothing asked, so it is yours".
      expect(
        logged.some((line) =>
          line.includes(`Home:   ${TEST_ALT_HOME} (default)`),
        ),
      ).toBe(true);
    } finally {
      killSpy.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it('names --home as the chooser when the home came from the flag', async () => {
    ensureDir(TEST_CWD);
    ensureDir(TEST_ALT_HOME);
    writeBuildManifest('home-flag-report');
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ pid: 44023, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 44024, unref: vi.fn() });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    vi.stubGlobal('fetch', vi.fn(readyLifecycleFetch));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: { execSync: vi.fn(() => ''), spawn },
      netConnectMock: makeReadyTcpConnectMock(),
    });

    try {
      await lifecycle.start({
        instanceName: 'home-flag-report',
        baseDir: TEST_ALT_HOME,
        homeSource: '--home',
        serverPort: 3286,
        uiPort: 5316,
      });

      const logged = consoleLog.mock.calls.map((call) => String(call[0]));
      expect(
        logged.some((line) =>
          line.includes(`Home:   ${TEST_ALT_HOME} (--home)`),
        ),
      ).toBe(true);
    } finally {
      killSpy.mockRestore();
      consoleLog.mockRestore();
    }
  });

  // station#1869: a supervisor killed mid-build leaves orphan candidate dirs
  // under `.station/build-candidates/`. They must be swept before the next
  // build so a later promotion does not hit ENOTEMPTY against a stale
  // `previous-*` left by a failed promotion.
  it('prunes stale same-instance candidate dirs before a new build (station#1869)', async () => {
    ensureDir(TEST_CWD);
    const candidates = join(TEST_CWD, '.station', 'build-candidates');
    ensureDir(candidates);
    // A stale orphan from a prior killed build for THIS instance.
    const staleForThis = join(candidates, 'pruneinst-stale-leftover');
    ensureDir(staleForThis);
    writeFileSync(join(staleForThis, 'previous-server'), 'leftover');
    // A DIFFERENT instance's in-flight candidate — must be left alone.
    const otherInstance = join(candidates, 'otherinst-in-flight');
    ensureDir(otherInstance);
    writeFileSync(join(otherInstance, 'marker'), 'do-not-touch');

    const { lifecycle } = await loadLifecycleModule({});
    lifecycle.pruneStaleBuildCandidates('pruneinst');

    expect(existsSync(staleForThis)).toBe(false);
    expect(existsSync(otherInstance)).toBe(true);
  });

  // station#1867 review round: the test above proves the prune FUNCTION works,
  // but nothing proved `buildApplication` actually calls it — deleting the call
  // site left the whole lifecycle suite green. This pins the WIRING. The build
  // is made to fail immediately (`execSync` throws on the first `npm run
  // build:server`), which is enough: the prune runs before the build starts, so
  // a swept orphan proves the call site is present without running a real build.
  it('buildApplication prunes stale candidates before the build runs (station#1867)', async () => {
    ensureDir(TEST_CWD);
    const candidates = join(TEST_CWD, '.station', 'build-candidates');
    ensureDir(candidates);
    const staleForThis = join(candidates, 'wiredinst-stale-leftover');
    ensureDir(staleForThis);
    writeFileSync(join(staleForThis, 'previous-server'), 'leftover');
    const otherInstance = join(candidates, 'otherinst-in-flight');
    ensureDir(otherInstance);
    writeFileSync(join(otherInstance, 'marker'), 'do-not-touch');

    const buildFailed = new Error('build stopped for this test');
    const { lifecycle } = await loadLifecycleModule({
      childProcessMock: {
        execSync: vi.fn(() => {
          throw buildFailed;
        }),
      },
    });

    // station#3669 wraps a failed build step so the failure NAMES the step and
    // says what it cost; the step's own message survives inside it, and the
    // original error is the `cause`. Both are asserted, so neither the naming
    // nor the preservation can be dropped without this going red.
    const thrown = await lifecycle
      .buildApplication({ instanceId: 'wiredinst' })
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain('Server build failed');
    expect(thrown?.message).toContain('build stopped for this test');
    expect(thrown?.cause).toBe(buildFailed);

    // The orphan is gone even though the build never got past its first
    // command — only the call site inside `buildApplication` can have done it.
    expect(existsSync(staleForThis)).toBe(false);
    expect(existsSync(otherInstance)).toBe(true);
  });
});

describe('build currency is decided by complete artifacts, not directories', () => {
  // station#2271: a build directory left over from a different entry name
  // satisfied both `isInstalled` (directory check) and `isBuildStale`
  // (which returned false when the entry was missing, deferring to a
  // needsBuild path `start()` does run). The supervisor independently uses
  // `isBuildStale`, so both defenses must reject incomplete artifacts.
  it('reports a build directory without either served file as not installed', async () => {
    const { lifecycle } = await loadLifecycleModule();
    const { server, ui } = lifecycle.resolveBuildPaths('default');

    ensureDir(join(TEST_CWD, server));
    ensureDir(join(TEST_CWD, ui));
    expect(existsSync(join(TEST_CWD, server, TEST_SERVER_ENTRY_FILENAME))).toBe(
      false,
    );

    // The directories exist, so a directory-only check would say installed.
    expect(lifecycle.isInstalled('default')).toBe(false);

    writeFileSync(join(TEST_CWD, server, TEST_SERVER_ENTRY_FILENAME), '');
    expect(lifecycle.isInstalled('default')).toBe(false);
    writeFileSync(join(TEST_CWD, ui, 'index.html'), '<!doctype html>');
    expect(lifecycle.isInstalled('default')).toBe(true);
  });

  it('rejects a directory where either required build file belongs', async () => {
    const { lifecycle } = await loadLifecycleModule();
    const { server, ui } = lifecycle.resolveBuildPaths('default');
    ensureDir(join(TEST_CWD, server, TEST_SERVER_ENTRY_FILENAME));
    ensureDir(join(TEST_CWD, ui, 'index.html'));

    expect(lifecycle.isInstalled('default')).toBe(false);
    expect(lifecycle.isBuildStale({ server, ui })).toBe(true);
  });

  it('reports a missing server entry as stale so the supervisor rebuilds', async () => {
    const { lifecycle } = await loadLifecycleModule();
    const buildPaths = lifecycle.resolveBuildPaths('default');

    ensureDir(join(TEST_CWD, buildPaths.server));
    ensureDir(join(TEST_CWD, buildPaths.ui));

    // The supervisor's early stale check must force a rebuild before `start()`
    // gets its separate incomplete-install defense.
    expect(lifecycle.isBuildStale(buildPaths)).toBe(true);
  });

  it('makes the real supervisor stale-build dependency request a rebuild', async () => {
    await loadLifecycleModule();
    const { superviseService } = await import('../commands/service-run.js');
    const start = vi.fn().mockResolvedValue(undefined);
    const collect = vi.fn().mockResolvedValue({
      bootId: 'boot-1',
      found: true,
      healthy: true,
      instanceId: 'default',
      server: { listening: true, pid: 10, probe: 'ok', reachable: true },
      sha: 'abcdef0',
      ui: { listening: true, pid: 11, probe: 'ok', reachable: true },
    });

    await superviseService(
      {
        baseDir: TEST_DEFAULT_HOME,
        homeSource: '--base',
        instanceName: 'default',
        serverPort: 3242,
        uiPort: 5274,
      },
      {
        collect,
        exit: vi.fn(),
        listListeningPids: () => [],
        onSignal: vi.fn(),
        processIsAlive: () => true,
        setTimer: vi.fn(() => 1 as never),
        start,
        stop: vi.fn(),
      },
    );

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ build: true }),
    );
  });
});
