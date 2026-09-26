/**
 * serve-sim stream helpers the managed hub starts (#1970, hub lockdown).
 *
 * serve-sim starts a DETACHED node helper per simulator (its own process
 * group, re-parented to init) and records it in
 * `<tmpdir>/serve-sim/server-<udid>.json` (`{pid, port, device, …}`). A
 * helper outlives the hub that started it, so the supervisor reads these
 * files to deny their ports to the host browser and to kill them when the
 * hub stops, crashes or restarts.
 *
 * Station gives its hub a PRIVATE temp directory
 * (`<STATION_HOME>/devices/run/tmp`), so this state directory, and every
 * helper listed in it, is Station's alone: it never touches another tool's
 * serve-sim state (for example another app's serve-sim hub on the same
 * machine, using the shared `$TMPDIR/serve-sim/`). A helper is killed only
 * when its command line names a Station-managed hub install —
 * `<tools>/expo-device-hub/<version>/` on a path-segment boundary, any
 * managed version — so an orphaned helper of an older install is still
 * reaped, and a similarly named directory outside Station's tool root never
 * is.
 *
 * Not tracked here, and disclosed: serve-emu forwards scrcpy through
 * `adb forward` to local ports it picks (owned by the adb server, not a
 * Station process), and serve-sim's camera feed uses a UNIX socket that
 * lives in the hub's private TMPDIR. Neither is an HTTP listener the guard
 * sees; both are loopback/filesystem-local to this user.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface HubHelper {
  pid: number;
  port: number;
  device: string;
  stateFile: string;
}

export function hubTmpDir(runDir: string): string {
  return join(runDir, 'tmp');
}

function serveSimStateDir(runDir: string): string {
  return join(hubTmpDir(runDir), 'serve-sim');
}

/** Helpers recorded in this Station's private serve-sim state. Read fresh. */
export function readHubHelpers(runDir: string): HubHelper[] {
  const dir = serveSimStateDir(runDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const helpers: HubHelper[] = [];
  for (const name of names) {
    if (!/^server-[A-Za-z0-9._-]+\.json$/.test(name)) continue;
    const stateFile = join(dir, name);
    try {
      const value = JSON.parse(readFileSync(stateFile, 'utf8')) as {
        pid?: unknown;
        port?: unknown;
        device?: unknown;
      };
      if (
        Number.isSafeInteger(value.pid) &&
        (value.pid as number) > 1 &&
        Number.isInteger(value.port) &&
        (value.port as number) > 0 &&
        (value.port as number) <= 65_535
      )
        helpers.push({
          pid: value.pid as number,
          port: value.port as number,
          device: typeof value.device === 'string' ? value.device : '',
          stateFile,
        });
    } catch {
      // A half-written or foreign file is not a helper.
    }
  }
  return helpers;
}

export type KillHubHelper = (
  helper: HubHelper,
  toolRoot: string,
) => Promise<void>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A command line that runs from `<toolRoot>/<version>/…` (any version). */
function runsFromManagedInstall(command: string, toolRoot: string): boolean {
  const root = escapeRegExp(toolRoot.replace(/[\\/]+$/, ''));
  return new RegExp(
    `(^|[\\s"'=])${root}[\\\\/][0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?[\\\\/]`,
  ).test(command);
}

function commandLine(pid: number): string | undefined {
  if (process.platform === 'win32') return undefined;
  const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    // A detached helper leads its own process group.
    process.kill(-pid, name);
  } catch {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Kill one helper, but only when it is still a process started from a
 * Station-managed hub install (a recycled pid belonging to anything else is
 * left alone), then drop its state file.
 */
export const killOwnedHubHelper: KillHubHelper = async (helper, toolRoot) => {
  if (alive(helper.pid)) {
    const command = commandLine(helper.pid);
    if (command !== undefined && runsFromManagedInstall(command, toolRoot)) {
      signal(helper.pid, 'SIGTERM');
      const deadline = Date.now() + 2_000;
      while (alive(helper.pid) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (alive(helper.pid)) signal(helper.pid, 'SIGKILL');
    } else if (command !== undefined) {
      // Not ours (pid reuse): keep the process, forget the stale record.
      rmSync(helper.stateFile, { force: true });
      return;
    } else return;
  }
  rmSync(helper.stateFile, { force: true });
};
