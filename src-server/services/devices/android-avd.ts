/**
 * The AVD behind a running emulator serial (#1970, D12).
 *
 * An emulator serial (`emulator-5554`) is assigned by console PORT, so the
 * same serial names whichever AVD boots on that port next. Device shares are
 * therefore keyed by AVD name, and a request naming a serial is resolved to
 * the AVD running there with `adb -s <serial> emu avd name` before it is
 * authorized. Any failure resolves to undefined, which refuses.
 *
 * Answers are cached per serial for a few seconds and concurrent lookups of
 * one serial share a single adb run, so a burst of frame or capture requests
 * does not fork adb per request. adb gets the hub's allowlisted environment,
 * never Station's own: the first adb call may fork the adb server daemon,
 * which would otherwise keep Station's secrets in its environment.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { deviceHubEnvironment } from './toolchain/device-hub-supervisor.js';

const SERIAL = /^emulator-[0-9]{1,5}$/;
const AVD_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const CACHE_MS = 5_000;

function adbPath(env: NodeJS.ProcessEnv): string {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (!root) continue;
    const candidate = join(root, 'platform-tools', exe);
    if (existsSync(candidate)) return candidate;
  }
  return exe;
}

/** `emu avd name` prints the AVD name, then `OK`. */
export function parseAvdNameOutput(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const name = lines[0];
  return name !== undefined && lines[1] === 'OK' && AVD_NAME.test(name)
    ? name
    : undefined;
}

/** Runs adb and resolves its stdout, or undefined on any failure. */
type RunAdb = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<string | undefined>;

const runAdb: RunAdb = (command, args, env) =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined);
    });
  });

export function createAndroidAvdResolver(
  options: {
    run?: RunAdb;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    cacheMs?: number;
  } = {},
): (serial: string) => Promise<string | undefined> {
  const run = options.run ?? runAdb;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? CACHE_MS;
  const cache = new Map<string, { at: number; avd: string | undefined }>();
  const inflight = new Map<string, Promise<string | undefined>>();
  return (serial) => {
    if (!SERIAL.test(serial)) return Promise.resolve(undefined);
    const hit = cache.get(serial);
    if (hit && now() - hit.at < cacheMs) return Promise.resolve(hit.avd);
    const pending = inflight.get(serial);
    if (pending) return pending;
    const env = deviceHubEnvironment(options.env ?? process.env);
    const lookup = run(adbPath(env), ['-s', serial, 'emu', 'avd', 'name'], env)
      .then((output) =>
        output === undefined ? undefined : parseAvdNameOutput(output),
      )
      .catch(() => undefined)
      .then((avd) => {
        cache.set(serial, { at: now(), avd });
        return avd;
      })
      .finally(() => inflight.delete(serial));
    inflight.set(serial, lookup);
    return lookup;
  };
}
