/**
 * Whether this host can run iOS Simulators and Android Emulators (#1970).
 *
 * Read-only: file checks plus one bounded `xcrun --find simctl` on macOS.
 * Nothing is installed, booted or started. Adapted from the platform checks
 * in t3code's `apps/server/src/device/LocalDeviceHost.ts` (MIT, © 2026 T3
 * Tools Inc.).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DevicePlatformReadiness } from '@kontourai/station-contracts/device-toolchain';

export interface PlatformProbeDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  exists(path: string): boolean;
  /** True when `xcrun --find simctl` succeeds (macOS only). */
  hasSimctl(): Promise<boolean>;
}

function defaultHasSimctl(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/xcrun', ['--find', 'simctl'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function defaultDeps(): PlatformProbeDeps {
  return {
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
    exists: existsSync,
    hasSimctl: defaultHasSimctl,
  };
}

function androidSdkRoot(deps: PlatformProbeDeps): string | undefined {
  const candidates = [
    deps.env.ANDROID_HOME,
    deps.env.ANDROID_SDK_ROOT,
    deps.platform === 'darwin'
      ? join(deps.homeDir, 'Library', 'Android', 'sdk')
      : deps.platform === 'win32'
        ? join(
            deps.env.LOCALAPPDATA ?? join(deps.homeDir, 'AppData', 'Local'),
            'Android',
            'Sdk',
          )
        : join(deps.homeDir, 'Android', 'Sdk'),
  ].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  return candidates.find((root) => deps.exists(root));
}

export async function probeDevicePlatforms(
  deps: PlatformProbeDeps = defaultDeps(),
): Promise<DevicePlatformReadiness[]> {
  const ios: DevicePlatformReadiness =
    deps.platform !== 'darwin'
      ? { platform: 'ios', ready: false, reason: 'requires-macos' }
      : (await deps.hasSimctl())
        ? { platform: 'ios', ready: true, reason: 'ready' }
        : { platform: 'ios', ready: false, reason: 'xcode-missing' };
  const exe = deps.platform === 'win32' ? '.exe' : '';
  const root = androidSdkRoot(deps);
  const android: DevicePlatformReadiness = !root
    ? { platform: 'android', ready: false, reason: 'android-sdk-missing' }
    : !deps.exists(join(root, 'platform-tools', `adb${exe}`))
      ? { platform: 'android', ready: false, reason: 'adb-missing' }
      : !deps.exists(join(root, 'emulator', `emulator${exe}`))
        ? { platform: 'android', ready: false, reason: 'emulator-missing' }
        : { platform: 'android', ready: true, reason: 'ready' };
  return [ios, android];
}
