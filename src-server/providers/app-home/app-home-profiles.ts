/**
 * App-home profiles (archive#896, `docs/design/agent-engine-unification.md` §6.1's
 * overlay model, channel 2): a Station-owned, per-engine config home
 * (`~/.station/app-homes/<engineId>/`) a session can be pointed at instead
 * of the user's real global engine config (`~/.claude`, `~/.codex`, …), via
 * `CLAUDE_CONFIG_DIR`/`CODEX_HOME`-style env overrides applied to the
 * spawned session's process only. The base layer (global config) stays
 * read-only to Station; this module only ever creates/writes inside a
 * profile directory Station itself owns.
 *
 * Wave 1 wired this for Claude Code only (`claude`). Wave 2 wires
 * `codexAppHomeEnv` into `codex-adapter.ts`/`codex-adapter-transport.ts`,
 * so both engines now layer their app-home profile onto the spawned
 * session's process env only (never the server process's own env).
 *
 * SECURITY posture (matches `claude-skills-materialization.ts`'s, this
 * module writes into `~/.station` rather than a session cwd but the same
 * two properties matter): (a) never act on a path that isn't provably
 * inside the profile dir, and (b) never follow a symlink encountered while
 * importing from the user's real global config. Containment is checked
 * BEFORE any `mkdir` — creating even an empty directory in the wrong place
 * is already a violation. `importClaudeGlobalSnapshot` is additionally
 * transactional (stage-then-commit into a fresh `.import-stage-<rand>/`,
 * committed via backup-then-rename into `.import-backup-<rand>/`): a
 * failed or partially-failed import can never destroy previously imported
 * profile content, only ever the stage/backup this one call created. Pure
 * (ish) and injectable: the only I/O is the `fs` port (defaults to real
 * `node:fs`/`node:fs/promises`).
 */
import {
  constants as nodeFsConstants,
  lstatSync as nodeLstatSync,
  realpathSync as nodeRealpathSync,
} from 'node:fs';
import {
  mkdir as nodeMkdir,
  mkdtemp as nodeMkdtemp,
  open as nodeOpen,
  readdir as nodeReaddir,
  readFile as nodeReadFile,
  rename as nodeRename,
  rm as nodeRm,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { basename, dirname, join, normalize, relative, sep } from 'node:path';
import { isSafeToolServerId } from '@kontourai/station-contracts/tool';
import { resolveHomeDir } from '../../utils/paths.js';

/** Matches the `any`-typed logger convention used across `providers/adapters`. */
type AppHomeLogger = any;

const APP_HOMES_DIRNAME = 'app-homes';
const PROFILE_MARKER_FILENAME = 'profile.json';
const PROFILE_MARKER_VERSION = 1 as const;
/** Per-file size cap for `importClaudeGlobalSnapshot` (docs/design/connections-onboarding.md §1.1). */
export const APP_HOME_IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * archive#896 wave 2: per-engine import allowlist (docs/design/
 * connections-onboarding.md §1.1) — parameterizes `importGlobalSnapshot`'s
 * shared containment/symlink-refusal/size-cap/transactional-commit
 * machinery (unchanged by this refactor) over which top-level entries of
 * the engine's global config dir are eligible to copy at all.
 */
export interface AppHomeImportProfile {
  /** Top-level files copied verbatim from the global config dir. */
  allowlistFiles: ReadonlySet<string>;
  /** Top-level directories copied recursively from the global config dir. */
  allowlistDirs: ReadonlySet<string>;
  /** Only copied when the caller explicitly opts in (`includeCredentials: true`). */
  credentialsFilename: string;
}

export const CLAUDE_APP_HOME_IMPORT_PROFILE: AppHomeImportProfile = {
  allowlistFiles: new Set(['settings.json', 'CLAUDE.md']),
  allowlistDirs: new Set(['skills', 'agents', 'commands']),
  credentialsFilename: '.credentials.json',
};

/**
 * Codex allowlist decision (docs/design/connections-onboarding.md §1.1):
 * config = `config.toml`, `AGENTS.md`, `prompts/`, `skills/`; secret =
 * `auth.json` (ChatGPT OAuth tokens / API key — copied ONLY under the same
 * explicit `includeCredentials: true` checkbox contract as claude's
 * `.credentials.json`). Everything else observed under a real `~/.codex`
 * (`sessions/`, `archived_sessions/`, `history.jsonl`, `session_index.jsonl`,
 * `log/`, `shell_snapshots/`, `*.sqlite*`, `models_cache.json`,
 * `installation_id`, `version.json`, and any third-party additions) is
 * history/state/telemetry and is always refused (`not-on-allowlist`).
 * `rules/` is excluded pending evidence it is codex-owned config (Ambiguity
 * E — this machine's `~/.codex` is heavily third-party-contaminated; only
 * schema/docs evidence should grow this allowlist). Disclosed caveat:
 * `config.toml` may itself carry `[mcp_servers.*.env]` secrets and
 * `[projects]` trust entries — accepted under the same explicit-user-action
 * reasoning as claude's `settings.json` (§1.1 import rules).
 */
export const CODEX_APP_HOME_IMPORT_PROFILE: AppHomeImportProfile = {
  allowlistFiles: new Set(['config.toml', 'AGENTS.md']),
  allowlistDirs: new Set(['prompts', 'skills']),
  credentialsFilename: 'auth.json',
};

export interface AppHomeDirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface AppHomeStat {
  isSymbolicLink: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  dev: number;
  ino: number;
}

/**
 * A TOCTOU-safe read handle: `isFile`/`size` are read from the OPENED
 * DESCRIPTOR (`fstat`), never from an earlier path-based `lstat` — the only
 * authoritative source once the fd is open, immune to the path being
 * swapped after the check (mirrors
 * `claude-skills-materialization.ts`'s `SkillMaterializationFileHandle`).
 */
export interface AppHomeFileHandle {
  isFile: boolean;
  size: number;
  read(): Promise<Buffer>;
  close(): Promise<void>;
}

