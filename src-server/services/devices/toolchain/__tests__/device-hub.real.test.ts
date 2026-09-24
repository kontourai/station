/**
 * Real device hub lockdown (#1970, design amendment round 5).
 *
 * Part 1 always runs (no hub install needed): real node processes started
 * with the supervisor's exact launch environment prove the guard itself —
 * a guarded server refuses requests without the per-launch secret and
 * refuses exec paths even with it, a guarded process adds the secret to its
 * own loopback requests, it cannot spawn prebuild-install, and a helper this
 * install started is killed.
 *
 * Part 2 runs only when `STATION_DEVICE_HUB_TEST_HOME` names a Station home
 * that already holds a completed managed install of the pinned hub; it
 * never installs or downloads. It launches the REAL hub through the
 * supervisor and proves direct requests without the secret get 403
 * (including `/vendor/serve-sim/api`, `/exec`, WebRTC offers and the
 * `/api/devices/ws` inventory socket), Station's connection still works,
 * and no helper from this home survives stop. When a simulator is already
 * booted it also attaches a real serve-sim helper and proves the helper is
 * guarded; otherwise that case reports an explicit skip.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { LocalMobileDeviceHost } from '../../../mobile-device/mobile-device-host.js';
import {
  deviceHubEndpointFromToolchain,
  explicitDeviceHubEndpoint,
} from '../../device-hub-endpoint.js';
import type { DeviceHubConnection } from '../device-hub-connection.js';
import { buildHubGuardSource } from '../device-hub-guard.js';
import { killOwnedHubHelper, readHubHelpers } from '../device-hub-helpers.js';
import {
  DeviceHubSupervisor,
  deviceHubLaunchEnvironment,
} from '../device-hub-supervisor.js';
import { DeviceToolchain } from '../device-toolchain.js';

const scratch = mkdtempSync(join(tmpdir(), 'station-hub-real-'));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

const HEADER = 'x-station-hub-secret';

function guardedEnv(secret: string) {
  const guardPath = join(scratch, 'hub-guard.cjs');
  writeFileSync(guardPath, buildHubGuardSource());
  const tmp = join(scratch, 'tmp');
  mkdirSync(tmp, { recursive: true });
  return deviceHubLaunchEnvironment(process.env, {
    guardPath,
    secret,
    tmpDir: tmp,
  });
}

/** Run `script` under the guard; resolves with its first stdout line. */
function runGuarded(
  script: string,
  secret: string,
): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(process.execPath, ['-e', script], {
    env: guardedEnv(secret),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const at = out.indexOf('\n');
      if (at !== -1) resolve({ child, line: out.slice(0, at) });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once('exit', (code) =>
      reject(new Error(`guarded child exited ${code}: ${err}`)),
    );
  });
}

async function status(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers, redirect: 'manual' });
  await response.body?.cancel().catch(() => {});
  return response.status;
}

function alive(pid: number | undefined): boolean {
  try {
    process.kill(pid ?? -1, 0);
    return true;
  } catch {
    return false;
  }
}

