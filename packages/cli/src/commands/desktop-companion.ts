import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import { assertWindowsPathsTrusted } from './windows-path-trust.js';

interface Registration {
  version: 1;
  enabled: boolean;
  executable: string;
  pid: number;
  birth: string;
  pausedForService?: string;
}

export function readDesktopCompanion(home: string): Registration | null {
  const directory = join(home, 'runtime');
  const path = join(directory, 'desktop-companion.json');
  let file: Stats;
  try {
    file = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || !file.isFile() || file.size > 8192) {
    throw new Error('Invalid desktop companion registration');
  }
  if (process.platform === 'win32') {
    assertWindowsPathsTrusted(
      (command, args) =>
        spawnSync(command, args, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
        }),
      [
        { kind: 'directory', path: directory },
        { kind: 'file', path },
      ],
    );
  } else if (
    [parent, file].some(
      (stat) => stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0,
    )
  ) {
    throw new Error(
      'Desktop companion registration must be private to this user',
    );
  }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Registration;
  if (
    value.version !== 1 ||
    typeof value.enabled !== 'boolean' ||
    !isAbsolute(value.executable ?? '') ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.birth !== 'string' ||
    !value.birth ||
    value.birth.length > 512 ||
    (value.pausedForService !== undefined &&
      (typeof value.pausedForService !== 'string' ||
        !value.pausedForService ||
        value.pausedForService.length > 512))
  ) {
    throw new Error('Invalid desktop companion registration');
  }
  if (!value.enabled && !value.pausedForService) return value;
  const executable = lstatSync(value.executable);
  if (!executable.isFile()) {
    throw new Error(
      'Desktop companion executable must be a canonical regular file',
    );
  }
  if (process.platform === 'win32') {
    assertWindowsPathsTrusted(
      (command, args) =>
        spawnSync(command, args, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
        }),
      [{ kind: 'file', path: value.executable, policy: 'execution-safe' }],
    );
  } else if (
    (executable.mode & 0o022) !== 0 ||
    (executable.mode & 0o111) === 0
  ) {
    throw new Error('Desktop companion executable is not trusted for launch');
  }
  return { ...value, executable: realpathSync(value.executable) };
}

export function launchDesktopCompanion(
  executable: string,
  home: string,
  stationRoot?: string,
): ChildProcess {
  const child = spawn(executable, ['--tray-only'], {
    cwd: dirname(executable),
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      STATION_HOME: home,
      ...(stationRoot ? { STATION_ROOT: stationRoot } : {}),
    },
  });
  child.unref();
  return child;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** No registration means a headless service. A native app registers only after attaching. */
export function createDesktopCompanion(
  home: string,
  options: {
    stationRoot?: string;
    graphicalSession?: () => boolean;
    serviceBirth?: () => string | null;
    read?: typeof readDesktopCompanion;
    birth?: typeof lookupProcessBirthFingerprint;
    alive?: (pid: number) => boolean;
    now?: () => number;
    launch?: (executable: string) => void;
    warn?: (message: string) => void;
  } = {},
): { check: () => void } {
  let lastRegistration = '';
  let nextAttempt = 0;
  let attempts = 0;
  let lastWarning = '';
  const warn = (message: string) => {
    if (message !== lastWarning) (options.warn ?? console.warn)(message);
    lastWarning = message;
  };
  return {
    check() {
      try {
        const graphicalSession =
          options.graphicalSession?.() ??
          (process.platform !== 'linux' ||
            Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));
        if (!graphicalSession) return;
        const registration = (options.read ?? readDesktopCompanion)(home);
        if (!registration) return;
        if (!registration.enabled) {
          if (!registration.pausedForService) return;
          const serviceBirth = (
            options.serviceBirth ??
            (() => lookupProcessBirthFingerprint(process.pid))
          )();
          if (!serviceBirth || serviceBirth === registration.pausedForService)
            return;
        }
        const identity = JSON.stringify(registration);
        if (identity !== lastRegistration) {
          lastRegistration = identity;
          attempts = 0;
          nextAttempt = 0;
        }
        const birth = (options.birth ?? lookupProcessBirthFingerprint)(
          registration.pid,
        );
        if (
          birth === registration.birth ||
          (!birth && (options.alive ?? processAlive)(registration.pid))
        ) {
          attempts = 0;
          nextAttempt = 0;
          return;
        }
        const now = (options.now ?? Date.now)();
        if (now < nextAttempt) return;
        nextAttempt = now + Math.min(300_000, 30_000 * 2 ** attempts++);
        if (options.launch) options.launch(registration.executable);
        else {
          const child = launchDesktopCompanion(
            registration.executable,
            home,
            options.stationRoot,
          );
          child.on('error', () =>
            warn(
              'Station could not start its tray. Open the desktop app to restore access notifications.',
            ),
          );
        }
      } catch (error) {
        warn(
          `Station tray unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