/** Injectable fs primitives — defaults to real `node:fs`/`node:fs/promises`, mirroring `claude-skills-materialization.ts`'s `SkillMaterializationFsPort` style. */
export interface AppHomeFsPort {
  /** `null` on ENOENT — never follows symlinks for the purpose of reporting whether the path itself is one. */
  lstat: (path: string) => Promise<AppHomeStat | null>;
  /** `null` if the path cannot be resolved (ENOENT, ELOOP, etc). */
  realpath: (path: string) => Promise<string | null>;
  /** `mkdir -p` semantics — tolerant of an already-existing directory. */
  mkdirRecursive: (path: string) => Promise<void>;
  /**
   * Creates a NEW, uniquely-named directory under `prefix` (e.g.
   * `mkdtemp(join(profileDir, '.import-stage-'))` → something like
   * `.../.import-stage-Ab3fQ1`) using OS-supplied randomness with
   * atomic, exclusive creation semantics. Unlike `mkdirRecursive`, this
   * NEVER adopts a pre-existing directory — it always returns a path
   * this call itself just created (retrying internally on a collision).
   * Used for the import transaction's stage/backup dirs (item 1,
   * security review round 4) so an attacker cannot predict — and
   * therefore cannot pre-plant something at — the path before it's
   * created; `mkdirRecursive` with a caller-computed name is a
   * non-exclusive "create or silently adopt" primitive and was never
   * safe for this.
   */
  mkdtemp: (prefix: string) => Promise<string>;
  readdir: (path: string) => Promise<AppHomeDirEntry[]>;
  readFile: (path: string) => Promise<Buffer>;
  /**
   * Opens `path` for reading with `O_NOFOLLOW` where the platform supports
   * it (POSIX) — refuses to open a symlink at the final path component
   * rather than following it. Returns `null` on ENOENT (absent) or ELOOP (a
   * symlink) rather than throwing; callers that need to tell those apart
   * fall back to `lstat`.
   *
   * `expectedIdentity` (dev/ino from the caller's own prior dispatch
   * `lstat`, when one exists) closes the final-component-swap window on
   * platforms without `O_NOFOLLOW` (Windows): after opening, the opened
   * DESCRIPTOR's own `fstat` is compared against it, and a mismatch is
   * refused (`null`) exactly like a symlink would be on POSIX — the final
   * component could otherwise have been swapped between the caller's
   * dispatch `lstat` and this open. Checked whenever supplied, on every
   * platform (free defense-in-depth on POSIX against a same-type swap —
   * e.g. one regular file replaced by a different one — that `O_NOFOLLOW`
   * alone does not catch, mirroring `claude-skills-materialization.ts`'s
   * dev/ino identity check at delete time). Omitted (`undefined`) when the
   * caller has no prior dispatch `lstat` to compare against (e.g. the
   * profile marker check, which is deliberately open-only with no separate
   * lstat step) — the check is simply skipped in that case.
   */
  openForRead: (
    path: string,
    expectedIdentity?: { dev: number; ino: number },
  ) => Promise<AppHomeFileHandle | null>;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  /** `O_CREAT|O_EXCL|O_WRONLY` — `'created'` on success, `'exists'` (never throws) if the path already exists in any form. */
  writeFileExclusive: (
    path: string,
    data: Buffer,
  ) => Promise<'created' | 'exists'>;
  /**
   * Renames `from` to `to`, atomically. POSIX `rename()` never follows a
   * symlink at the DESTINATION — it replaces the symlink entry itself, not
   * whatever it points at — which is exactly why this module uses
   * rename-to-commit rather than an in-place `writeFile` for anything that
   * might already exist at the destination path.
   */
  rename: (from: string, to: string) => Promise<void>;
  /** Recursively removes `path` unconditionally, tolerant of it not existing — only ever invoked on a path resolved to be inside the Station-owned profile dir. */
  rmRecursive: (path: string) => Promise<void>;
}

function toStat(stat: {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  dev: number;
  ino: number;
}): AppHomeStat {
  return {
    isSymbolicLink: stat.isSymbolicLink(),
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function defaultFsPort(): AppHomeFsPort {
  return {
    lstat: async (path) => {
      try {
        return toStat(nodeLstatSync(path));
      } catch {
        return null;
      }
    },
    realpath: async (path) => {
      try {
        return nodeRealpathSync(path);
      } catch {
        return null;
      }
    },
    mkdirRecursive: async (path) => {
      await nodeMkdir(path, { recursive: true });
    },
    mkdtemp: (prefix) => nodeMkdtemp(prefix),
    readdir: (path) => nodeReaddir(path, { withFileTypes: true }),
    readFile: (path) => nodeReadFile(path),
    openForRead: async (path, expectedIdentity) => {
      // O_NOFOLLOW is a documented no-op on Windows (Node/libuv silently
      // drops it there) — `expectedIdentity` (below) is what closes that
      // gap for callers that have a dispatch `lstat` to compare against.
      const flags =
        process.platform === 'win32'
          ? nodeFsConstants.O_RDONLY
          : nodeFsConstants.O_RDONLY | nodeFsConstants.O_NOFOLLOW;
      let handle: Awaited<ReturnType<typeof nodeOpen>>;
      try {
        handle = await nodeOpen(path, flags);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ELOOP') return null;
        throw error;
      }
      const stat = await handle.stat();
      if (
        expectedIdentity &&
        (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino)
      ) {
        // The opened descriptor's own identity doesn't match what the
        // caller's dispatch `lstat` reported — the final path component
        // was swapped in between (the exact window `O_NOFOLLOW` alone
        // cannot close on Windows, and a same-type swap `O_NOFOLLOW`
        // cannot catch anywhere). Refuse exactly like a symlink would be.
        await handle.close();
        return null;
      }
      return {
        isFile: stat.isFile(),
        size: stat.size,
        read: () => handle.readFile() as Promise<Buffer>,
        close: () => handle.close(),
      };
    },
    writeFile: (path, data) => nodeWriteFile(path, data),
    writeFileExclusive: async (path, data) => {
      try {
        await nodeWriteFile(path, data, { flag: 'wx' });
        return 'created';
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
          return 'exists';
        }
        throw error;
      }
    },
    rename: (from, to) => nodeRename(from, to),
    rmRecursive: async (path) => {
      await nodeRm(path, { recursive: true, force: true });
    },
  };
}

/** `true` when `child` is `parent` itself or nested under it, by resolved path components (not string prefix). */
function isPathContainedOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && rel !== '..');
}

/**
 * Best-effort realpath: resolves symlinks/`..` when the path exists, and
 * otherwise walks up to the nearest existing ancestor, realpaths THAT, and
 * rejoins the not-yet-existing suffix (mirrors
 * `claude-skills-materialization.ts`'s helper of the same shape — avoids
 * miscomparing a realpath'ed side against an unresolved side when a host's
 * temp/home root is itself a symlink, e.g. macOS's `/tmp` -> `/private/tmp`).
 */
