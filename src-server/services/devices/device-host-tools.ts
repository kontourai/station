import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { LiveSurfaceOrientation } from '@kontourai/station-contracts/live-surface';

/**
 * Host executables the device services run DIRECTLY, never through a shell
 * and never with a caller-shaped argument list (#1970):
 *
 * - `ffmpeg`, to decode Android's H.264 into image frames (see
 *   `h264-jpeg-decoder.ts`);
 * - `adb`, for the one device action the hub's socket cannot express:
 *   rotating an Android emulator.
 *
 * Every argument vector below is a constant or picks from a fixed table.
 * Nothing here accepts free text from a request.
 */

const EXECUTABLE_SUFFIXES = process.platform === 'win32' ? ['.exe', ''] : [''];

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(
      path,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * First executable `name` on PATH, then in `extraDirs`. Absent → null; a
 * caller reports that as a typed unavailability, never a crash.
 */
export async function locateExecutable(
  name: string,
  extraDirs: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of [...pathDirs, ...extraDirs])
    for (const suffix of EXECUTABLE_SUFFIXES) {
      const candidate = join(dir, `${name}${suffix}`);
      if (await isExecutable(candidate)) return candidate;
    }
  return null;
}

/** Where ffmpeg is commonly installed when it is not on a GUI app's PATH. */
export function standardFfmpegDirs(): string[] {
  if (process.platform === 'win32')
    return [
      'C:\\ffmpeg\\bin',
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ffmpeg', 'bin'),
      join(homedir(), 'scoop', 'shims'),
    ];
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin'];
}

/** Where the Android SDK's platform-tools usually live. */
export function standardAdbDirs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(
    (root): root is string => Boolean(root),
  );
  roots.push(
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Android', 'sdk')
      : process.platform === 'win32'
        ? join(env.LOCALAPPDATA ?? homedir(), 'Android', 'Sdk')
        : join(homedir(), 'Android', 'Sdk'),
  );
  return roots.map((root) => join(root, 'platform-tools'));
}

export class DeviceToolError extends Error {
  constructor(
    readonly code: 'tool-unavailable' | 'tool-failed' | 'tool-timeout',
    message: string,
  ) {
    super(message);
    this.name = 'DeviceToolError';
  }
}

/** Run one tool invocation with a hard deadline; no shell, hidden window. */
function runBoundedTool(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 64 * 1024,
        shell: false,
      },
      (error) => {
        if (!error) return resolve();
        const killed = (error as { killed?: boolean }).killed === true;
        reject(
          new DeviceToolError(
            killed ? 'tool-timeout' : 'tool-failed',
            killed ? `${command} timed out` : `${command} failed`,
          ),
        );
      },
    );
  });
}

/**
 * Run one tool invocation and return its stdout (#1971, the Tools drawer's
 * read-back). Same rules as {@link runBoundedTool}: no shell, a hard
 * deadline, a hidden window, and a bounded output.
 *
 * The deadline and the output bound SETTLE THE CALL THEMSELVES: they
 * SIGKILL the tool, drop our end of its pipes, and fail at once. They never
 * wait for `close`, which waits for every process holding the tool's
 * stdout — a descendant the tool left behind (`sh -c 'x & y'`) would
 * otherwise hang the call past its deadline. Such a descendant is not ours
 * to kill (it is not in our process group); with our pipe end destroyed it
 * gets EPIPE/SIGPIPE on its next write. `stdin`, when given, is written and
 * closed — a push payload travels this way, never in argv. Without it the
 * tool's stdin is `ignore`d, so a tool that reads stdin sees EOF rather
 * than waiting on an open pipe until the deadline.
 */
