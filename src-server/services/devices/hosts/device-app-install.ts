import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';
import { spawnOwnedChild } from '../../infra/process-utils.js';
import { locateExecutable, standardAdbDirs } from '../device-host-tools.js';
import {
  DEVICE_INSTALL_HOST_PHASE_BUDGET_MS,
  type DeviceAppInstallParams,
} from './device-app-install-program.js';
import { runSshDeviceScript, type SpawnSsh } from './ssh-device-session.js';
import { REMOTE_LOADER_JS, type SshDeviceTarget } from './ssh-device-target.js';

export interface DeviceInstallFile {
  path: string;
  executable: boolean;
  bytes: Buffer;
}

export type DeviceInstallOutcome =
  | {
      ok: true;
      digest: string;
      metadata: {
        platform: 'ios' | 'android';
        abi: string;
        appId: string;
        version: string | null;
        build: string;
        revision: null;
        urlSchemes: string[];
      };
    }
  | { ok: false; code: string; effect: 'none' | 'unknown' };

/** Transfer and host execution budgets plus time for SSH setup and cleanup. */
export function deviceInstallDeadlineMs(bytes: number): number {
  return (
    2 * DEVICE_INSTALL_HOST_PHASE_BUDGET_MS +
    30_000 +
    Math.ceil(bytes / (128 * 1024)) * 1000
  );
}

/** Run the fixed host program. A lost transport after admission has an unknown effect. */
export async function runDeviceAppInstall(input: {
  target: SshDeviceTarget;
  platform: 'ios' | 'android';
  deviceId: string;
  digest: string;
  files: DeviceInstallFile[];
  beforeInstall: () => Promise<boolean>;
  signal?: AbortSignal;
  spawn?: SpawnSsh;
}): Promise<DeviceInstallOutcome> {
  if (input.signal?.aborted)
    return { ok: false, code: 'interrupted', effect: 'none' };
  const files = [...input.files].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  const local = input.spawn === spawnLocalDeviceInstall;
  const executable = local
    ? await locateExecutable(
        input.platform === 'ios' ? 'xcrun' : 'adb',
        input.platform === 'ios' ? ['/usr/bin'] : standardAdbDirs(),
      )
    : null;
  const plutil =
    local && input.platform === 'ios'
      ? await locateExecutable('plutil', ['/usr/bin'])
      : null;
  if (local && (!executable || (input.platform === 'ios' && !plutil)))
    return { ok: false, code: 'tool-unavailable', effect: 'none' };
  const params: DeviceAppInstallParams = {
    ...(local
      ? {
          executables: {
            [input.platform === 'ios' ? 'xcrun' : 'adb']: executable!,
            ...(plutil ? { plutil } : {}),
          },
        }
      : {}),
    platform: input.platform,
    deviceId: input.deviceId,
    digest: input.digest,
    files: files.map(({ path, executable, bytes }) => ({
      path,
      executable,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
  let admitted = false;
  const write = (stream: Writable, chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (input.signal?.aborted || stream.destroyed)
        return reject(new Error('interrupted'));
      stream.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  const run = await runSshDeviceScript({
    target: input.target,
    program: 'device-app-install',
    params,
    timeoutMs: deviceInstallDeadlineMs(
      files.reduce((sum, file) => sum + file.bytes.length, 0),
    ),
    maxStdoutBytes: 16 * 1024,
    holdStdin: true,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.spawn ? { spawn: input.spawn } : {}),
    payload: async (stream) => {
      for (const file of files)
        for (let offset = 0; offset < file.bytes.length; offset += 1024 * 1024)
          await write(
            stream,
            file.bytes.subarray(offset, offset + 1024 * 1024),
          );
    },
    onInstallReady: async () => {
      const allowed =
        !input.signal?.aborted &&
        (await input.beforeInstall()) &&
        !input.signal?.aborted;
      if (allowed) admitted = true;
      return allowed;
    },
  });
  const unknown = {
    ok: false,
    code: 'interrupted',
    effect: admitted ? 'unknown' : 'none',
  } as const;
  if (input.signal?.aborted || run.failure || run.overflow) return unknown;
  const events = run.events.filter((event) => event.event === 'app-install');
  if (events.length !== 1) return unknown;
  const event = events[0]!;
  if (
    event.ok === false &&
    typeof event.code === 'string' &&
    (event.effect === 'none' || event.effect === 'unknown')
  )
    return { ok: false, code: event.code, effect: event.effect };
  const m = event.metadata as Record<string, unknown> | undefined;
  if (
    run.exitCode !== 0 ||
    !admitted ||
    event.ok !== true ||
    event.digest !== input.digest ||
    !m ||
    m.platform !== input.platform ||
    typeof m.abi !== 'string' ||
    typeof m.appId !== 'string' ||
    (m.version !== null && typeof m.version !== 'string') ||
    typeof m.build !== 'string' ||
    m.revision !== null ||
    !Array.isArray(m.urlSchemes) ||
    m.urlSchemes.length > 100 ||
    m.urlSchemes.some(
      (scheme: unknown) =>
        typeof scheme !== 'string' || !/^[a-z][a-z0-9+.-]{0,31}$/.test(scheme),
    )
  )
    return unknown;
  return {
    ok: true,
    digest: input.digest,
    metadata: {
      platform: input.platform,
      abi: m.abi,
      appId: m.appId,
      version: m.version as string | null,
      build: m.build,
      revision: null,
      urlSchemes: m.urlSchemes as string[],
    },
  };
}

/** Local execution uses the same fixed loader and host program as SSH. */
export const spawnLocalDeviceInstall: SpawnSsh = () => {
  const { proc, release } = spawnOwnedChild(
    process.execPath,
    ['-e', REMOTE_LOADER_JS],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return {
    pid: proc.pid,
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    onExit: (listener) => {
      proc.once('exit', listener);
    },
    onError: (listener) => {
      proc.once('error', listener);
    },
    kill: () => {
      // EOF lets the program stop its tool and remove its temporary files.
      proc.stdin?.end();
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 5000);
      timer.unref();
      proc.once('exit', () => clearTimeout(timer));
    },
    release: () => {
      if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid)
        release();
      else proc.once('exit', release);
    },
  };
};