async function resolveBestEffortRealPath(
  path: string,
  fs: AppHomeFsPort,
): Promise<string> {
  const direct = await fs.realpath(path);
  if (direct) return direct;
  const suffixSegments: string[] = [];
  let current = normalize(path);
  for (;;) {
    const real = await fs.realpath(current);
    if (real) {
      return suffixSegments.length > 0
        ? join(real, ...[...suffixSegments].reverse())
        : real;
    }
    const parent = dirname(current);
    if (parent === current) return normalize(path);
    suffixSegments.push(basename(current));
    current = parent;
  }
}

export function appHomesRootDir(homeDir: string = resolveHomeDir()): string {
  return join(homeDir, APP_HOMES_DIRNAME);
}

/** Throws for an unsafe `engineId` — it joins directly into a filesystem path, same safety predicate as `claude-skills-materialization.ts`'s skill ids. */
export function appHomeProfileDir(
  engineId: string,
  homeDir: string = resolveHomeDir(),
): string {
  if (!isSafeToolServerId(engineId)) {
    throw new Error(
      `App home profile: engine id '${engineId}' is not filesystem-safe (empty, '.', '..', or a path separator).`,
    );
  }
  return join(appHomesRootDir(homeDir), engineId);
}

/** Per-session env for a Claude Code session pointed at an app-home profile. */
export function claudeAppHomeEnv(dir: string): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: dir };
}

/**
 * The Codex counterpart of `claudeAppHomeEnv` (archive#896 wave 2: wired into
 * `codex-adapter.ts`'s spawn seam via `station-runtime.ts`'s
 * `codexAdapter.getAppHomeEnv` closure).
 */
export function codexAppHomeEnv(dir: string): Record<string, string> {
  return { CODEX_HOME: dir };
}

interface AppHomeProfileMarker {
  version: typeof PROFILE_MARKER_VERSION;
  engineId: string;
  createdAt: string;
  seededFrom: 'empty' | 'global-import';
  importedAt?: string;
}

export interface AppHomeProfileStatus {
  dir: string;
  exists: boolean;
  seededFrom?: 'empty' | 'global-import';
  importedAt?: string;
}

/**
 * Read-only peek at a profile's status — never creates anything (unlike
 * `ensureAppHomeProfile`), so it is safe to call from a `GET` status route.
 *
 * Item 2b (security review round 3): reads the marker through
 * `openForRead` (`O_NOFOLLOW` + descriptor-based `fstat`) rather than a
 * path-based `lstat`+`readFile` pair — the same no-follow posture every
 * other marker touch in this module already uses. A symlinked marker (or
 * one swapped in for a symlink between the two former path-based calls)
 * is refused/reported as `exists: false`, never read through.
 *
 * Item 4 (security review round 4): the dispatch `lstat`'s dev/ino is
 * threaded through as `openForRead`'s `expectedIdentity` — the SAME
 * mechanism `readSourceFileGuarded` already uses for import source
 * reads — so the no-`O_NOFOLLOW` Windows path also gets the
 * post-open identity cross-check, not just POSIX's native symlink
 * refusal. This is what makes "every later touch of the marker
 * re-validates through `openForRead`'s no-follow descriptor path"
 * (see `ensureAppHomeProfile`'s doc comment) true on every platform,
 * not only the ones with `O_NOFOLLOW`.
 */
export async function readAppHomeProfileStatus(
  engineId: string,
  options: { homeDir?: string; fs?: AppHomeFsPort } = {},
): Promise<AppHomeProfileStatus> {
  const fs = options.fs ?? defaultFsPort();
  const dir = appHomeProfileDir(engineId, options.homeDir);
  const markerPath = join(dir, PROFILE_MARKER_FILENAME);
  const dispatchStat = await fs.lstat(markerPath);
  const handle = await fs.openForRead(
    markerPath,
    dispatchStat ? { dev: dispatchStat.dev, ino: dispatchStat.ino } : undefined,
  );
  if (!handle) {
    // ENOENT (no profile yet) or ELOOP (a symlink at the marker path,
    // refused by O_NOFOLLOW) — both report as "no profile" rather than
    // ever reading through a symlink.
    return { dir, exists: false };
  }
  try {
    if (!handle.isFile) {
      // A directory or other non-regular type at the marker path — same
      // "not a real profile" report the prior `lstat`-based check gave.
      return { dir, exists: false };
    }
    const raw = JSON.parse(
      (await handle.read()).toString('utf-8'),
    ) as Partial<AppHomeProfileMarker>;
    return {
      dir,
      exists: true,
      seededFrom:
        raw.seededFrom === 'global-import' ? 'global-import' : 'empty',
      importedAt:
        typeof raw.importedAt === 'string' ? raw.importedAt : undefined,
    };
  } catch {
    // Corrupt/foreign marker — the profile dir still exists; report the
    // safest default rather than throwing on a status read.
    return { dir, exists: true, seededFrom: 'empty' };
  } finally {
    await handle.close();
  }
}

export interface EnsureAppHomeProfileResult {
  dir: string;
  created: boolean;
}

export interface EnsureAppHomeProfileOptions {
  homeDir?: string;
  fs?: AppHomeFsPort;
  now?: () => string;
  logger?: AppHomeLogger;
}

/**
 * Ensures `~/.station/app-homes/<engineId>/` exists with a `profile.json`
 * marker, idempotently — called lazily on first opt-in / first profile-run
 * session, never at startup. A pre-existing marker is left untouched (so a
 * prior `importClaudeGlobalSnapshot`'s `seededFrom: 'global-import'` is
 * never clobbered back to `'empty'` by a later plain ensure call).
 *
 * Exact security scope (item 2, security review round 3 — stated
 * precisely rather than over-claimed): a marker found to be non-regular
 * at EITHER identity check below (the initial `lstat`, or the post-EEXIST
 * re-`lstat`) is refused, never adopted. What this does NOT close: the
 * instant between a check passing and this function returning — a
 * regular marker verified here could in principle be swapped for a
 * symlink immediately afterward. That instant is not closable by a
 * path-based check at all (any subsequent `lstat` just has the same gap
 * one step later); it is closed structurally instead, downstream: every
 * later touch of this marker (`markAppHomeProfileImported`,
 * `readAppHomeProfileStatus`) re-validates independently through
 * `openForRead`'s no-follow descriptor path and, for writes, an atomic
 * rename-to-commit — so a swap in this narrow window yields at most a
 * benign "ensured" report here, never a write through the swapped-in
 * link at any later step.
 */
