/**
 * #2442: the Device Tools drawer (and Android rotation) on an SSH device
 * host, through its REAL seams.
 *
 * The device-host program runs for real — through `/bin/sh` and the
 * constant loader, exactly as sshd would run the remote command words — in
 * a private HOME whose PATH starts with stand-ins for `adb` and `xcrun`
 * (they record every argument vector, one word per line, and a push
 * payload's stdin). The Station side runs through `DeviceHostRegistry`
 * with an ssh stand-in that executes the words ssh would send to the host
 * on this machine instead. No ssh, no network, no real device.
 *
 * What this proves: the host program re-checks every vector against the
 * allowlist Station built into it and runs nothing else; Station refuses
 * before any ssh; every value travels on stdin, never a command line; a
 * hostile push payload reaches the tool literally; the deadline and the
 * output bound hold on both ends; consent gates every run (no ssh at all
 * without it); a busy host is `DeviceHostBusyError`, not a refusal; and the
 * accessibility tree is read through THAT host's own hub, with its secret.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEVICE_AX_RESPONSE_MAX_BYTES } from '@kontourai/station-contracts/device-tools';
import { afterEach, describe, expect, test } from 'vitest';
import { createDeviceHostResolver } from '../../device-host-resolver.js';
import { androidRotateCommands } from '../../device-host-tools.js';
import type { DeviceHubEndpoint } from '../../device-hub-endpoint.js';
import { DeviceLiveSurfaceProducer } from '../../device-live-surface-producer.js';
import { DeviceHostBusyError } from '../../device-shares.js';
import {
  DEVICE_TOOL_ARGV_SHAPES,
  DeviceToolsError,
} from '../../device-tools.js';
import {
  createDeviceHubConnection,
  HUB_SECRET_HEADER,
} from '../../toolchain/device-hub-connection.js';
import { DeviceHostRegistry } from '../device-host-registry.js';
import { RemoteDeviceHostServices } from '../device-host-services.js';
import { DeviceHostStore } from '../device-host-store.js';
import type { SshDeviceHub } from '../ssh-device-hub.js';
import {
  REMOTE_DEVICE_HOST_SCRIPT,
  type RemoteDeviceHostParams,
} from '../ssh-device-remote-script.js';
import {
  createEventReader,
  remoteHeader,
  type SpawnSsh,
} from '../ssh-device-session.js';
import {
  buildSshDeviceCommandArgs,
  parseSshDeviceTarget,
  remoteLoaderCommand,
} from '../ssh-device-target.js';
import {
  SSH_DEVICE_TOOL_ALLOWLIST_JSON,
  SSH_DEVICE_TOOL_ARGV_SHAPES,
  serializeArgvShapes,
} from '../ssh-device-tool-allowlist.js';
import {
  createSshDeviceHostActions,
  createSshDeviceToolRunner,
  createSshDeviceToolsService,
  isValidSshToolRequest,
  runSshDeviceTool,
  type SshDeviceToolHost,
  type SshToolControl,
  type SshToolOutcome,
  type SshToolRequest,
} from '../ssh-device-tools.js';
import { FakeSsh } from './fake-ssh.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const UDID = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
const SERIAL = 'emulator-5554';
const SSH_TARGET = 'tester@mac-mini';

/** Every word it was given, one per line, then what the call should do. */
const LOG_CALL = (tool: string) => `calls="$HOME/calls"
mkdir -p "$calls"
n=$(ls "$calls" | wc -l | tr -d ' ')
file="$calls/$n-$$.${tool}"
: > "$file"
for a in "$@"; do printf '%s\\n' "$a" >> "$file"; done
mode=$(cat "$HOME/mode" 2>/dev/null)
case "$mode" in
  sleep) exec sleep 5 ;;
  flood) head -c 300000 /dev/zero | tr '\\000' x; exit 0 ;;
  fail) exit 1 ;;
  failemu) case "$*" in *" emu "*) exit 1 ;; esac ;;
  failwrite) case "$*" in *WRITE_CONTACTS*) exit 1 ;; esac ;;
esac
`;

const STAND_IN_ADB = `#!/bin/sh
${LOG_CALL('adb')}
case "$*" in
  *" uimode night") echo "Night mode: yes" ;;
  *" dumpsys location") echo "  last location=Location[gps 51.507400,-0.127800 hAcc=5]" ;;
  *" dumpsys window") echo "  mCurrentFocus=Window{1a2b u0 com.example.app/com.example.app.Main}" ;;
esac
exit 0
`;

const STAND_IN_XCRUN = `#!/bin/sh
${LOG_CALL('xcrun')}
case "$*" in
  "simctl ui "*" appearance") echo dark ;;
  "simctl push "*) cat > "$HOME/push-stdin" ;;
esac
exit 0
`;

/**
 * A private host HOME: `node` (this one), `adb` and `xcrun` stand-ins in
 * `$HOME/.local/bin`, which the program's prelude puts FIRST on PATH — so a
 * real adb or xcrun on this machine is never reached.
 */
function hostHome(): string {
  const home = tempDir('station-ssh-tools-host-');
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const [name, source] of [
    ['adb', STAND_IN_ADB],
    ['xcrun', STAND_IN_XCRUN],
  ] as const) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  return home;
}

/** The calls the stand-ins recorded, in order. */
function recordedCalls(home: string): { tool: string; args: string[] }[] {
  const dir = join(home, 'calls');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => {
      const [n, rest] = name.split('-');
      return { n: Number(n), tool: rest!.split('.')[1]!, name };
    })
    .sort((a, b) => a.n - b.n)
    .map(({ tool, name }) => ({
      tool,
      args: readFileSync(join(dir, name), 'utf8').split('\n').slice(0, -1),
    }));
}

