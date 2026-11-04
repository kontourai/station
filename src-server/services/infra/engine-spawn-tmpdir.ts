import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveHomeDir } from '../../utils/paths.js';

/**
 * archive#1908: every engine binary Station spawns — the Claude Agent SDK's
 * bundled binary, Codex's `app-server`, and ACP-connected command-backed
 * engines such as OpenCode — self-extracts working files into whatever
 * `TMPDIR`/`os.tmpdir()` resolves to for the child. Measured on the
 * media-server dogfood host: OpenCode's Bun-embedded `.so` payload leaked at
 * ~2 spawns/minute × ~7.9MB, ~22GB/day, none of it ever reclaimed — under
 * systemd's `PrivateTmp`, that directory is a namespace nothing outside the
 * service can see or clean, so it filled silently until the tmpfs was full
 * and every subsequent write on the host failed.
 *
 * Handing every spawn a directory Station itself owns (instead of the
 * service's ambient tmp) means Station owns cleanup instead of relying on
 * OS-level teardown that only happens on service restart —
 * `reapEngineSpawnTmpDir` reclaims it deterministically, on a schedule,
 * regardless of whether an individual child process exits cleanly.
 */
export function engineSpawnTmpDirPath(
  homeDir: string = resolveHomeDir(),
): string {
  return join(homeDir, 'tmp', 'engine-spawn');
}

/**
 * Resolves AND ensures the Station-owned engine spawn tmp directory exists,
 * private to this user: `mkdir`'s mode is masked by the umask (a host with
 * umask 002 made it group-writable), so it and its `<home>/tmp` parent are
 * tightened to 0700 afterwards, on a no-follow handle.
 */
export function ensureEngineSpawnTmpDir(
  homeDir: string = resolveHomeDir(),
): string {
  const dir = engineSpawnTmpDirPath(homeDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  tightenToOwnerOnly(join(homeDir, 'tmp'));
  tightenToOwnerOnly(dir);
  return dir;
}

/**
 * Make a Station-owned directory 0700 through a no-follow directory handle,
 * so a link in its place is never followed. Best-effort: a directory that
 * cannot be opened that way is left as it is (Windows has no POSIX modes).
 */
export function tightenToOwnerOnly(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = openSync(
      dir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    if ((fstatSync(fd).mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
  } catch {
    // Best-effort; callers that need a private folder verify it themselves.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Deletes every entry directly under `dir` whose mtime is at least
 * `maxAgeMs` old. Age-based, not per-process-exit: it reclaims orphans left
 * by a crashed or force-killed engine child exactly the same way it
 * reclaims a clean exit's leftovers, and it is the only mechanism that can
 * reach a child the Claude Agent SDK spawns and manages internally (Station
 * never holds that process directly, so there is no exit event to hook).
 *
 * Missing/unreadable directory is not an error (nothing has spawned yet, or
 * a concurrent sweep already cleared it) — returns `0`.
 */
export function reapEngineSpawnTmpDir(
  dir: string,
  maxAgeMs: number,
  now: number = Date.now(),
): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  let reaped = 0;
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    try {
      const stat = statSync(entryPath);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      rmSync(entryPath, { recursive: true, force: true });
      reaped += 1;
    } catch {
      // Best-effort: a concurrently removed entry, or a permission hiccup
      // on one entry, must not abort the rest of the sweep.
    }
  }
  return reaped;
}