export async function ensureAppHomeProfile(
  engineId: string,
  options: EnsureAppHomeProfileOptions = {},
): Promise<EnsureAppHomeProfileResult> {
  const fs = options.fs ?? defaultFsPort();
  const logger = options.logger ?? console;
  const root = appHomesRootDir(options.homeDir);
  const dir = appHomeProfileDir(engineId, options.homeDir);

  // Containment guard BEFORE any mkdir (defense-in-depth: `appHomeProfileDir`
  // already only ever joins a validated `engineId` onto `root`, but the
  // channel-policy rule from claude-skills-materialization.ts is "check,
  // don't just construct-and-trust").
  const realRoot = await resolveBestEffortRealPath(root, fs);
  const realDir = await resolveBestEffortRealPath(dir, fs);
  if (!isPathContainedOrEqual(realRoot, realDir) || realRoot === realDir) {
    throw new Error(
      `App home profile: resolved profile dir '${dir}' is not contained in the app-homes root '${root}'; refusing to create it.`,
    );
  }

  const markerPath = join(dir, PROFILE_MARKER_FILENAME);
  const existingMarker = await fs.lstat(markerPath);
  if (existingMarker) {
    // HIGH (security review): a pre-existing marker is treated as a benign
    // "another call already won the race" ONLY when THIS `lstat` (never
    // follows) reports it as a genuine regular file right now. A symlink
    // (or any other non-regular type: directory, fifo, device, …) is
    // refused outright, never silently treated as a legitimate winner —
    // treating it as "fine, already there" is exactly what would let a
    // planted symlink poison every later read/write of this profile's
    // provenance marker. (A swap in the instant AFTER this check passes
    // is a separate, narrower, structurally-closed-downstream residual —
    // see this function's doc comment.)
    if (!existingMarker.isFile) {
      logger.warn?.(
        `App home profile: marker '${markerPath}' exists but is not a regular file (symlink or other); refusing to treat it as an existing profile.`,
      );
      throw new Error(
        `App home profile: marker at '${markerPath}' is not a regular file; refusing to proceed.`,
      );
    }
    return { dir, created: false };
  }

  await fs.mkdirRecursive(dir);
  const marker: AppHomeProfileMarker = {
    version: PROFILE_MARKER_VERSION,
    engineId,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
    seededFrom: 'empty',
  };
  const outcome = await fs.writeFileExclusive(
    markerPath,
    Buffer.from(JSON.stringify(marker, null, 2), 'utf-8'),
  );
  if (outcome === 'exists') {
    // Item 1 (security review round 2): the initial `lstat` above found
    // NOTHING at `markerPath`, but something raced into place before our
    // `O_CREAT|O_EXCL` write landed. Re-check identity rather than
    // assuming a benign concurrent winner — the same mistake the initial
    // check above was fixed for: only a genuine regular file is EVER
    // treated as "another call already won"; anything else (a symlink
    // planted in that exact window, a directory, …) is refused, not
    // silently adopted as an ensured profile.
    const raced = await fs.lstat(markerPath);
    if (!raced?.isFile) {
      logger.warn?.(
        `App home profile: marker '${markerPath}' appeared during an exclusive-create attempt but is not a regular file (symlink or other); refusing to treat it as an existing profile.`,
      );
      throw new Error(
        `App home profile: marker at '${markerPath}' is not a regular file; refusing to proceed.`,
      );
    }
    logger.warn?.(
      `App home profile: marker for '${engineId}' was created by a concurrent call; leaving it in place.`,
    );
  }
  return { dir, created: outcome === 'created' };
}

export type MarkAppHomeProfileImportedResult =
  | { ok: true }
  | { ok: false; reason: 'marker-not-regular-file' | 'temp-marker-collision' };

/**
 * Reads and updates the profile marker after a successful
 * `importClaudeGlobalSnapshot`, recording `seededFrom: 'global-import'` and
 * `importedAt`.
 *
 * HIGH (security review): this is the exact write a planted symlink at the
 * marker path was able to hijack into an arbitrary-file overwrite before
 * this fix — a plain `writeFile` to `markerPath` follows a symlink there
 * like any normal open. Now TOCTOU-safe and no-follow, mirroring
 * `claude-skills-materialization.ts`'s posture:
 *  1. The CURRENT marker (if any) is identity-checked via `openForRead`
 *     (`O_NOFOLLOW` — refuses to open a symlink at all) rather than a
 *     path-based `lstat`+`readFile` pair; a marker that exists but isn't a
 *     genuine regular file (symlink or otherwise) is REFUSED — nothing is
 *     written, the caller gets `{ ok: false }`, and it is logged.
 *  2. The new marker content is written to a fresh, uniquely-named temp
 *     file inside the SAME (already containment-checked, Station-owned)
 *     profile dir with `O_CREAT|O_EXCL` — never following anything.
 *  3. The temp file is committed with `rename()`, which — per POSIX — never
 *     follows a symlink at the destination; it replaces the destination
 *     path entry itself (symlink or not), so the commit step can never be
 *     tricked into writing through a link even if one raced in during step
 *     1's check.
 */
