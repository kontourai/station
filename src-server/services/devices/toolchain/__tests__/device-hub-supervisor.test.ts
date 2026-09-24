/**
 * The device hub supervisor (#1970) over a fake spawn: port discovery,
 * readiness, restart backoff, the crash state and stop. No process starts.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { HubHelper } from '../device-hub-helpers.js';
import {
  DeviceHubSupervisor,
  deviceHubEnvironment,
  type SupervisedChild,
} from '../device-hub-supervisor.js';

const runDirs: string[] = [];
afterEach(() => {
  for (const dir of runDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function writeHelperState(
  runDir: string,
  device: string,
  pid: number,
  port: number,
) {
  const dir = join(runDir, 'tmp', 'serve-sim');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `server-${device}.json`),
    JSON.stringify({ pid, port, device, url: `http://127.0.0.1:${port}` }),
  );
}

interface FakeChild extends SupervisedChild {
  stdout: PassThrough;
  signals: string[];
  released: boolean;
  exit(code: number | null): void;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function harness(
  options: {
    print?: (index: number) => string | undefined;
    version?: string;
  } = {},
) {
  const runDir = mkdtempSync(join(tmpdir(), 'station-hub-run-'));
  runDirs.push(runDir);
  const killed: HubHelper[] = [];
  const killedRoots: string[] = [];
  const children: FakeChild[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let clock = 1_000_000;
  const spawn = vi.fn(
    (
      _command: string,
      args: string[],
      spawnOptions: { env: NodeJS.ProcessEnv },
    ) => {
      const stdout = new PassThrough();
      const exitListeners: Array<
        (code: number | null, signal: string | null) => void
      > = [];
      const child: FakeChild = {
        pid: 4000 + children.length,
        stdout,
        signals: [],
        released: false,
        args,
        env: spawnOptions.env,
        onExit: (listener) => exitListeners.push(listener),
        onError: () => {},
        terminate(signal) {
          child.signals.push(signal);
          child.exit(null);
        },
        release() {
          child.released = true;
        },
        exit(code) {
          for (const listener of exitListeners.splice(0)) listener(code, null);
        },
      };
      const index = children.length;
      children.push(child);
      const line =
        options.print?.(index) ??
        `Expo Device Hub ready\n\n  Local:   http://localhost:${50_000 + index}\n`;
      if (line) queueMicrotask(() => stdout.write(line));
      return child;
    },
  );
  const supervisor = new DeviceHubSupervisor({
    resolveLaunch: () => ({
      entry:
        '/home/devices/tools/expo-device-hub/0.10.1/node_modules/expo-device-hub/dist/server/cli.mjs',
      cwd: '/home/devices/tools/expo-device-hub/0.10.1',
      version: options.version ?? '0.10.1',
      runDir,
    }),
    killHelper: async (helper, toolRoot) => {
      killed.push(helper);
      killedRoots.push(toolRoot);
      rmSync(helper.stateFile, { force: true });
    },
    spawn,
    nodePath: '/usr/bin/node',
    probeReady: async () => true,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    env: {
      PATH: '/usr/bin',
      HOME: '/home/me',
      STATION_API_KEY: 'secret',
      ANTHROPIC_API_KEY: 'k',
    },
  });
  const pendingRestart = () =>
    timers.filter(
      (timer) => !timer.cleared && timer.ms >= 1_000 && timer.ms <= 30_000,
    );
  return {
    runDir,
    killed,
    killedRoots,
    supervisor,
    spawn,
    children,
    timers,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Fire the newest pending restart timer and return its delay. */
    fireRestart() {
      const timer = pendingRestart().at(-1);
      if (!timer) throw new Error('no restart scheduled');
      timer.cleared = true;
      timer.fn();
      return timer.ms;
    },
  };
}