describe('hub guard in a real node process (no hub needed)', () => {
  test('a guarded child server (a stream helper) needs the secret and never serves exec', async () => {
    const secret = randomBytes(32).toString('hex');
    const { line } = await runGuarded(
      `const s=require('node:http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`,
      secret,
    );
    const base = `http://127.0.0.1:${line}`;
    expect(await status(`${base}/stream.mjpeg`)).toBe(403);
    expect(await status(`${base}/exec`)).toBe(403);
    expect(await status(`${base}/stream.mjpeg`, { [HEADER]: 'wrong' })).toBe(
      403,
    );
    expect(await status(`${base}/stream.mjpeg`, { [HEADER]: secret })).toBe(
      200,
    );
    expect(await status(`${base}/exec`, { [HEADER]: secret })).toBe(403);
    expect(await status(`${base}/x/exec-ws`, { [HEADER]: secret })).toBe(403);
  }, 30_000);

  test('a guarded process adds the secret to its own loopback requests', async () => {
    const secret = randomBytes(32).toString('hex');
    const { line } = await runGuarded(
      `const http=require('node:http');
       const s=http.createServer((q,r)=>r.end('ok'));
       s.listen(0,'127.0.0.1',async()=>{
         const p=s.address().port;
         const viaFetch=(await fetch('http://127.0.0.1:'+p+'/a')).status;
         const viaHttp=await new Promise(res=>http.get('http://127.0.0.1:'+p+'/b',r=>{r.resume();res(r.statusCode)}));
         console.log(JSON.stringify({viaFetch,viaHttp}));
       });`,
      secret,
    );
    expect(JSON.parse(line)).toEqual({ viaFetch: 200, viaHttp: 200 });
  }, 30_000);

  test('a guarded process cannot run prebuild-install (no runtime native download)', async () => {
    const { line } = await runGuarded(
      `try{require('node:child_process').spawn(process.execPath,['/x/node_modules/prebuild-install/bin.js','-r','napi']);console.log('spawned')}catch(e){console.log('refused: '+e.message)}`,
      randomBytes(32).toString('hex'),
    );
    expect(line).toBe(
      'refused: Station hub guard: runtime native downloads (prebuild-install) are disabled.',
    );
  }, 30_000);

  test('a guarded process keeps promisify(execFile) returning {stdout, stderr}', async () => {
    // The hub's simctl/adb helpers use promisify(execFile). A wrapper that
    // drops util.promisify.custom makes it resolve to a bare string, and the
    // hub then lists no devices at all.
    const { line } = await runGuarded(
      `const {promisify}=require('node:util');
       const cp=require('node:child_process');
       (async()=>{
         const r=await promisify(cp.execFile)(process.execPath,['-e','process.stdout.write("hi")']);
         const e=await promisify(cp.exec)(JSON.stringify(process.execPath)+' -e "process.stdout.write(String(1))"');
         let refused='no';
         try{await promisify(cp.execFile)(process.execPath,['/x/node_modules/prebuild-install/bin.js'])}catch(err){refused=err.message}
         console.log(JSON.stringify({execFile:typeof r.stdout==='string'&&r.stdout,exec:typeof e.stdout==='string'&&e.stdout,refused}));
       })();`,
      randomBytes(32).toString('hex'),
    );
    expect(JSON.parse(line)).toEqual({
      execFile: 'hi',
      exec: '1',
      refused:
        'Station hub guard: runtime native downloads (prebuild-install) are disabled.',
    });
  }, 30_000);

  test('helpers of any managed hub version are killed; a look-alike path is not', async () => {
    const toolRoot = join(scratch, 'devices', 'tools', 'expo-device-hub');
    const runDir = join(scratch, 'run');
    const stateDir = join(runDir, 'tmp', 'serve-sim');
    mkdirSync(stateDir, { recursive: true });
    const spawnDummy = (marker: string) => {
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)', marker],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      children.push(child);
      return child;
    };
    const current = spawnDummy(join(toolRoot, '0.10.1', 'serve-sim.js'));
    const orphaned = spawnDummy(join(toolRoot, '0.9.0', 'serve-sim.js'));
    // Shares a prefix with the tool root but is another directory.
    const lookalike = spawnDummy(
      join(`${toolRoot}-other`, '0.10.1', 'serve-sim.js'),
    );
    const foreign = spawnDummy('/somewhere/else/serve-sim.js');
    for (const [name, child, port] of [
      ['CURRENT', current, 3100],
      ['ORPHANED', orphaned, 3101],
      ['LOOKALIKE', lookalike, 3102],
      ['FOREIGN', foreign, 3103],
    ] as const)
      writeFileSync(
        join(stateDir, `server-${name}.json`),
        JSON.stringify({ pid: child.pid, port, device: name }),
      );
    for (const helper of readHubHelpers(runDir))
      await killOwnedHubHelper(helper, toolRoot);
    await expect.poll(() => alive(current.pid), { timeout: 5_000 }).toBe(false);
    await expect
      .poll(() => alive(orphaned.pid), { timeout: 5_000 })
      .toBe(false);
    expect(alive(lookalike.pid)).toBe(true);
    expect(alive(foreign.pid)).toBe(true);
    expect(readHubHelpers(runDir)).toEqual([]);
  }, 30_000);
});