export async function markAppHomeProfileImported(
  engineId: string,
  dir: string,
  options: {
    fs?: AppHomeFsPort;
    now?: () => string;
    logger?: AppHomeLogger;
  } = {},
): Promise<MarkAppHomeProfileImportedResult> {
  const fs = options.fs ?? defaultFsPort();
  const logger = options.logger ?? console;
  const now = (options.now ?? (() => new Date().toISOString()))();
  const markerPath = join(dir, PROFILE_MARKER_FILENAME);

  let createdAt = now;
  const existingHandle = await fs.openForRead(markerPath);
  if (existingHandle) {
    try {
      if (!existingHandle.isFile) {
        logger.warn?.(
          `App home profile: marker '${markerPath}' is not a regular file; refusing to update import provenance.`,
        );
        return { ok: false, reason: 'marker-not-regular-file' };
      }
      try {
        const raw = JSON.parse(
          (await existingHandle.read()).toString('utf-8'),
        ) as Partial<AppHomeProfileMarker>;
        if (typeof raw.createdAt === 'string') createdAt = raw.createdAt;
      } catch {
        // Corrupt content but still a genuine regular file (confirmed by
        // the descriptor's own fstat above) — safe to overwrite with a
        // fresh marker below.
      }
    } finally {
      await existingHandle.close();
    }
  } else {
    // `openForRead` returning `null` conflates ENOENT (absent — fine, this
    // is the first write) and ELOOP (a symlink at the final component,
    // refused by O_NOFOLLOW) — fall back to `lstat` (never follows) to
    // tell them apart and refuse only the latter.
    const stat = await fs.lstat(markerPath);
    if (stat) {
      logger.warn?.(
        `App home profile: marker '${markerPath}' exists but could not be opened as a regular file (symlink or other); refusing to update import provenance.`,
      );
      return { ok: false, reason: 'marker-not-regular-file' };
    }
  }

  const marker: AppHomeProfileMarker = {
    version: PROFILE_MARKER_VERSION,
    engineId,
    createdAt,
    seededFrom: 'global-import',
    importedAt: now,
  };
  const tempPath = join(
    dir,
    `${PROFILE_MARKER_FILENAME}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const writeOutcome = await fs.writeFileExclusive(
    tempPath,
    Buffer.from(JSON.stringify(marker, null, 2), 'utf-8'),
  );
  if (writeOutcome === 'exists') {
    // Vanishingly unlikely (random suffix collision) — refuse rather than
    // risk touching a path this call didn't itself just create.
    logger.warn?.(
      `App home profile: temp marker path '${tempPath}' already exists; refusing to proceed.`,
    );
    return { ok: false, reason: 'temp-marker-collision' };
  }
  // Commit atomically. `rename()` never follows a symlink at `markerPath`
  // — it replaces that path entry itself — so this is safe regardless of
  // what (if anything) raced into place there since the check above.
  await fs.rename(tempPath, markerPath);
  return { ok: true };
}

export interface ImportClaudeGlobalSnapshotOptions {
  /** The user's real global Claude config dir (read-only — never written to). */
  globalDir: string;
  /** The Station-owned profile dir being seeded — must resolve inside `appHomesRootDir(homeDir)`. */
  profileDir: string;
  /** Off by default — `.credentials.json` is only copied when explicitly requested (macOS Keychain auth is config-dir-independent and unaffected either way). */
  includeCredentials?: boolean;
  /** Injectable for tests — defaults to `resolveHomeDir()`, same as `ensureAppHomeProfile`. */
  homeDir?: string;
  fs?: AppHomeFsPort;
  logger?: AppHomeLogger;
}

export interface ImportClaudeGlobalSnapshotResult {
  /**
   * MED-3 (security review): the file-copy loop completing without a
   * caught top-level error is NOT the same thing as the import having
   * actually done anything meaningful — an unreadable/absent `globalDir`
   * used to fall through to a bare `{ copied: [], skipped: [...] }` that
   * every existing caller (and the route) treated as an ordinary, if
   * empty, success. `'completed'` means `globalDir` was actually read
   * (zero copies is a legitimate `'completed'` outcome when it's genuinely
   * empty or every entry is refused); `'failed'` means the import could
   * not even attempt to read `globalDir`, or the `profileDir` containment
   * guard refused up front — callers MUST NOT advance import provenance
   * (`markAppHomeProfileImported`) on a `'failed'` outcome.
   */
  outcome: 'completed' | 'failed';
  /** Present only when `outcome === 'failed'`. */
  reason?: string;
  /**
   * Present only when `outcome === 'failed'` and there is extra
   * human-readable context beyond `reason` — e.g. `'commit-restore'`
   * failures (item 3, security review round 4) name every unrestored
   * backup's preserved path here, so it's never lost even though it
   * isn't part of the machine-readable `reason` taxonomy.
   */
  detail?: string;
  copied: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * MED-2 (security review) TOCTOU-safe source read: opens `path` with
 * `O_NOFOLLOW` and treats the OPENED DESCRIPTOR's `fstat` — never an
 * earlier path-based `lstat` — as the sole source of truth for "is this
 * really a regular file" and "how big is it right now". A caller's prior
 * `lstat` (used only to decide whether to recurse, skip, or read) is never
 * trusted for the read/size-cap decision: a source swapped for a symlink,
 * or grown past the cap, between that `lstat` and this call is refused
 * here, not silently read or truncated.
 */
async function readSourceFileGuarded(
  path: string,
  fs: AppHomeFsPort,
  expectedIdentity?: { dev: number; ino: number },
): Promise<{ ok: true; content: Buffer } | { ok: false; reason: string }> {
  const handle = await fs.openForRead(path, expectedIdentity);
  if (!handle) {
    // ENOENT (vanished), ELOOP (a symlink, refused by O_NOFOLLOW), or an
    // `expectedIdentity` mismatch (item 2: the Windows-only closing move
    // for the same window `O_NOFOLLOW` closes natively elsewhere) — all
    // collapse to the same "refuse, don't read" outcome; a source swapped
    // in after the caller's dispatch `lstat` is the security-relevant case
    // regardless of which of the three actually caught it.
    return { ok: false, reason: 'symlink-in-source' };
  }
  try {
    if (!handle.isFile) {
      return { ok: false, reason: 'unsupported-entry-kind' };
    }
    if (handle.size > APP_HOME_IMPORT_MAX_FILE_BYTES) {
      return { ok: false, reason: 'file-too-large' };
    }
    const content = await handle.read();
    return { ok: true, content };
  } finally {
    await handle.close();
  }
}

async function copyDirTreeGuarded(
  srcRoot: string,
  destRoot: string,
  fs: AppHomeFsPort,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  async function walk(
    srcDir: string,
    destDir: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    await fs.mkdirRecursive(destDir);
    let entries: AppHomeDirEntry[];
    try {
      entries = await fs.readdir(srcDir);
    } catch {
      return { ok: false, reason: 'read-failed' };
    }
    for (const entry of entries) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);
      // Re-`lstat` at copy time — never trust the `readdir` `Dirent` alone
      // (mirrors claude-skills-materialization.ts's copy-time posture).
      // This `lstat` only ever decides DISPATCH (recurse vs. read vs.
      // skip); the actual file read below is independently TOCTOU-guarded,
      // and its own identity (item 2) is what `readSourceFileGuarded`
      // cross-checks against.
      const stat = await fs.lstat(srcPath);
      if (!stat) continue; // vanished mid-copy — nothing left to copy.
      if (stat.isSymbolicLink)
        return { ok: false, reason: 'symlink-in-source' };
      if (stat.isDirectory) {
        const result = await walk(srcPath, destPath);
        if (!result.ok) return result;
      } else if (stat.isFile) {
        const read = await readSourceFileGuarded(srcPath, fs, {
          dev: stat.dev,
          ino: stat.ino,
        });
        if (!read.ok) return { ok: false, reason: read.reason };
        await fs.writeFile(destPath, read.content);
      }
      // Other entry kinds (fifo, socket, char/block device) are not
      // expected inside a Claude config dir and are silently skipped.
    }
    return { ok: true };
  }

  let result: { ok: true } | { ok: false; reason: string };
  try {
    result = await walk(srcRoot, destRoot);
  } catch (error) {
    // Item 4 (security review round 2): an unexpected exception mid-walk
    // must not leave a partial copy behind either — same best-effort
    // cleanup as the structured `!ok` path below, just reached via a
    // throw instead of a returned refusal, before rethrowing.
    await fs.rmRecursive(destRoot).catch(() => {});
    throw error;
  }
  if (!result.ok) {
    // Never leave a partial copy behind — this is Station's own subtree.
    await fs.rmRecursive(destRoot).catch(() => {});
  }
  return result;
}

/**
 * Copies an explicit, user-triggered snapshot of the allowlisted top-level
 * entries of the global Claude config dir into a Station-owned app-home
 * profile. Never merges: each allowlisted entry present in `globalDir`
 * fully replaces any prior imported copy at the same name inside
 * `profileDir` (Station owns the profile, so overwrite-in-place is safe —
 * unlike the workspace-overlay channel's per-session manifest bookkeeping).
 * Transactional (item 1, security review round 3): every entry is copied
 * into a staging dir first and only swapped into place, via
 * backup-then-rename, once every entry has copied successfully — a
 * copy-phase failure or a mid-commit rename failure both leave
 * PREVIOUSLY-imported profile content exactly as it was, never partially
 * overwritten or deleted (see the module doc comment).
 *
 * Refuses (without acting): anything not on the allowlist, any symlink
 * anywhere in a copied tree (refuse, never follow — TOCTOU-safe via
 * `readSourceFileGuarded`'s open-then-fstat posture, not a path-based
 * check), any file over `APP_HOME_IMPORT_MAX_FILE_BYTES` (enforced from the
 * opened descriptor, not an earlier `lstat`), and — before any write at
 * all — a `profileDir` that does not resolve inside `appHomesRootDir()`.
 * `globalDir` is only ever read, never written to. See
 * `ImportClaudeGlobalSnapshotResult.outcome`'s doc comment for the
 * `'completed'`/`'failed'` contract callers MUST branch on before advancing
 * import provenance.
 */
async function importGlobalSnapshot(
  options: ImportClaudeGlobalSnapshotOptions & {
    importProfile: AppHomeImportProfile;
  },
): Promise<ImportClaudeGlobalSnapshotResult> {
  const {
    globalDir,
    profileDir,
    includeCredentials = false,
    importProfile,
  } = options;
  const fs = options.fs ?? defaultFsPort();
  const logger = options.logger ?? console;
  const copied: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const root = appHomesRootDir(options.homeDir);
  const realRoot = await resolveBestEffortRealPath(root, fs);
  const realProfileDir = await resolveBestEffortRealPath(profileDir, fs);
  if (
    realRoot === realProfileDir ||
    !isPathContainedOrEqual(realRoot, realProfileDir)
  ) {
    logger.warn?.(
      `App home import: resolved profile dir '${profileDir}' is not contained in the app-homes root '${root}'; refusing to import anything.`,
    );
    return {
      outcome: 'failed',
      reason: 'profile-dir-outside-app-homes-root',
      copied: [],
      skipped: [{ path: '.', reason: 'profile-dir-outside-app-homes-root' }],
    };
  }

  await fs.mkdirRecursive(profileDir);

  let entries: AppHomeDirEntry[];
  try {
    entries = await fs.readdir(globalDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const reason =
      code === 'ENOENT'
        ? 'global-config-dir-missing'
        : 'global-config-dir-unreadable';
    logger.warn?.(
      `App home import: could not read global config dir '${globalDir}': ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      outcome: 'failed',
      reason,
      copied: [],
      skipped: [{ path: '.', reason }],
    };
  }

  // Item 1 (security review round 3, hardened round 4): transactional
  // stage-then-commit. The OLD flow pre-cleared each EXISTING destination
  // and then copied (and exception cleanup rm-recursived every recorded
  // name) — so a failed or partially-failed import could destroy
  // previously imported content that had nothing to do with the failure.
  // Nothing about EXISTING profile content is touched until every staged
  // entry has copied successfully:
  //  (a) COPY PHASE — every allowlisted entry is copied into a fresh
  //      staging dir INSIDE the profile, EXCLUSIVELY created via
  //      `fs.mkdtemp` (round 4, item 1 — OS-random, atomic, never adopts
  //      a pre-existing/pre-planted directory the way a caller-computed
  //      name handed to `mkdirRecursive` could), with the same
  //      guarded-read/containment checks as before, but they operate on
  //      the stage. Nothing outside the stage is touched here; any
  //      copy-phase exception just removes the stage.
  //  (b) COMMIT PHASE — only once every entry destined for the profile
  //      has copied into the stage: per entry, the pre-existing
  //      destination (if any) is renamed to a backup (also an `mkdtemp`
  //      dir), then the staged entry is renamed into place. If any
  //      rename fails mid-commit, every entry that ALREADY fully swapped
  //      this run is restored from its backup — clearing a non-empty
  //      committed directory first, since `rename()` cannot replace one
  //      (round 4, item 2) — before the stage is removed. A backup this
  //      call could NOT actually restore from is never deleted — it is
  //      preserved and named in the log and the failure result (round 4,
  //      item 3), never silently lost alongside the rest of the backup
  //      dir's cleanup.
  //  (c) On full success, the backup and stage dirs are removed — nothing
  //      but the final committed content remains.
  // Cleanup paths only ever delete the stage/backup dirs THIS invocation
  // created, or restore a destination from ITS OWN backup — never a
  // destination name directly.
  let stageDir: string | undefined;
  const stagedNames: string[] = [];

  try {
    stageDir = await fs.mkdtemp(join(profileDir, '.import-stage-'));

    for (const entry of entries) {
      const name = entry.name;
      const isCredentials = name === importProfile.credentialsFilename;
      if (isCredentials) {
        if (!includeCredentials) {
          skipped.push({ path: name, reason: 'credentials-excluded' });
          continue;
        }
      } else if (
        !importProfile.allowlistFiles.has(name) &&
        !importProfile.allowlistDirs.has(name)
      ) {
        skipped.push({ path: name, reason: 'not-on-allowlist' });
        continue;
      }

      const sourcePath = join(globalDir, name);
      const stat = await fs.lstat(sourcePath);
      if (!stat) {
        skipped.push({ path: name, reason: 'not-found' });
        continue;
      }
      if (stat.isSymbolicLink) {
        skipped.push({ path: name, reason: 'symlink-in-source' });
        continue;
      }

      const stagePath = join(stageDir, name);

      if (stat.isFile) {
        const read = await readSourceFileGuarded(sourcePath, fs, {
          dev: stat.dev,
          ino: stat.ino,
        });
        if (!read.ok) {
          skipped.push({ path: name, reason: read.reason });
          continue;
        }
        await fs.writeFile(stagePath, read.content);
        stagedNames.push(name);
        continue;
      }

      if (stat.isDirectory) {
        const result = await copyDirTreeGuarded(sourcePath, stagePath, fs);
        if (result.ok) {
          stagedNames.push(name);
        } else {
          skipped.push({ path: name, reason: result.reason });
        }
        continue;
      }

      skipped.push({ path: name, reason: 'unsupported-entry-kind' });
    }
  } catch (error) {
    // Copy-phase failure: nothing outside the stage was ever touched, so
    // cleanup is exactly "remove the stage" — pre-existing profile content
    // is untouched BY CONSTRUCTION, not merely by best-effort cleanup.
    if (stageDir) await fs.rmRecursive(stageDir).catch(() => {});
    throw error;
  }

  if (stagedNames.length === 0) {
    // Nothing to commit — no existing content to touch, no residue either.
    await fs.rmRecursive(stageDir).catch(() => {});
    return { outcome: 'completed', copied, skipped };
  }

  // Commit phase: swap each staged entry into place via backup-then-rename.
  const backupDir = await fs.mkdtemp(join(profileDir, '.import-backup-'));
  const committed: Array<{ name: string; hadPrior: boolean }> = [];
  const restoreFailures: Array<{ name: string; backupPath: string }> = [];
  let commitError: unknown;

  for (const name of stagedNames) {
    const destPath = join(profileDir, name);
    const stagePath = join(stageDir, name);
    const backupPath = join(backupDir, name);
    const priorStat = await fs.lstat(destPath);
    const hadPrior = priorStat !== null;

    try {
      if (hadPrior) {
        await fs.rename(destPath, backupPath);
      }
      await fs.rename(stagePath, destPath);
      committed.push({ name, hadPrior });
    } catch (error) {
      // This entry's OWN commit failed. If the backup-away half already
      // succeeded (destPath is currently absent — `rename()` is atomic,
      // so there is no partial state — original content is safe in
      // backupPath), restore it immediately before rolling back
      // everything else that already fully committed this run.
      if (hadPrior) {
        try {
          await fs.rename(backupPath, destPath);
        } catch (restoreError) {
          const detailMsg =
            restoreError instanceof Error
              ? restoreError.message
              : String(restoreError);
          // Item 3 (security review round 4): never delete a backup this
          // call could not actually restore from — it is the ONLY
          // remaining copy of the user's pre-import content.
          logger.warn?.(
            `App home import: could not restore '${name}' from its backup after a failed commit — its backup is PRESERVED at '${backupPath}' for manual recovery: ${detailMsg}`,
          );
          restoreFailures.push({ name, backupPath });
        }
      }
      commitError = error;
      break;
    }
  }

  if (commitError) {
    // Roll back every entry that DID fully commit this run, best-effort,
    // restoring exactly what was there before — a partial commit must
    // never leave a mix of old and new content.
    for (const entry of [...committed].reverse()) {
      const destPath = join(profileDir, entry.name);
      const backupPath = join(backupDir, entry.name);
      try {
        if (entry.hadPrior) {
          // Item 2 (security review round 4): the committed entry may be
          // a non-empty DIRECTORY — `rename()` can never replace one, so
          // it must be cleared before the backup can be renamed back
          // into place.
          await fs.rmRecursive(destPath);
          await fs.rename(backupPath, destPath);
        } else {
          await fs.rmRecursive(destPath);
        }
      } catch (restoreError) {
        const detailMsg =
          restoreError instanceof Error
            ? restoreError.message
            : String(restoreError);
        if (entry.hadPrior) {
          // Item 3: same "never delete an unrestored backup" posture as
          // the per-entry restore above.
          logger.warn?.(
            `App home import: could not restore '${entry.name}' during commit rollback — its backup is PRESERVED at '${backupPath}' for manual recovery: ${detailMsg}`,
          );
          restoreFailures.push({ name: entry.name, backupPath });
        } else {
          logger.warn?.(
            `App home import: could not remove newly-committed '${entry.name}' during commit rollback (it had no prior content to restore): ${detailMsg}`,
          );
        }
      }
    }
    await fs.rmRecursive(stageDir).catch(() => {});
    if (restoreFailures.length === 0) {
      await fs.rmRecursive(backupDir).catch(() => {});
    } else {
      // Item 3: the backup dir as a whole is preserved whenever ANY entry
      // inside it could not be restored — never torn down alongside
      // entries that DID restore successfully.
      logger.warn?.(
        `App home import: preserving backup dir '${backupDir}' — ${restoreFailures.length} entr${restoreFailures.length === 1 ? 'y' : 'ies'} could not be restored during rollback and remain recoverable there.`,
      );
    }
    const commitDetail =
      commitError instanceof Error ? commitError.message : String(commitError);
    const detail =
      restoreFailures.length > 0
        ? `${commitDetail}; unrestored backups preserved: ${restoreFailures
            .map((f) => `${f.name} at ${f.backupPath}`)
            .join(', ')}`
        : commitDetail;
    logger.warn?.(
      `App home import: a rename failed mid-commit; rolled back to the pre-import state: ${commitDetail}`,
    );
    return {
      outcome: 'failed',
      reason: 'commit-restore',
      detail,
      copied: [],
      skipped: [{ path: '.', reason: 'commit-restore' }],
    };
  }

  // Full success: every staged entry is now in place; the backup (if any
  // was created) is no longer needed.
  copied.push(...stagedNames);
  await fs.rmRecursive(backupDir).catch(() => {});
  await fs.rmRecursive(stageDir).catch(() => {});

  return { outcome: 'completed', copied, skipped };
}