const HOSTILE = `$(touch "$HOME/pwned-subst") \`touch "$HOME/pwned-tick"\` '; touch "$HOME/pwned-quote"; ' " | & > "$HOME/pwned-redirect" ; \\ \n\t%s %n`;

function pwned(home: string): string[] {
  return readdirSync(home).filter((name) => name.startsWith('pwned'));
}

/** The host side of an ssh session: `/bin/sh -c <the remote words>`. */
function runHostWords(home: string, words: string) {
  const child = spawn('/bin/sh', ['-c', words], {
    env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  cleanups.push(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Gone.
    }
  });
  return child;
}

/** Run the program once with `params`, as a session would. */
async function runProgram(
  home: string,
  params: unknown,
  options: { closeStdinWhen?: () => boolean } = {},
) {
  const child = runHostWords(home, remoteLoaderCommand().join(' '));
  const events: Record<string, unknown>[] = [];
  child.stdout.on(
    'data',
    createEventReader((event) => events.push(event), 1024 * 1024),
  );
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  const closeWhen = options.closeStdinWhen;
  if (!closeWhen)
    child.stdin.end(remoteHeader(params as RemoteDeviceHostParams));
  else {
    child.stdin.write(remoteHeader(params as RemoteDeviceHostParams));
    const poll = setInterval(() => {
      if (!closeWhen()) return;
      clearInterval(poll);
      child.stdin.end();
    }, 20);
    cleanups.push(() => clearInterval(poll));
  }
  const code = await exited;
  return { code, events };
}

const tool = (
  toolName: unknown,
  args: unknown,
  extra: Record<string, unknown> = {},
) => ({
  mode: 'tool',
  tool: toolName,
  args,
  timeoutMs: 10_000,
  maxBuffer: 256 * 1024,
  ...extra,
});

const decoded = (event: Record<string, unknown> | undefined) =>
  Buffer.from(String(event?.stdout), 'base64').toString('utf8');