/** Simulators as simctl itself reports them (not via the hub). */
function simulators(filter: 'booted' | 'available'): string[] {
  if (process.platform !== 'darwin') return [];
  const result = spawnSync(
    '/usr/bin/xcrun',
    ['simctl', 'list', 'devices', filter, '-j'],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  if (result.status !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as {
      devices?: Record<string, Array<{ udid: string; state: string }>>;
    };
    return Object.values(parsed.devices ?? {})
      .flat()
      .filter((device) => filter === 'available' || device.state === 'Booted')
      .map((device) => device.udid);
  } catch {
    return [];
  }
}

const home = process.env.STATION_DEVICE_HUB_TEST_HOME;
const toolchain = home
  ? new DeviceToolchain({
      stationHome: home,
      installer: {
        run: async () => {
          throw new Error('the real hub test never installs');
        },
      },
    })
  : undefined;
const entry = toolchain?.installedEntry('expo-device-hub');
const SKIP_REASON = home
  ? `STATION_DEVICE_HUB_TEST_HOME (${home}) has no completed managed expo-device-hub install; this test never downloads.`
  : 'STATION_DEVICE_HUB_TEST_HOME is unset, so no installed managed device hub is available; this test never downloads.';

const runDir = join(scratch, 'hub-run');
const supervisor =
  toolchain && entry
    ? new DeviceHubSupervisor({
        resolveLaunch: () => ({
          entry,
          cwd: toolchain.installDir('expo-device-hub'),
          version: toolchain.pin('expo-device-hub').version,
          runDir,
        }),
      })
    : undefined;

afterAll(async () => {
  await supervisor?.stop();
});

describe('real managed hub under the guard (installed only)', () => {
  let connection: DeviceHubConnection | undefined;

  test('direct requests without the secret are refused everywhere; Station still works', async (ctx) => {
    if (!supervisor) return ctx.skip(SKIP_REASON);
    connection = await supervisor.ensureStarted();
    const base = connection.baseUrl;
    const secret = { ...connection.headers };
    for (const path of [
      '/readyz',
      '/api/devices',
      '/',
      '/vendor/serve-sim/',
      '/vendor/serve-sim/api',
      '/vendor/serve-sim/exec',
    ])
      expect(await status(`${base}${path}`), path).toBe(403);
    // Even with the secret, the shell and config routes stay unreachable.
    for (const path of [
      '/',
      '/vendor/serve-sim/',
      '/vendor/serve-sim/api',
      '/vendor/serve-sim/exec',
      '/vendor/serve-sim/exec-ws',
    ])
      expect(await status(`${base}${path}`, secret), path).toBe(403);
    for (const path of [
      '/vendor/serve-emu/webrtc/offer',
      '/vendor/serve-emu/api/webrtc/offer',
      '/api/devices/create',
      '/api/devices/remove',
    ]) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...secret, 'content-type': 'application/json' },
        body: '{}',
      });
      await response.body?.cancel().catch(() => {});
      expect(response.status, path).toBe(403);
    }
    // Lane F's boot route is admitted by the guard (the hub itself answers
    // an empty body with 400, so nothing is booted).
    const boot = await connection.request('POST', '/api/devices/boot', {
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await boot.body?.cancel().catch(() => {});
    expect(boot.status).toBe(400);
    // Station's own door works.
    const devices = await connection.request('GET', '/api/devices');
    expect(devices.status).toBe(200);
    await devices.body?.cancel().catch(() => {});
    const live = connection;
    const inventory = await new LocalMobileDeviceHost({
      hub: deviceHubEndpointFromToolchain(
        { ensureHub: async () => live },
        explicitDeviceHubEndpoint(undefined),
      ),
    }).inventory();
    expect(['ready', 'partial']).toContain(inventory.state);
    // The hub must see the simulators simctl sees (a guard that breaks
    // promisify(execFile) makes this list silently empty).
    const available = simulators('available');
    if (available.length > 0)
      expect(
        inventory.devices.some((device) => available.includes(device.deviceId)),
        'the hub lists none of the simulators simctl reports',
      ).toBe(true);
    // Every simulator simctl reports booted must be in the hub's inventory:
    // an empty list here is a broken hub, not an idle host.
    for (const udid of simulators('booted'))
      expect(
        inventory.devices.find((device) => device.deviceId === udid),
        `booted ${udid}`,
      ).toMatchObject({ booted: true });
    // The hub port is a Station listener for the host browser.
    expect(supervisor.listeningPorts()).toContain(Number(new URL(base).port));
  }, 60_000);

  test('the device-list WebSocket refuses a connection without the secret', async (ctx) => {
    if (!supervisor || !connection) return ctx.skip(SKIP_REASON);
    const live = connection;
    const port = new URL(live.baseUrl).port;
    const refused = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/devices/ws`, {
        origin: 'http://evil.example',
      });
      socket.once('open', () => {
        socket.close();
        resolve('opened');
      });
      socket.once('unexpected-response', (_req, res) =>
        resolve(`status ${res.statusCode}`),
      );
      socket.once('error', (error) => resolve(`error ${error.message}`));
    });
    expect(refused).not.toBe('opened');
    const accepted = await new Promise<string>((resolve) => {
      const socket = live.openWebSocket('/api/devices/ws');
      socket.once('open', () => {
        socket.close();
        resolve('opened');
      });
      socket.once('error', (error) => resolve(`error ${error.message}`));
    });
    expect(accepted).toBe('opened');
  }, 30_000);

  test('a real serve-sim helper, started as serve-sim starts it, is guarded and killed on stop (needs a booted simulator)', async (ctx) => {
    if (!supervisor || !connection || !toolchain) return ctx.skip(SKIP_REASON);
    const [udid] = simulators('booted');
    if (!udid)
      return ctx.skip(
        'simctl reports no booted iOS simulator on this host; the test does not boot one.',
      );
    // No Station route starts a helper (0.10.1 serves stream.mjpeg from the
    // hub itself), so start one exactly as serve-sim does: its CLI, run by
    // node, inheriting the hub's environment (guard, secret, private TMPDIR).
    const serveSim = join(
      toolchain.installDir('expo-device-hub'),
      'node_modules',
      'expo-device-hub',
      'vendor',
      'serve-sim',
      'dist',
      'serve-sim.js',
    );
    const secret = connection.headers['x-station-hub-secret'] ?? '';
    const env = deviceHubLaunchEnvironment(process.env, {
      guardPath: join(runDir, 'hub-guard.cjs'),
      secret,
      tmpDir: join(runDir, 'tmp'),
    });
    const helper = spawn(
      process.execPath,
      [serveSim, udid, '--port', '0', '--host', '127.0.0.1', '--no-preview'],
      { env, detached: true, stdio: 'ignore', windowsHide: true },
    );
    children.push(helper);
    await expect
      .poll(() => readHubHelpers(runDir).length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    const [state] = readHubHelpers(runDir);
    const helperBase = `http://127.0.0.1:${state?.port}`;
    expect(await status(`${helperBase}/exec`)).toBe(403);
    expect(await status(`${helperBase}/exec`, { [HEADER]: secret })).toBe(403);
    expect(await status(`${helperBase}/`)).toBe(403);
    expect(supervisor.listeningPorts()).toContain(state?.port);
    await supervisor.stop();
    await expect.poll(() => alive(state?.pid), { timeout: 10_000 }).toBe(false);
    expect(readHubHelpers(runDir)).toEqual([]);
  }, 120_000);

  test('after stop the hub port no longer answers and no helper is left', async (ctx) => {
    if (!supervisor || !connection) return ctx.skip(SKIP_REASON);
    const baseUrl = connection.baseUrl;
    await supervisor.stop();
    expect(connection.ready).toBe(false);
    await expect(
      fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toThrow();
    expect(readHubHelpers(runDir)).toEqual([]);
    expect(supervisor.listeningPorts()).toEqual([]);
    expect(readFileSync(join(runDir, 'hub-guard.cjs'), 'utf8')).toContain(
      HEADER,
    );
  }, 30_000);
});