/**
 * Copies an explicit, user-triggered snapshot of the allowlisted top-level
 * entries of the global Claude Code config dir into a Station-owned
 * app-home profile. See `importGlobalSnapshot`'s doc comment (shared by
 * both engine delegates) for the full transactional/security contract.
 */
export async function importClaudeGlobalSnapshot(
  options: ImportClaudeGlobalSnapshotOptions,
): Promise<ImportClaudeGlobalSnapshotResult> {
  return importGlobalSnapshot({
    ...options,
    importProfile: CLAUDE_APP_HOME_IMPORT_PROFILE,
  });
}

/**
 * archive#896 wave 2: the Codex counterpart of `importClaudeGlobalSnapshot` — same
 * shared `importGlobalSnapshot` machinery, parameterized over
 * `CODEX_APP_HOME_IMPORT_PROFILE`'s allowlist instead.
 */
export async function importCodexGlobalSnapshot(
  options: ImportClaudeGlobalSnapshotOptions,
): Promise<ImportClaudeGlobalSnapshotResult> {
  return importGlobalSnapshot({
    ...options,
    importProfile: CODEX_APP_HOME_IMPORT_PROFILE,
  });
}

/**
 * archive#896 wave 2: bounded profile GC (docs/design/connections-onboarding.md
 * §1.1) — a usage report + an explicit clear action, deliberately NO
 * background job/watcher/timer (over-engineering guardrails). A hard cap on
 * entries visited keeps a pathologically large or deeply-nested profile
 * from turning an on-request status read into an unbounded walk.
 */
