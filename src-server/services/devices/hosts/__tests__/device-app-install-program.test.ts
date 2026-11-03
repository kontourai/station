import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../__test-utils__/temp-dirs.js';
import {
  DEVICE_APP_INSTALL_SCRIPT,
  DEVICE_INSTALL_HOST_PHASE_BUDGET_MS,
  type DeviceAppInstallParams,
} from '../device-app-install-program.js';
import { remoteLoaderCommand } from '../ssh-device-target.js';

const makeTempDir = trackTempDirs();

function fixture() {
  const home = makeTempDir('station-device-install-test-');
  const bin = join(home, '.local', 'bin');
  const tools = join(home, 'sdk', 'build-tools', '35.0.0');
  mkdirSync(bin, { recursive: true });
  mkdirSync(tools, { recursive: true });
  const executable = (path: string, contents: string) => {
    writeFileSync(path, `#!/bin/sh\n${contents}\n`);
    chmodSync(path, 0o755);
  };
  executable(
    join(tools, 'aapt'),
    `if [ "$2" = xmltree ]; then
  printf 'E: manifest\\n  E: application\\n    E: activity\\n      E: intent-filter\\n        E: data\\n          A: android:scheme(0x01010027)="sample"\\n    E: meta-data\\n      A: android:scheme(0x01010027)="outside"\\n'
else
  printf "package: name='com.example.app' versionCode='12' versionName='1.2'\\nsdkVersion:'24'\\nnative-code: 'arm64-v8a'\\n"
fi`,
  );
  executable(
    join(bin, 'adb'),
    `echo "$*" >> "$HOME/calls"
mode=$(cat "$HOME/mode" 2>/dev/null)
case "$*" in
  *ro.product.cpu.abilist) if [ "$mode" = incompatible ]; then echo x86; else echo arm64-v8a; fi ;;
  *ro.build.version.sdk) echo 35 ;;
  *"install -r"*) if [ "$mode" = slow ]; then echo $$ > "$HOME/install-pid"; exec sleep 30; else echo Success; fi ;;
  *"dumpsys package"*) if [ "$mode" = wrong-version ]; then echo versionCode=99; else printf 'versionCode=12\\nversionName=1.2\\n'; fi ;;
  *) exit 1 ;;
esac`,
  );
  return { home, bin };
}

function run(
  home: string,
  bin: string,
  params: DeviceAppInstallParams,
  bytes: Buffer,
  admit: boolean,
  cancelOnInstall = false,
) {
  const watcher = cancelOnInstall
    ? watch(home, () => {
        if (existsSync(join(home, 'install-pid'))) child.stdin.end();
      })
    : undefined;
  const child = spawn(
    process.execPath,
    [
      '-e',
      `(${DEVICE_APP_INSTALL_SCRIPT})(require, Buffer.alloc(0), ${JSON.stringify(params)})`,
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        ANDROID_HOME: join(home, 'sdk'),
        PATH: `${bin}:/usr/bin:/bin`,
        TMPDIR: home,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let output = '',
    errors = '';
  const events: Record<string, unknown>[] = [];
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
    let newline = output.indexOf('\n');
    while (newline >= 0) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      if (event.event === 'app-ready') {
        if (admit) child.stdin.write('G');
        else child.stdin.end();
      }
      newline = output.indexOf('\n');
    }
  });
  child.stderr.on('data', (data: Buffer) => {
    errors += data.toString();
  });
  child.stdin.write(bytes);
  return new Promise<{
    events: Record<string, unknown>[];
    code: number | null;
    errors: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      watcher?.close();
      resolve({ events, code, errors });
    });
  });
}

function request(bytes: Buffer): DeviceAppInstallParams {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    platform: 'android',
    deviceId: 'emulator-5554',
    digest: `sha256:${sha256}`,
    files: [
      {
        path: 'Application.apk',
        size: bytes.length,
        sha256,
        executable: false,
      },
    ],
  };
}