export function runBoundedToolCapture(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; stdin?: string; maxBuffer?: number },
  spawnTool: typeof spawn = spawn,
): Promise<string> {
  const maxBuffer = options.maxBuffer ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnTool(command, [...args], {
        shell: false,
        windowsHide: true,
        stdio: [
          options.stdin === undefined ? 'ignore' : 'pipe',
          'pipe',
          'ignore',
        ],
      });
    } catch {
      reject(new DeviceToolError('tool-failed', `${command} failed`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: DeviceToolError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    /** Kill the tool, let go of its pipes, and fail now — once. */
    const abort = (error: DeviceToolError) => {
      if (settled) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      child.stdout?.destroy();
      child.stdin?.destroy();
      finish(error);
    };
    const timer = setTimeout(
      () => abort(new DeviceToolError('tool-timeout', `${command} timed out`)),
      options.timeoutMs,
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBuffer) {
        abort(new DeviceToolError('tool-failed', `${command} failed`));
        return;
      }
      chunks.push(chunk);
    });
    // A destroyed stream may still report an error; the call has settled.
    child.stdout?.on('error', () => {});
    child.on('error', () =>
      finish(new DeviceToolError('tool-failed', `${command} failed`)),
    );
    child.on('close', (code) => {
      finish(
        code === 0
          ? null
          : new DeviceToolError('tool-failed', `${command} failed`),
      );
    });
    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => {
        // The exit status reports the failure; a closed pipe adds nothing.
      });
      child.stdin?.end(options.stdin);
    }
  });
}

/**
 * Gravity vectors that make an emulator report each orientation. Tilting the
 * emulated accelerometer rotates the display the encoder captures; a
 * `user-rotation lock` would only rotate window content. From t3code
 * (apps/server/src/device/DeviceActions.ts, `ANDROID_GRAVITY`), MIT License,
 * Copyright (c) 2026 T3 Tools Inc.
 */
const ANDROID_GRAVITY: Record<LiveSurfaceOrientation, string> = {
  portrait: '0:9.81:0',
  'landscape-left': '9.81:0:0',
  'portrait-upside-down': '0:-9.81:0',
  'landscape-right': '-9.81:0:0',
};

const EMULATOR_SERIAL = /^emulator-[0-9]{1,5}$/;

/** The exact adb argument vectors an Android rotation runs. */
export function androidRotateCommands(
  serial: string,
  orientation: LiveSurfaceOrientation,
): string[][] {
  if (!EMULATOR_SERIAL.test(serial))
    throw new DeviceToolError('tool-failed', 'not an emulator serial');
  if (!Object.hasOwn(ANDROID_GRAVITY, orientation))
    throw new DeviceToolError('tool-failed', 'unknown orientation');
  return [
    [
      '-s',
      serial,
      'shell',
      'settings',
      'put',
      'system',
      'accelerometer_rotation',
      '1',
    ],
    ['-s', serial, 'shell', 'cmd', 'window', 'user-rotation', 'free'],
    [
      '-s',
      serial,
      'emu',
      'sensor',
      'set',
      'acceleration',
      ANDROID_GRAVITY[orientation],
    ],
  ];
}

/** The typed device actions a producer may ask the host to run. */
export interface DeviceHostActions {
  rotateAndroid(
    serial: string,
    orientation: LiveSurfaceOrientation,
    timeoutMs: number,
  ): Promise<void>;
}

export function createDeviceHostActions(
  options: {
    locateAdb?: () => Promise<string | null>;
    run?: typeof runBoundedTool;
  } = {},
): DeviceHostActions {
  const locateAdb =
    options.locateAdb ?? (() => locateExecutable('adb', standardAdbDirs()));
  const run = options.run ?? runBoundedTool;
  return {
    async rotateAndroid(serial, orientation, timeoutMs) {
      const commands = androidRotateCommands(serial, orientation);
      const adb = await locateAdb();
      if (!adb)
        throw new DeviceToolError('tool-unavailable', 'adb is not installed');
      const deadline = Date.now() + timeoutMs;
      for (const args of commands) {
        const left = deadline - Date.now();
        if (left <= 0)
          throw new DeviceToolError('tool-timeout', 'rotation timed out');
        await run(adb, args, left);
      }
    },
  };
}