export const APP_HOME_USAGE_MAX_ENTRIES = 10_000;

export interface AppHomeProfileUsage {
  sizeBytes: number;
  entryCount: number;
  truncated: boolean;
}

/**
 * Iterative (stack-based, never recursive — an attacker- or
 * accident-deeply-nested tree cannot blow the stack) walk of a profile dir.
 * Never follows a symlink: a symlinked entry counts as exactly one entry at
 * size 0 and is never recursed into or `readFile`d. Hard-stops with
 * `truncated: true` the moment `APP_HOME_USAGE_MAX_ENTRIES` entries have
 * been counted — the reported `sizeBytes`/`entryCount` are then a genuine
 * partial total, not an estimate. `null` when the profile does not exist
 * (mirrors `readAppHomeProfileStatus`'s `exists: false`, but this report is
 * only meaningful for a profile that's actually there).
 */
export async function readAppHomeProfileUsage(
  engineId: string,
  options: { homeDir?: string; fs?: AppHomeFsPort } = {},
): Promise<AppHomeProfileUsage | null> {
  const fs = options.fs ?? defaultFsPort();
  const dir = appHomeProfileDir(engineId, options.homeDir);
  const rootStat = await fs.lstat(dir);
  if (!rootStat?.isDirectory) return null;

  let sizeBytes = 0;
  let entryCount = 0;
  let truncated = false;
  const stack: string[] = [dir];

  while (stack.length > 0 && !truncated) {
    const current = stack.pop() as string;
    let entries: AppHomeDirEntry[];
    try {
      entries = await fs.readdir(current);
    } catch {
      // Vanished or became unreadable mid-walk — best-effort report, not a
      // hard failure of the whole usage read.
      continue;
    }
    for (const entry of entries) {
      if (entryCount >= APP_HOME_USAGE_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const entryPath = join(current, entry.name);
      const stat = await fs.lstat(entryPath);
      if (!stat) continue; // vanished between readdir and lstat.
      entryCount += 1;
      if (stat.isSymbolicLink) {
        // Counts once, at size 0 — never followed or recursed into.
        continue;
      }
      if (stat.isDirectory) {
        stack.push(entryPath);
        continue;
      }
      sizeBytes += stat.size;
    }
  }

  return { sizeBytes, entryCount, truncated };
}

export type ClearAppHomeProfileResult =
  | { ok: true; cleared: boolean }
  | {
      ok: false;
      reason:
        | 'profile-dir-outside-app-homes-root'
        | 'app-homes-ancestor-is-symlink';
    };

/**
 * HIGH (security review 1a028fde): `isPathContainedOrEqual` above compares
 * RESOLVED paths — if the app-homes ROOT itself (or any ancestor between
 * `baseDir` and `targetDir`) is a symlink, BOTH sides of that check resolve
 * through it consistently and containment still reports true, even though
 * an `rm` on the UNRESOLVED target would be followed by the OS through that
 * symlink onto whatever it actually points at. This walks every UNRESOLVED
 * path component from `baseDir` down to (and including) `targetDir`,
 * `lstat`-checking each one, and refuses (never follows) the moment ANY of
 * them is itself a symlink — the same refuse-don't-follow discipline as
 * `claude-skills-materialization.ts`'s `ensureContainmentAncestors`. A
 * missing component along the way is not a symlink and stops the walk
 * (nothing further to check — there's nothing there to have been swapped).
 */
async function hasSymlinkAncestor(
  baseDir: string,
  targetDir: string,
  fs: AppHomeFsPort,
): Promise<boolean> {
  const baseStat = await fs.lstat(baseDir);
  if (baseStat?.isSymbolicLink) return true;

  const rel = relative(baseDir, targetDir);
  if (rel === '' || rel.startsWith('..')) {
    // `targetDir` is `baseDir` itself (already checked above) or resolves
    // outside it — nothing further to walk.
    return false;
  }
  let current = baseDir;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat) return false;
    if (stat.isSymbolicLink) return true;
  }
  return false;
}