test('installs only after admission and verifies the installed package', async () => {
  const { home, bin } = fixture();
  const bytes = Buffer.from('apk fixture');
  const result = await run(home, bin, request(bytes), bytes, true);
  expect(result.errors).toBe('');
  expect(result.code).toBe(0);
  expect(result.events).toEqual([
    expect.objectContaining({
      event: 'app-ready',
      metadata: expect.objectContaining({
        appId: 'com.example.app',
        build: '12',
        revision: null,
        urlSchemes: ['sample'],
      }),
    }),
    expect.objectContaining({
      event: 'app-install',
      ok: true,
      digest: request(bytes).digest,
    }),
  ]);
  expect(readFileSync(join(home, 'calls'), 'utf8')).toContain('install -r');
});

test('refuses a changed artifact and a closed admission without installing', async () => {
  const { home, bin } = fixture();
  const bytes = Buffer.from('apk fixture');
  const changed = await run(
    home,
    bin,
    request(bytes),
    Buffer.from('bad fixture'),
    true,
  );
  expect(changed.events.at(-1)).toMatchObject({
    event: 'app-install',
    ok: false,
    effect: 'none',
  });
  const refused = await run(home, bin, request(bytes), bytes, false);
  expect(refused.events.at(-1)).toMatchObject({
    event: 'app-install',
    ok: false,
    effect: 'none',
  });
  expect(readFileSync(join(home, 'calls'), 'utf8')).not.toContain('install -r');
});

test('refuses incompatible devices and reports an unverified install as a failure', async () => {
  const { home, bin } = fixture();
  const bytes = Buffer.from('apk fixture');
  writeFileSync(join(home, 'mode'), 'incompatible');
  const incompatible = await run(home, bin, request(bytes), bytes, true);
  expect(incompatible.events.at(-1)).toMatchObject({
    event: 'app-install',
    ok: false,
    code: 'incompatible-artifact',
    effect: 'none',
  });
  expect(readFileSync(join(home, 'calls'), 'utf8')).not.toContain('install -r');
  writeFileSync(join(home, 'mode'), 'wrong-version');
  const unverified = await run(home, bin, request(bytes), bytes, true);
  expect(unverified.events.at(-1)).toMatchObject({
    event: 'app-install',
    ok: false,
    code: 'postcondition-failed',
    effect: 'unknown',
  });
});

test('refuses an escaping artifact path before running host tools', async () => {
  const { home, bin } = fixture();
  const bytes = Buffer.from('apk fixture');
  const params = request(bytes);
  params.files[0]!.path = '../Application.apk';
  const result = await run(home, bin, params, bytes, true);
  expect(result.events.at(-1)).toMatchObject({
    event: 'app-install',
    ok: false,
    code: 'invalid-request',
    effect: 'none',
  });
});