describe('the host program’s tool mode (run for real, no ssh)', () => {
  test('runs an allowlisted vector with each argument its own literal word, and returns its output', async () => {
    const home = hostHome();
    const geo = ['-s', SERIAL, 'emu', 'geo', 'fix', '-0.127800', '51.507400'];
    const night = ['-s', SERIAL, 'shell', 'cmd', 'uimode', 'night'];
    const first = await runProgram(home, tool('adb', geo));
    expect(first.events).toEqual([{ event: 'tool', ok: true, stdout: '' }]);
    const second = await runProgram(home, tool('adb', night));
    expect(decoded(second.events[0])).toBe('Night mode: yes\n');
    expect(recordedCalls(home)).toEqual([
      { tool: 'adb', args: geo },
      { tool: 'adb', args: night },
    ]);
  });

  test('refuses, on the HOST, any vector outside the allowlist Station built into it — nothing runs', async () => {
    const home = hostHome();
    const refused: [unknown, unknown][] = [
      ['adb', ['-s', SERIAL, 'shell', 'rm', '-rf', '/']],
      ['adb', ['-s', `${SERIAL};touch "$HOME/pwned-serial"`, 'emu', 'avd']],
      ['adb', ['-s', SERIAL, 'shell', 'dumpsys', 'package', 'com.x;id']],
      ['adb', ['-s', SERIAL, 'shell', 'cmd', 'uimode', 'night', 'yes', '-x']],
      ['adb', `-s ${SERIAL} shell dumpsys window`],
      ['xcrun', ['simctl', 'spawn', UDID, 'launchctl', 'list']],
      ['xcrun', ['simctl', 'push', UDID, 'com.example.app', HOSTILE]],
      ['sh', ['-c', 'touch "$HOME/pwned-sh"']],
      ['__proto__', []],
      ['constructor', []],
      // L1: a tool name that is not a string never reaches the lookup.
      [['adb'], ['-s', SERIAL, 'shell', 'dumpsys', 'window']],
    ];
    for (const [name, args] of refused) {
      const run = await runProgram(home, tool(name, args));
      expect(
        run.events,
        `${JSON.stringify(name)} ${JSON.stringify(args)}`,
      ).toEqual([{ event: 'tool', ok: false, failure: 'tool-refused' }]);
    }
    expect(recordedCalls(home)).toEqual([]);
    expect(pwned(home)).toEqual([]);
  });

  test('a push payload reaches the tool on stdin, byte for byte: shell metacharacters stay data', async () => {
    const home = hostHome();
    const payload = JSON.stringify({ aps: { alert: HOSTILE } });
    const push = ['simctl', 'push', UDID, 'com.example.app', '-'];
    const run = await runProgram(home, tool('xcrun', push, { stdin: payload }));
    expect(run.events).toEqual([{ event: 'tool', ok: true, stdout: '' }]);
    expect(readFileSync(join(home, 'push-stdin'), 'utf8')).toBe(payload);
    expect(recordedCalls(home)).toEqual([{ tool: 'xcrun', args: push }]);
    expect(pwned(home)).toEqual([]);
  });

  test('the hard deadline kills a tool that does not finish, and answers at once', async () => {
    const home = hostHome();
    writeFileSync(join(home, 'mode'), 'sleep');
    const started = Date.now();
    const run = await runProgram(
      home,
      tool('adb', ['-s', SERIAL, 'shell', 'dumpsys', 'location'], {
        timeoutMs: 300,
      }),
    );
    expect(run.events).toEqual([
      { event: 'tool', ok: false, failure: 'tool-timeout', applied: 0 },
    ]);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test('output past the bound kills the tool and fails it; a failing tool is tool-failed', async () => {
    const home = hostHome();
    writeFileSync(join(home, 'mode'), 'flood');
    const window = ['-s', SERIAL, 'shell', 'dumpsys', 'window'];
    const flooded = await runProgram(
      home,
      tool('adb', window, { maxBuffer: 100_000 }),
    );
    expect(flooded.events).toEqual([
      { event: 'tool', ok: false, failure: 'tool-failed', applied: 0 },
    ]);
    writeFileSync(join(home, 'mode'), 'fail');
    const failed = await runProgram(home, tool('adb', window));
    expect(failed.events).toEqual([
      { event: 'tool', ok: false, failure: 'tool-failed', applied: 0 },
    ]);
  });

  test('a request outside the program’s limits is a protocol error, and nothing runs', async () => {
    const home = hostHome();
    const window = ['-s', SERIAL, 'shell', 'dumpsys', 'window'];
    for (const extra of [
      { timeoutMs: 0 },
      { timeoutMs: 60_001 },
      { timeoutMs: '10' },
      { maxBuffer: 8 * 1024 * 1024 + 1 },
      { stdin: 'x'.repeat(8 * 1024 + 1) },
      { stdin: 7 },
    ]) {
      const run = await runProgram(home, tool('adb', window, extra));
      expect(run.events, JSON.stringify(extra).slice(0, 60)).toEqual([
        { event: 'error', failure: 'protocol' },
      ]);
    }
    expect(recordedCalls(home)).toEqual([]);
  });

  test('a sequence runs in order, stops at its first failure, and says how many steps applied', async () => {
    const home = hostHome();
    const [first, ...followedBy] = androidRotateCommands(
      SERIAL,
      'landscape-left',
    );
    const ok = await runProgram(home, tool('adb', first, { followedBy }));
    expect(ok.events).toEqual([{ event: 'tool', ok: true, stdout: '' }]);
    expect(recordedCalls(home).map((call) => call.args)).toEqual([
      first,
      ...followedBy,
    ]);
    writeFileSync(join(home, 'mode'), 'failemu');
    const partial = await runProgram(home, tool('adb', first, { followedBy }));
    expect(partial.events).toEqual([
      { event: 'tool', ok: false, failure: 'tool-failed', applied: 2 },
    ]);
  });

  test('every vector of a sequence is checked before the first runs; a sequence never carries stdin', async () => {
    const home = hostHome();
    const [first, second] = androidRotateCommands(SERIAL, 'portrait');
    const refused = await runProgram(
      home,
      tool('adb', first, {
        followedBy: [second, ['-s', SERIAL, 'shell', 'rm', '-rf', '/']],
      }),
    );
    expect(refused.events).toEqual([
      { event: 'tool', ok: false, failure: 'tool-refused' },
    ]);
    const withStdin = await runProgram(
      home,
      tool('adb', first, { followedBy: [second], stdin: '{}' }),
    );
    expect(withStdin.events).toEqual([{ event: 'error', failure: 'protocol' }]);
    expect(recordedCalls(home)).toEqual([]);
  });

  test('stdin closing (Station killed its ssh) kills the running step and starts nothing more', async () => {
    const home = hostHome();
    writeFileSync(join(home, 'mode'), 'sleep');
    const [first, ...followedBy] = androidRotateCommands(
      SERIAL,
      'landscape-left',
    );
    const started = Date.now();
    const run = await runProgram(
      home,
      tool('adb', first, { followedBy, cancelOnClose: true }),
      // Once the first step is running (it sleeps), as Station would.
      { closeStdinWhen: () => recordedCalls(home).length > 0 },
    );
    expect(run.events).toEqual([
      { event: 'tool', ok: false, failure: 'cancelled', applied: 0 },
    ]);
    expect(Date.now() - started).toBeLessThan(4_000);
    // Give a wrongly started next step time to show up.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(recordedCalls(home).map((call) => call.args)).toEqual([first]);
  });

  test('`followedBy: null` is refused on both sides alike (round 3, N1)', async () => {
    const home = hostHome();
    const window = ['-s', SERIAL, 'shell', 'dumpsys', 'window'];
    const run = await runProgram(
      home,
      tool('adb', window, { followedBy: null }),
    );
    expect(run.events).toEqual([{ event: 'error', failure: 'protocol' }]);
    expect(recordedCalls(home)).toEqual([]);
    expect(
      isValidSshToolRequest({
        tool: 'adb',
        args: window,
        followedBy: null as never,
        timeoutMs: 1_000,
        maxBuffer: 1_000,
      }),
    ).toBe(false);
  });

  test('the host’s allowlist is exactly Station’s — the drawer’s shapes and rotation’s — built into the program source', () => {
    expect(REMOTE_DEVICE_HOST_SCRIPT).toContain(
      `const TOOL_SHAPES = ${SSH_DEVICE_TOOL_ALLOWLIST_JSON};`,
    );
    const shapes = JSON.parse(SSH_DEVICE_TOOL_ALLOWLIST_JSON);
    expect(shapes).toEqual(serializeArgvShapes(SSH_DEVICE_TOOL_ARGV_SHAPES));
    expect(Object.keys(shapes).sort()).toEqual(['adb', 'xcrun']);
    expect(shapes.xcrun).toEqual(
      serializeArgvShapes(DEVICE_TOOL_ARGV_SHAPES).xcrun,
    );
    expect(shapes.adb).toHaveLength(DEVICE_TOOL_ARGV_SHAPES.adb.length + 3);
  });
});

/** An ssh stand-in: runs the words ssh would send, on this machine. */
function sshToHome(
  home: string,
  spawned: string[][],
  killed: string[][] = [],
): SpawnSsh {
  return (args) => {
    spawned.push(args);
    const words = args.slice(args.indexOf('--') + 2).join(' ');
    const child = runHostWords(home, words);
    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      onExit: (listener) => {
        child.once('exit', (code, signal) => listener(code, signal));
      },
      onError: (listener) => {
        child.once('error', listener);
      },
      // Killing the local ssh closes the session: the host program sees
      // its stdin close (it is not signalled itself), as over real ssh.
      kill: () => {
        killed.push(args);
        child.stdin.end();
      },
      release: () => {},
    };
  };
}

function stationSide(
  options: {
    enabled?: boolean;
    spawn?: SpawnSsh;
    hub?: Partial<SshDeviceHub>;
  } = {},
) {
  const home = hostHome();
  const stationHome = tempDir('station-ssh-tools-station-');
  const spawned: string[][] = [];
  const killed: string[][] = [];
  const store = new DeviceHostStore(stationHome);
  const host = store.add({ label: 'Lab Mac', sshTarget: SSH_TARGET });
  if (options.enabled !== false) store.setHubEnabled(host.hostId, true);
  const registry = new DeviceHostRegistry({
    stationHome,
    store,
    localHub: () => undefined,
    spawn: options.spawn ?? sshToHome(home, spawned, killed),
    createHub: (hubOptions) =>
      ({
        hostId: hubOptions.hostId,
        state: () => ({ state: 'stopped' as const }),
        listeningPorts: () => [],
        ensureStarted: async () => {
          throw new Error('no hub in this test');
        },
        stop: async () => {},
        connection: () => undefined,
        ...options.hub,
      }) as unknown as SshDeviceHub,
  });
  cleanups.push(() => registry.shutdown());
  const hostId = host.hostId;
  const service = createSshDeviceToolsService({
    hostId,
    host: registry,
    endpoint: registry.endpoint(hostId),
  });
  const android = { hostId, platform: 'android' as const, deviceId: SERIAL };
  const ios = { hostId, platform: 'ios' as const, deviceId: UDID };
  return {
    home,
    registry,
    store,
    hostId,
    service,
    spawned,
    killed,
    android,
    ios,
  };
}

const constantSsh = () =>
  buildSshDeviceCommandArgs(parseSshDeviceTarget(SSH_TARGET));

describe('Station side, through the registry (the real program behind an ssh stand-in)', () => {
  test('an Android snapshot on an SSH host is read ON that host; every ssh is the constant command', async () => {
    const { home, service, spawned, android, hostId } = stationSide();
    const snapshot = await service.snapshot(android);
    expect(snapshot).toMatchObject({
      hostId,
      appearance: { state: 'read', value: 'dark' },
      location: {
        state: 'read',
        value: { latitude: 51.5074, longitude: -0.1278 },
      },
      foregroundApp: { state: 'read', value: { appId: 'com.example.app' } },
    });
    expect(
      recordedCalls(home)
        .map((call) => call.args.join(' '))
        .sort(),
    ).toEqual(
      [
        `-s ${SERIAL} shell cmd uimode night`,
        `-s ${SERIAL} shell dumpsys location`,
        `-s ${SERIAL} shell dumpsys window`,
      ].sort(),
    );
    expect(spawned).toHaveLength(3);
    for (const args of spawned) expect(args).toEqual(constantSsh());
  });

  test('a hostile push payload goes to xcrun on stdin, literally — never onto any command line', async () => {
    const { home, service, spawned, ios } = stationSide();
    const payload = { aps: { alert: HOSTILE } };
    const result = await service.act(ios, {
      type: 'send-push',
      appId: 'com.example.app',
      payload,
    });
    expect(result.push).toBe('sent');
    expect(readFileSync(join(home, 'push-stdin'), 'utf8')).toBe(
      JSON.stringify(payload),
    );
    expect(recordedCalls(home)[0]).toEqual({
      tool: 'xcrun',
      args: ['simctl', 'push', UDID, 'com.example.app', '-'],
    });
    for (const args of spawned) expect(args).toEqual(constantSsh());
    expect(pwned(home)).toEqual([]);
  });

  test('Station refuses a vector outside the allowlist before any ssh starts', async () => {
    const { registry, hostId, spawned } = stationSide();
    const runner = createSshDeviceToolRunner(registry, hostId);
    for (const args of [
      ['-s', SERIAL, 'shell', 'rm', '-rf', '/'],
      ['-s', SERIAL, 'shell', 'dumpsys', 'package', 'com.x;id'],
      ['-s', `${SERIAL} `, 'shell', 'dumpsys', 'window'],
    ])
      await expect(
        runner.run('adb', args, { timeoutMs: 1_000 }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      runner.run('sh' as 'adb', ['-c', 'id'], { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    let direct = 0;
    const outcome = await runSshDeviceTool({
      target: parseSshDeviceTarget(SSH_TARGET),
      request: {
        tool: 'xcrun',
        args: ['simctl', 'spawn', UDID, 'ls'],
        timeoutMs: 1_000,
        maxBuffer: 1_000,
      },
      spawn: () => {
        direct += 1;
        throw new Error('must not spawn');
      },
    });
    expect(outcome).toEqual({ ok: false, failure: 'tool-refused' });
    expect(direct).toBe(0);
    expect(spawned).toEqual([]);
  });

  test('consent: on a host whose operator has not enabled it nothing runs — not even ssh', async () => {
    const { registry, service, spawned, android, hostId } = stationSide({
      enabled: false,
    });
    await expect(
      service.act(android, { type: 'set-appearance', appearance: 'dark' }),
    ).rejects.toMatchObject({ code: 'device-host-not-enabled' });
    const snapshot = await service.snapshot(android);
    expect(snapshot.appearance).toEqual({
      state: 'unreadable',
      reason: 'device-host-not-enabled',
    });
    await expect(
      createSshDeviceHostActions(registry, hostId).rotateAndroid(
        SERIAL,
        'landscape-left',
        2_000,
      ),
    ).rejects.toMatchObject({ code: 'device-host-not-enabled' });
    expect(spawned).toEqual([]);
  });

  test('consent withdrawn while a run waits for a slot: it never runs', async () => {
    const hung: FakeSsh[] = [];
    const { registry, store, hostId } = stationSide({
      spawn: (args) => {
        const child = new FakeSsh(args);
        hung.push(child);
        return child;
      },
    });
    const window = {
      tool: 'adb' as const,
      args: ['-s', SERIAL, 'shell', 'dumpsys', 'window'],
      timeoutMs: 60_000,
      maxBuffer: 1_000,
    };
    const running = [
      registry.runTool(hostId, window),
      registry.runTool(hostId, window),
    ];
    const waiting = registry.runTool(hostId, window);
    await new Promise((resolve) => setImmediate(resolve));
    expect(hung).toHaveLength(2);
    // Withdrawn at the store (the check after the wait is what stops it)…
    store.setHubEnabled(hostId, false);
    hung[0]!.exit(0);
    expect(await waiting).toEqual({ ok: false, failure: 'not-enabled' });
    expect(hung).toHaveLength(2);
    // …and through the operator's own switch: a run already past the queue
    // sees the host changed, and the one still running is cancelled.
    store.setHubEnabled(hostId, true);
    const queued = registry.runTool(hostId, window);
    await registry.setHubEnabled(hostId, { enabled: false });
    expect(await queued).toEqual({ ok: false, failure: 'host-unavailable' });
    // The run that was still going is cancelled, its ssh killed at once.
    expect(await running[1]).toEqual({
      ok: false,
      failure: 'host-unavailable',
    });
    expect(hung[1]!.killed).toEqual(['SIGKILL']);
    await running[0];
    expect(hung).toHaveLength(2);
  });

  test('a busy host (slots shared with AVD lookups, queue full) is DeviceHostBusyError, never a refusal', async () => {
    const hung: FakeSsh[] = [];
    const { registry, service, android, hostId } = stationSide({
      spawn: (args) => {
        const child = new FakeSsh(args);
        hung.push(child);
        return child;
      },
    });
    const window = {
      tool: 'adb' as const,
      args: ['-s', SERIAL, 'shell', 'dumpsys', 'window'],
      timeoutMs: 60_000,
      maxBuffer: 1_000,
    };
    // Two running (the most tool runs a host takes), sixteen waiting: the
    // host's whole budget.
    const pending = Array.from({ length: 18 }, () =>
      registry.runTool(hostId, window).catch(() => undefined),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(hung).toHaveLength(2);
    await expect(
      service.act(android, { type: 'set-appearance', appearance: 'dark' }),
    ).rejects.toBeInstanceOf(DeviceHostBusyError);
    // Tool runs never hold every slot (review M2): an AVD lookup — which a
    // tool run's own post-wait D12 re-check may need — still runs.
    const avd = registry.resolveAndroidAvd(hostId, 'emulator-5556');
    await new Promise((resolve) => setImmediate(resolve));
    expect(hung).toHaveLength(3);
    expect(hung[2]!.params()).toEqual({ mode: 'avd', serial: 'emulator-5556' });
    await registry.shutdown();
    await Promise.all([...pending, avd]);
  });

  test('a run waiting for a slot is bounded by the CALLER’S deadline and signal, and runs nothing after either', async () => {
    const hung: FakeSsh[] = [];
    const { registry, hostId } = stationSide({
      spawn: (args) => {
        const child = new FakeSsh(args);
        hung.push(child);
        return child;
      },
    });
    const window = {
      tool: 'adb' as const,
      args: ['-s', SERIAL, 'shell', 'dumpsys', 'window'],
      timeoutMs: 60_000,
      maxBuffer: 1_000,
    };
    const running = [
      registry.runTool(hostId, window),
      registry.runTool(hostId, window),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    const started = Date.now();
    expect(
      await registry.runTool(hostId, window, { deadlineAt: Date.now() + 150 }),
    ).toEqual({ ok: false, failure: 'tool-timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
    const abort = new AbortController();
    const cancelled = registry.runTool(hostId, window, {
      signal: abort.signal,
    });
    const asked: string[] = [];
    const next = registry.runTool(hostId, window, {
      beforeRun: () => {
        asked.push(`beforeRun with ${hung.length} ssh started`);
      },
    });
    abort.abort();
    expect(await cancelled).toEqual({ ok: false, failure: 'cancelled' });
    // The slot goes to the next waiter; the cancelled one never ran, and
    // `beforeRun` is asked only once the slot is granted, before its ssh.
    expect(asked).toEqual([]);
    hung[0]!.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toEqual(['beforeRun with 2 ssh started']);
    expect(hung).toHaveLength(3);
    hung[1]!.exit(0);
    hung[2]!.exit(0);
    await Promise.all([...running, next]);
  });

  test('a timeout above the host’s ceiling is clamped, not refused', async () => {
    const children: FakeSsh[] = [];
    const { registry, hostId } = stationSide({
      spawn: (args) => {
        const child = new FakeSsh(args);
        children.push(child);
        child.stdin.on('data', () => {
          if (children.length === 1 && child.stdinText.includes('\n')) {
            child.stdout.write('{"event":"tool","ok":true,"stdout":""}\n');
            child.exit(0);
          }
        });
        return child;
      },
    });
    const outcome = await createSshDeviceToolRunner(registry, hostId).run(
      'adb',
      ['-s', SERIAL, 'shell', 'dumpsys', 'window'],
      { timeoutMs: 120_000 },
    );
    expect(outcome).toBe('');
    expect(children[0]!.params()).toMatchObject({ timeoutMs: 60_000 });
  });

  test('Station’s own hard deadline ends a run whose host never answers, and kills the ssh', async () => {
    const children: FakeSsh[] = [];
    const started = Date.now();
    const outcome = await runSshDeviceTool({
      target: parseSshDeviceTarget(SSH_TARGET),
      request: {
        tool: 'adb',
        args: ['-s', SERIAL, 'shell', 'dumpsys', 'window'],
        timeoutMs: 200,
        maxBuffer: 1_000,
      },
      spawn: (args) => {
        const child = new FakeSsh(args);
        children.push(child);
        return child;
      },
    });
    expect(outcome).toEqual({ ok: false, failure: 'tool-timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(children[0]?.killed).toContain('SIGKILL');
  });

  test('Station bounds what it reads back: past the bound the ssh is killed and the run fails', async () => {
    const children: FakeSsh[] = [];
    const outcome = await runSshDeviceTool({
      target: parseSshDeviceTarget(SSH_TARGET),
      request: {
        tool: 'adb',
        args: ['-s', SERIAL, 'shell', 'dumpsys', 'window'],
        timeoutMs: 5_000,
        maxBuffer: 1_000,
      },
      spawn: (args) => {
        const child = new FakeSsh(args);
        children.push(child);
        child.stdin.once('data', () =>
          child.stdout.write(
            `{"event":"tool","ok":true,"stdout":"${'QUFB'.repeat(5_000)}"}\n`,
          ),
        );
        return child;
      },
    });
    expect(outcome).toEqual({ ok: false, failure: 'tool-failed' });
    expect(children[0]?.killed).toContain('SIGKILL');
  });

  test('a permission group is ONE run: one slot, one re-admission after it, nothing waiting after the decision (round 3, D2)', async () => {
    const { home, registry, hostId, android } = stationSide();
    const runs: { request: SshToolRequest; control?: SshToolControl }[] = [];
    const events: string[] = [];
    const service = createSshDeviceToolsService({
      hostId,
      host: {
        generation: (id) => registry.generation(id),
        runTool: (id, request, control) => {
          runs.push({ request, ...(control ? { control } : {}) });
          return registry.runTool(id, request, {
            ...control,
            beforeRun: async () => {
              events.push(`readmit before ${recordedCalls(home).length} calls`);
              await control?.beforeRun?.();
            },
          });
        },
      },
      endpoint: registry.endpoint(hostId),
    });
    let readmits = 0;
    await service.act(
      android,
      {
        type: 'set-permission',
        appId: 'com.example.app',
        permission: 'contacts',
        decision: 'grant',
      },
      {
        beforeRun: async () => {
          readmits += 1;
        },
      },
    );
    const group = runs.filter((run) => run.request.args.includes('pm'));
    expect(group).toHaveLength(1);
    expect(group[0]!.request).toMatchObject({
      keepGoing: true,
      followedBy: [
        [
          '-s',
          SERIAL,
          'shell',
          'pm',
          'grant',
          'com.example.app',
          'android.permission.WRITE_CONTACTS',
        ],
      ],
    });
    expect(readmits).toBe(1);
    expect(events[0]).toBe('readmit before 0 calls');
    expect(
      recordedCalls(home)
        .map((call) => call.args.join(' '))
        .filter((args) => args.includes(' pm ')),
    ).toEqual([
      `-s ${SERIAL} shell pm grant com.example.app android.permission.READ_CONTACTS`,
      `-s ${SERIAL} shell pm grant com.example.app android.permission.WRITE_CONTACTS`,
    ]);
  });

  test('a group that applied some vectors before timing out answers as the local loop does: success, and the read-back says what holds (final review R1)', async () => {
    const outcomes: SshToolOutcome[] = [
      { ok: false, failure: 'tool-timeout', applied: 1 },
      { ok: false, failure: 'tool-timeout', applied: 0 },
      { ok: false, failure: 'tool-timeout' },
    ];
    const results: string[] = [];
    for (const outcome of outcomes) {
      const readBacks: string[] = [];
      const host: SshDeviceToolHost = {
        generation: () => 0,
        runTool: async (_hostId, request) => {
          if (request.keepGoing) return outcome;
          readBacks.push(request.args.join(' '));
          return { ok: true, stdout: '' };
        },
      };
      const service = createSshDeviceToolsService({
        hostId: 'ssh-0123456789ab',
        host,
        endpoint: {
          connect: async () => ({ ok: false, failure: 'hub-unavailable' }),
        },
      });
      const result = await service
        .act(
          {
            hostId: 'ssh-0123456789ab',
            platform: 'android',
            deviceId: SERIAL,
          },
          {
            type: 'set-permission',
            appId: 'com.example.app',
            permission: 'contacts',
            decision: 'grant',
          },
        )
        .then(
          (value) =>
            `resolved; permissions read back: ${value.permissions ? 'yes' : 'no'}; package dumped: ${readBacks.some((args) => args.includes('dumpsys package'))}`,
          (error: { code?: string }) => `threw ${error.code}`,
        );
      results.push(result);
    }
    expect(results).toEqual([
      'resolved; permissions read back: yes; package dumped: true',
      'threw tool-timeout',
      'threw tool-timeout',
    ]);
  });

  test('in that one run a permission `pm` refuses is passed over, as the local loop does', async () => {
    const { home, service, android } = stationSide();
    writeFileSync(join(home, 'mode'), 'failwrite');
    const result = await service.act(android, {
      type: 'set-permission',
      appId: 'com.example.app',
      permission: 'contacts',
      decision: 'grant',
    });
    expect(result.action).toBe('set-permission');
    expect(
      recordedCalls(home).filter((call) => call.args.includes('pm')),
    ).toHaveLength(2);
  });

  test('Android rotation on an SSH host runs the same three adb vectors there, in order, in ONE ssh run', async () => {
    const { home, registry, hostId, spawned } = stationSide();
    await createSshDeviceHostActions(registry, hostId).rotateAndroid(
      SERIAL,
      'landscape-left',
      10_000,
    );
    expect(recordedCalls(home)).toEqual(
      androidRotateCommands(SERIAL, 'landscape-left').map((args) => ({
        tool: 'adb',
        args,
      })),
    );
    expect(spawned).toHaveLength(1);
  });

  test('a rotation that stops early is reported as partial, and the rotating step is the one left out', async () => {
    const { home, registry, hostId } = stationSide();
    writeFileSync(join(home, 'mode'), 'failemu');
    await expect(
      createSshDeviceHostActions(registry, hostId).rotateAndroid(
        SERIAL,
        'landscape-left',
        10_000,
      ),
    ).rejects.toMatchObject({
      code: 'tool-failed',
      message:
        'rotation partly applied: 2 of 3 steps; the rotating step did not complete',
    });
  });

  test('a tool error on the host keeps its type: tool-failed, not a host failure', async () => {
    const { home, service, android } = stationSide();
    writeFileSync(join(home, 'mode'), 'fail');
    const error = await service
      .act(android, { type: 'set-appearance', appearance: 'dark' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeviceToolsError);
    expect(error).toMatchObject({ code: 'tool-failed' });
  });
});

/**
 * Review M1: rotation goes through the REAL producer's dispatch deadline
 * (`bounded`), on a host whose slots are all taken by drawer reads.
 */
describe('an SSH-host rotation through the producer’s dispatch deadline', () => {
  function contended(dispatchTimeoutMs: number) {
    const hung: FakeSsh[] = [];
    const env = stationSide({
      spawn: (args) => {
        const child = new FakeSsh(args);
        hung.push(child);
        return child;
      },
    });
    const window = {
      tool: 'adb' as const,
      args: ['-s', SERIAL, 'shell', 'dumpsys', 'window'],
      timeoutMs: 60_000,
      maxBuffer: 1_000,
    };
    // Both tool slots held by drawer reads that do not finish on their own.
    const reads = [
      env.registry.runTool(env.hostId, window),
      env.registry.runTool(env.hostId, window),
    ];
    const producer = new DeviceLiveSurfaceProducer({
      surfaceId: 'device:android:ssh-test',
      hostId: env.hostId,
      platform: 'android',
      deviceId: SERIAL,
      hub: {
        connect: async () => ({ ok: false, failure: 'hub-unavailable' }),
        screenshot: async () => {
          throw new Error('not in this test');
        },
      },
      actions: createSshDeviceHostActions(env.registry, env.hostId),
      dispatchTimeoutMs,
    });
    cleanups.push(async () => {
      await producer.dispose();
      for (const child of hung) child.exit(0);
      await Promise.allSettled(reads);
    });
    return { ...env, hung, producer };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  /**
   * The client is told the rotation timed out: by the producer's own
   * deadline (`dispatch-timeout`) or, when the action's identical deadline
   * fires a tick sooner, by the action (`tool-timeout`). Either way it was
   * told it failed; what these tests pin is that nothing runs after that.
   */
  const toldTimedOut = (error: unknown) =>
    ['dispatch-timeout', 'tool-timeout'].includes(
      String((error as { code?: unknown }).code),
    );

  test('once the client is told dispatch-timeout, the queued rotation never runs', async () => {
    const { hung, producer } = contended(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(hung).toHaveLength(2);
    await expect(
      producer.dispatch({ kind: 'rotate', orientation: 'landscape-left' }),
    ).rejects.toSatisfy(toldTimedOut);
    // The host frees up after the client was told it failed.
    hung[0]!.exit(0);
    hung[1]!.exit(0);
    await settle();
    expect(hung).toHaveLength(2);
  });

  test('a lease handoff while it waits stops it before any ssh', async () => {
    const { hung, producer } = contended(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    let current = true;
    const dispatched = producer.dispatch(
      { kind: 'rotate', orientation: 'landscape-left' },
      { isCurrent: () => current },
    );
    await settle();
    current = false;
    hung[0]!.exit(0);
    await expect(dispatched).rejects.toMatchObject({ code: 'interrupted' });
    await settle();
    expect(hung).toHaveLength(2);
  });

  test('a rotation already running when the deadline passes has its ssh killed', async () => {
    const env = stationSide();
    writeFileSync(join(env.home, 'mode'), 'sleep');
    const producer = new DeviceLiveSurfaceProducer({
      surfaceId: 'device:android:ssh-test-2',
      hostId: env.hostId,
      platform: 'android',
      deviceId: SERIAL,
      hub: {
        connect: async () => ({ ok: false, failure: 'hub-unavailable' }),
        screenshot: async () => {
          throw new Error('not in this test');
        },
      },
      actions: createSshDeviceHostActions(env.registry, env.hostId),
      dispatchTimeoutMs: 1_500,
    });
    cleanups.push(() => producer.dispose());
    await expect(
      producer.dispatch({ kind: 'rotate', orientation: 'landscape-left' }),
    ).rejects.toSatisfy(toldTimedOut);
    expect(env.killed).toHaveLength(1);
    // The host program saw its session close: the step it was running is
    // the only one that ever started.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(recordedCalls(env.home)).toHaveLength(1);
  });
});

describe('the accessibility tree comes from that host’s OWN hub', () => {
  const SECRET = 'f'.repeat(64);

  const iosTree = (count: number, label: string) => [
    {
      frame: { x: 0, y: 0, width: 400, height: 800 },
      children: Array.from({ length: count }, (_, index) => ({
        frame: { x: 10, y: index, width: 50, height: 20 },
        AXLabel: label,
        type: 'Button',
      })),
    },
  ];

  function composed(tree: unknown) {
    const requests: { url: string; secret: string | null }[] = [];
    const connection = createDeviceHubConnection({
      hostId: 'remote',
      port: 45_678,
      version: '0.10.1',
      secret: SECRET,
      fetch: (async (url: string | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          secret: new Headers(init?.headers).get(HUB_SECRET_HEADER),
        });
        return new Response(JSON.stringify(tree), {
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    const env = stationSide({
      hub: { ensureStarted: async () => connection },
    });
    // The LOCAL hub answers too — a different tree — so reading it instead
    // would be a wrong answer, not merely a failure.
    let localConnects = 0;
    const localConnection = createDeviceHubConnection({
      port: 45_679,
      version: '0.10.1',
      secret: 'e'.repeat(64),
      fetch: (async () =>
        new Response(JSON.stringify(iosTree(1, 'LOCAL')), {
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    const local: DeviceHubEndpoint = {
      connect: async () => {
        localConnects += 1;
        return { ok: true, connection: localConnection };
      },
      onExit: () => () => {},
    };
    const services = new RemoteDeviceHostServices({
      has: (hostId) => env.registry.has(hostId),
      resolver: createDeviceHostResolver({ local, remote: env.registry }),
      toolsHost: env.registry,
    });
    cleanups.push(() => services.dispose());
    const tools = services.get(env.hostId)?.tools;
    if (!tools) throw new Error('no tools for the host');
    return {
      ...env,
      tools,
      services,
      requests,
      localConnects: () => localConnects,
    };
  }

  test('read through the forward with THAT host’s secret; the local hub is never asked', async () => {
    const env = composed(iosTree(2, 'OK'));
    const tree = await env.tools.accessibility(env.ios);
    expect(tree.elements.map((element) => element.label)).toEqual(['OK', 'OK']);
    expect(env.requests).toEqual([
      {
        url: `http://127.0.0.1:45678/vendor/serve-sim/helper/${UDID}/ax`,
        secret: SECRET,
      },
    ]);
    expect(env.localConnects()).toBe(0);
    // And the host's tools, not this machine's, answered the snapshot.
    expect((await env.tools.snapshot(env.ios)).hostId).toBe(env.hostId);
    expect(env.localConnects()).toBe(0);
  });

  test('what the drawer remembers about a host’s devices is dropped when the host is retargeted (review L4)', async () => {
    const env = composed(iosTree(1, 'OK'));
    const services = env.services;
    const before = services.get(env.hostId)!.tools!;
    await before.act(env.ios, {
      type: 'set-location',
      latitude: 51.5,
      longitude: -0.12,
    });
    expect((await before.snapshot(env.ios)).location).toMatchObject({
      state: 'last-set',
    });
    await env.registry.update(env.hostId, { sshTarget: 'tester@other-mac' });
    const after = services.get(env.hostId)!.tools!;
    expect(after).not.toBe(before);
    expect((await after.snapshot(env.ios)).location).toEqual({
      state: 'unreadable',
      reason: 'unsupported',
    });
    // Unchanged host: the same service, and what it set is still known.
    expect(services.get(env.hostId)!.tools).toBe(after);
  });

  test('the same 256 KB response cap as the local path', async () => {
    const env = composed(iosTree(500, '\u0001'.repeat(200)));
    const tree = await env.tools.accessibility(env.ios);
    expect(Buffer.byteLength(JSON.stringify(tree), 'utf8')).toBeLessThanOrEqual(
      DEVICE_AX_RESPONSE_MAX_BYTES,
    );
    expect(tree.truncated).toBe(true);
    expect(tree.elements.length).toBeGreaterThan(0);
    expect(tree.elements.length).toBeLessThan(500);
  });
});