/**
 * Explicit, user-triggered removal of a Station-owned app-home profile dir.
 * Same containment guard as `ensureAppHomeProfile` — refuse BEFORE any
 * `rm`, never act on a path that doesn't provably resolve inside
 * `appHomesRootDir()` — PLUS the `hasSymlinkAncestor` walk above, which
 * catches the resolved-path blind spot the containment check alone cannot
 * (see its doc comment). `cleared: false` (not an error) when nothing
 * existed to clear — mirrors `ImportClaudeGlobalSnapshotResult`'s "zero
 * copies is a legitimate success" posture.
 */
export async function clearAppHomeProfile(
  engineId: string,
  options: {
    homeDir?: string;
    fs?: AppHomeFsPort;
    logger?: AppHomeLogger;
  } = {},
): Promise<ClearAppHomeProfileResult> {
  const fs = options.fs ?? defaultFsPort();
  const logger = options.logger ?? console;
  const homeDir = options.homeDir ?? resolveHomeDir();
  const root = appHomesRootDir(homeDir);
  const dir = appHomeProfileDir(engineId, homeDir);

  const realRoot = await resolveBestEffortRealPath(root, fs);
  const realDir = await resolveBestEffortRealPath(dir, fs);
  if (!isPathContainedOrEqual(realRoot, realDir) || realRoot === realDir) {
    logger.warn?.(
      `App home profile: resolved profile dir '${dir}' is not contained in the app-homes root '${root}'; refusing to clear it.`,
    );
    return { ok: false, reason: 'profile-dir-outside-app-homes-root' };
  }

  if (await hasSymlinkAncestor(homeDir, dir, fs)) {
    logger.warn?.(
      `App home profile: an ancestor of '${dir}' between the station home and the profile dir is a symlink; refusing to clear it.`,
    );
    return { ok: false, reason: 'app-homes-ancestor-is-symlink' };
  }

  const existing = await fs.lstat(dir);
  if (!existing) {
    return { ok: true, cleared: false };
  }
  await fs.rmRecursive(dir);
  return { ok: true, cleared: true };
}