function localSshTransport(
  home: string,
  bin: string,
): import('../ssh-device-session.js').SpawnSsh {
  return () => {
    const child = spawn('/bin/sh', ['-c', remoteLoaderCommand().join(' ')], {
      env: {
        ...process.env,
        HOME: home,
        ANDROID_HOME: join(home, 'sdk'),
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: home,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      onExit: (listener) => {
        child.once('exit', listener);
      },
      onError: (listener) => {
        child.once('error', listener);
      },
      kill: (signal) => {
        child.kill(signal);
      },
      release: () => {},
    };
  };
}

test('the Station transport waits for the authority decision before admission', async () => {
  const { home, bin } = fixture();
  const bytes = Buffer.from('apk fixture');
  const { runDeviceAppInstall } = await import('../device-app-install.js');
  const transport = localSshTransport(home, bin);
  const target = { host: 'example.invalid' };
  const input = {
    target,
    platform: 'android' as const,
    deviceId: 'emulator-5554',
    digest: request(bytes).digest,
    files: [{ path: 'Application.apk', executable: false, bytes }],
    spawn: transport,
  };
  const denied = await runDeviceAppInstall({
    ...input,
    beforeInstall: async () => false,
  });
  expect(denied).toEqual({ ok: false, code: 'interrupted', effect: 'none' });
  expect(readFileSync(join(home, 'calls'), 'utf8')).not.toContain('install -r');
  const installed = await runDeviceAppInstall({
    ...input,
    beforeInstall: async () => true,
  });
  expect(installed).toMatchObject({
    ok: true,
    digest: input.digest,
    metadata: { appId: 'com.example.app', build: '12' },
  });
});

test('disconnect stops the install child before cleaning its staged files', async () => {
  const { home, bin } = fixture();
  const bytes = Buffer.from('apk fixture');
  writeFileSync(join(home, 'mode'), 'slow');
  const result = await run(home, bin, request(bytes), bytes, true, true);
  expect(result.events.at(-1)).toMatchObject({
    event: 'app-install',
    ok: false,
    code: 'interrupted',
    effect: 'unknown',
  });
  const pid = Number(readFileSync(join(home, 'install-pid'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(
    readdirSync(home).filter((name) => name.startsWith('station-device-app-')),
  ).toEqual([]);
});

test('SSH registry enforces host consent and rechecks it before installation', async () => {
  const { home, bin } = fixture();
  const stationHome = join(home, 'station');
  mkdirSync(stationHome, { recursive: true });
  const { DeviceHostStore } = await import('../device-host-store.js');
  const { DeviceHostRegistry } = await import('../device-host-registry.js');
  const store = new DeviceHostStore(stationHome);
  const host = store.add({
    label: 'Remote',
    sshTarget: 'tester@example.invalid',
  });
  const transport = localSshTransport(home, bin);
  let spawns = 0;
  const registry = new DeviceHostRegistry({
    stationHome,
    store,
    localHub: () => undefined,
    spawn: (args) => {
      spawns++;
      return transport(args);
    },
  });
  const bytes = Buffer.from('apk fixture');
  const input = {
    platform: 'android' as const,
    deviceId: 'emulator-5554',
    digest: request(bytes).digest,
    files: [{ path: 'Application.apk', executable: false, bytes }],
    beforeInstall: async () => true,
  };
  try {
    expect(await registry.installApp(host.hostId, input)).toMatchObject({
      ok: false,
      effect: 'none',
    });
    expect(spawns).toBe(0);
    store.setHubEnabled(host.hostId, true);
    expect(await registry.installApp(host.hostId, input)).toMatchObject({
      ok: true,
      metadata: { appId: 'com.example.app' },
    });
    const before = readFileSync(join(home, 'calls'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('install -r')).length;
    const stopped = await registry.installApp(host.hostId, {
      ...input,
      beforeInstall: async () => {
        await registry.setHubEnabled(host.hostId, { enabled: false });
        return true;
      },
    });
    expect(stopped).toMatchObject({ ok: false, effect: 'none' });
    expect(
      readFileSync(join(home, 'calls'), 'utf8')
        .split('\n')
        .filter((line) => line.includes('install -r')),
    ).toHaveLength(before);
  } finally {
    await registry.shutdown();
  }
});

test('host program uses the resolved executable when PATH cannot locate adb', async () => {
  const { home, bin } = fixture();
  const bytes = Buffer.from('apk fixture');
  const result = await run(
    home,
    '/usr/bin',
    { ...request(bytes), executables: { adb: join(bin, 'adb') } },
    bytes,
    true,
  );
  expect(result.events.at(-1)).toMatchObject({ ok: true });
  expect(readFileSync(join(home, 'calls'), 'utf8')).toContain('install -r');
});

test('local install resolves SDK adb without PATH and uses it throughout the host protocol', async () => {
  const { home, bin } = fixture();
  const platformTools = join(home, 'sdk', 'platform-tools');
  mkdirSync(platformTools, { recursive: true });
  copyFileSync(join(bin, 'adb'), join(platformTools, 'adb'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('TMPDIR', home);
  vi.stubEnv('ANDROID_HOME', join(home, 'sdk'));
  vi.stubEnv('PATH', '/usr/bin:/bin');
  try {
    const { runDeviceAppInstall, spawnLocalDeviceInstall } = await import(
      '../device-app-install.js'
    );
    const bytes = Buffer.from('apk fixture');
    const result = await runDeviceAppInstall({
      target: { host: 'local.invalid' },
      platform: 'android',
      deviceId: 'emulator-5554',
      digest: request(bytes).digest,
      files: [{ path: 'Application.apk', executable: false, bytes }],
      spawn: spawnLocalDeviceInstall,
      beforeInstall: async () => true,
    });
    expect(result).toMatchObject({ ok: true });
    expect(readFileSync(join(home, 'calls'), 'utf8')).toContain('install -r');
  } finally {
    vi.unstubAllEnvs();
  }
});

test('SSH install deadlines scale with payload and reserve 30 seconds for setup', async () => {
  const { home, bin } = fixture();
  const { runDeviceAppInstall } = await import('../device-app-install.js');
  const timer = vi.spyOn(globalThis, 'setTimeout');
  try {
    for (const [length, expected] of [
      [1, 271_000],
      [128 * 1024 + 1, 272_000],
    ] as const) {
      const bytes = Buffer.alloc(length, 7);
      const result = await runDeviceAppInstall({
        target: { host: 'example.invalid' },
        platform: 'android',
        deviceId: 'emulator-5554',
        digest: request(bytes).digest,
        files: [{ path: 'Application.apk', executable: false, bytes }],
        spawn: localSshTransport(home, bin),
        beforeInstall: async () => true,
      });
      expect(result.ok).toBe(true);
      expect(expected).toBe(
        2 * DEVICE_INSTALL_HOST_PHASE_BUDGET_MS +
          30_000 +
          Math.ceil(length / (128 * 1024)) * 1000,
      );
      expect(timer.mock.calls.some((call) => call[1] === expected)).toBe(true);
    }
  } finally {
    timer.mockRestore();
  }
});

test('registry retains admission up to the scaled deadline and refuses at the deadline', async () => {
  const { home, bin } = fixture();
  const stationHome = join(home, 'station-deadline');
  mkdirSync(stationHome, { recursive: true });
  const { DeviceHostStore } = await import('../device-host-store.js');
  const { DeviceHostRegistry } = await import('../device-host-registry.js');
  const { deviceInstallDeadlineMs } = await import('../device-app-install.js');
  const store = new DeviceHostStore(stationHome);
  const host = store.add({
    label: 'Remote',
    sshTarget: 'tester@example.invalid',
  });
  store.setHubEnabled(host.hostId, true);
  const registry = new DeviceHostRegistry({
    stationHome,
    store,
    localHub: () => undefined,
    spawn: localSshTransport(home, bin),
  });
  const bytes = Buffer.from('apk fixture');
  const input = {
    platform: 'android' as const,
    deviceId: 'emulator-5554',
    digest: request(bytes).digest,
    files: [{ path: 'Application.apk', executable: false, bytes }],
  };
  let now = 1_000_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const deadline = now + deviceInstallDeadlineMs(bytes.length);
    const within = await registry.installApp(host.hostId, {
      ...input,
      beforeInstall: async () => {
        now = deadline - 1;
        return true;
      },
    });
    expect(within.ok).toBe(true);
    now = 1_000_000;
    const expired = await registry.installApp(host.hostId, {
      ...input,
      beforeInstall: async () => {
        now = deadline;
        return true;
      },
    });
    expect(expired).toMatchObject({ ok: false, effect: 'none' });
  } finally {
    clock.mockRestore();
    await registry.shutdown();
  }
});

test('host installer embeds the shared phase budget', () => {
  expect(DEVICE_APP_INSTALL_SCRIPT).toContain(
    String(DEVICE_INSTALL_HOST_PHASE_BUDGET_MS),
  );
});