describe('device hub supervisor', () => {
  test('starts on loopback port 0, reads the bound port, and exposes a connection', async () => {
    const h = harness();
    const connection = await h.supervisor.ensureStarted();
    expect(h.children[0]?.args).toEqual([
      '/home/devices/tools/expo-device-hub/0.10.1/node_modules/expo-device-hub/dist/server/cli.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--transport',
      'mjpeg',
      '--hide-sidebar',
      '--hide-boot-device',
    ]);
    expect(connection.baseUrl).toBe('http://127.0.0.1:50000');
    expect(connection.ready).toBe(true);
    expect(h.supervisor.state()).toMatchObject({
      state: 'running',
      version: '0.10.1',
    });
    expect(h.supervisor.connection()).toBe(connection);
  });

  test('the hub sees an allowlisted environment plus its guard, secret and private temp', async () => {
    const h = harness();
    const connection = await h.supervisor.ensureStarted();
    const env = h.children[0]?.env ?? {};
    const guardPath = join(h.runDir, 'hub-guard.cjs');
    const secret = env.STATION_HUB_GUARD_SECRET ?? '';
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}`,
      STATION_HUB_GUARD_SECRET: secret,
      TMPDIR: join(h.runDir, 'tmp'),
      TMP: join(h.runDir, 'tmp'),
      TEMP: join(h.runDir, 'tmp'),
      npm_config_offline: 'true',
      npm_config_proxy: 'http://127.0.0.1:9',
      npm_config_https_proxy: 'http://127.0.0.1:9',
    });
    expect(readFileSync(guardPath, 'utf8')).toContain('x-station-hub-secret');
    // Station's own requests carry the same per-launch secret.
    expect(connection.headers).toEqual({ 'x-station-hub-secret': secret });
    expect(deviceHubEnvironment({ STATION_TOKEN: 'x' })).toEqual({});
  });

  test('each launch gets a fresh secret', async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    await h.supervisor.restart();
    const [first, second] = h.children.map(
      (child) => child.env.STATION_HUB_GUARD_SECRET,
    );
    expect(first).not.toBe(second);
  });

  test('a hub version the guard was not verified against is never launched', async () => {
    const h = harness({ version: '0.11.0' });
    await expect(h.supervisor.ensureStarted()).rejects.toThrow(
      'not verified for expo-device-hub 0.11.0',
    );
    expect(h.spawn).not.toHaveBeenCalled();
  });

  test('stream helpers are denied as listener ports and killed on stop', async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    writeHelperState(h.runDir, 'UDID-1', 90_001, 3100);
    expect(h.supervisor.listeningPorts()).toEqual([3100, 50_000]);
    await h.supervisor.stop();
    expect(h.killed.map((helper) => helper.pid)).toEqual([90_001]);
    expect(h.supervisor.listeningPorts()).toEqual([]);
  });

  test('a crashed hub takes its helpers with it, and a restart reaps leftovers first', async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    writeHelperState(h.runDir, 'UDID-1', 90_001, 3100);
    h.children[0]?.exit(1);
    await vi.waitFor(() => expect(h.killed).toHaveLength(1));
    // A helper recorded before the next launch (e.g. by a killed Station).
    writeHelperState(h.runDir, 'UDID-2', 90_002, 3101);
    h.fireRestart();
    await vi.waitFor(() => expect(h.supervisor.state().state).toBe('running'));
    expect(h.killed.map((helper) => helper.pid)).toEqual([90_001, 90_002]);
    expect(h.supervisor.listeningPorts()).toEqual([50_001]);
    expect(existsSync(join(h.runDir, 'tmp', 'serve-sim'))).toBe(true);
  });

  test('a crash restarts with doubling backoff, then settles in crashed', async () => {
    const h = harness();
    const first = await h.supervisor.ensureStarted();
    const exits: string[] = [];
    first.onExit((reason) => exits.push(reason));
    h.children[0]?.exit(1);
    expect(exits).toEqual(['exited (1)']);
    expect(first.ready).toBe(false);
    expect(h.supervisor.connection()).toBeUndefined();
    expect(h.supervisor.state()).toMatchObject({
      state: 'restarting',
      attempt: 1,
    });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      delays.push(h.fireRestart());
      await vi.waitFor(() =>
        expect(h.supervisor.state().state).toBe('running'),
      );
      h.children.at(-1)?.exit(1);
    }
    delays.push(h.fireRestart());
    await vi.waitFor(() => expect(h.supervisor.state().state).toBe('running'));
    h.children.at(-1)?.exit(1);
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(h.supervisor.state()).toMatchObject({
      state: 'crashed',
      attempts: 5,
    });
    // Crashed waits for a person: nothing further is scheduled.
    expect(() => h.fireRestart()).toThrow('no restart scheduled');
    // A person starting it again clears the crash.
    await h.supervisor.ensureStarted();
    expect(h.supervisor.state().state).toBe('running');
  });

  test('a run that stayed up past the stable window resets the backoff', async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    h.children[0]?.exit(1);
    expect(h.fireRestart()).toBe(1_000);
    await vi.waitFor(() => expect(h.supervisor.state().state).toBe('running'));
    h.advance(61_000);
    h.children.at(-1)?.exit(1);
    expect(h.fireRestart()).toBe(1_000);
  });

  test('a hub that exits before printing its port is a failed attempt, not running', async () => {
    const h = harness({ print: () => '' });
    const start = h.supervisor.ensureStarted();
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]?.exit(1);
    await expect(start).rejects.toThrow('exited (1) before it was ready');
    expect(h.supervisor.state()).toMatchObject({
      state: 'restarting',
      attempt: 1,
    });
    expect(h.supervisor.connection()).toBeUndefined();
  });

  test('a reserved port is refused', async () => {
    const h = harness({ print: () => '  Local:   http://localhost:3141\n' });
    await expect(h.supervisor.ensureStarted()).rejects.toThrow('unusable port');
    expect(h.children[0]?.signals).toContain('SIGTERM');
  });

  test('stop terminates the child, releases it, and schedules no restart', async () => {
    const h = harness();
    const connection = await h.supervisor.ensureStarted();
    await h.supervisor.stop();
    expect(h.children[0]?.signals).toEqual(['SIGTERM']);
    expect(h.children[0]?.released).toBe(true);
    expect(connection.ready).toBe(false);
    expect(h.supervisor.state()).toEqual({ state: 'stopped' });
    expect(() => h.fireRestart()).toThrow('no restart scheduled');
  });

  test('listener ports are cached briefly, then re-read', async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    expect(h.supervisor.listeningPorts()).toEqual([50_000]);
    writeHelperState(h.runDir, 'UDID-9', 90_009, 3109);
    // Within the cache window the read is reused.
    h.advance(400);
    expect(h.supervisor.listeningPorts()).toEqual([50_000]);
    // After it, a new helper's port is denied.
    h.advance(200);
    expect(h.supervisor.listeningPorts()).toEqual([3109, 50_000]);
  });

  test('helpers are killed by the managed tool root, not one version directory', async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    writeHelperState(h.runDir, 'UDID-1', 90_001, 3100);
    await h.supervisor.stop();
    expect(h.killedRoots).toEqual(['/home/devices/tools/expo-device-hub']);
  });
});
