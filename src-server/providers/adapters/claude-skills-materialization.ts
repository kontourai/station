/**
 * Claude Code skills materialization (docs/design/connections-onboarding.md
 * §5): copies the Claude runtime connection's opted-in Station skills
 * (`AgentConnectionSettings.config.provideSkills` for the `claude-runtime`
 * connection, off/empty by default — the hygiene rule is "never silent",
 * same as MCP passthrough) into `<cwd>/.claude/skills/<skill-id>/` so
 * Claude Code's native skill loader discovers them without any Station
 * involvement at chat time.
 *
 * SECURITY REDESIGN (review round, post-79ec2be4): this module writes into
 * the user's working tree and then, later, deletes things from it — the two
 * operations a "safety core" for this feature must get right are (a) never
 * acting on a path that isn't provably inside `<cwd>/.claude/skills/`, and
 * (b) never deleting a file whose identity changed between "we verified it"
 * and "we removed it". Both are enforced structurally, not just documented:
 *
 *  - **Manifest containment.** A manifest is fully validated (every skill id
 *    with the same predicate the MCP passthrough slice added
 *    (`isSafeToolServerId`), every `relativePath` rejecting absolute paths,
 *    `..` segments, and backslashes) before ANY of it is trusted. A manifest
 *    that fails validation — corrupted OR crafted — is quarantined (renamed
 *    `<manifest>.invalid-<ts>-<rand>`, logged) and treated as empty for this
 *    call. Nothing in an invalid manifest is ever acted on, and it is never
 *    silently unlinked.
 *  - **Root containment, resolved.** `.claude` and `.claude/skills` are
 *    verified (and, if absent, created) as real, non-symlink directories,
 *    and `.claude/skills`'s `realpath` is the one trusted anchor
 *    (`realSkillsRoot`) for the rest of the call. Every manifest-derived or
 *    skill-id-derived path is resolved by walking component-by-component
 *    from that anchor (`resolveContainedPath`), `lstat`-checking each
 *    intermediate component so a symlink anywhere in the chain — including
 *    one introduced inside a skill's own subtree — aborts that resolution
 *    rather than being silently followed.
 *  - **TOCTOU-safe delete.** A file is never hashed-then-unlinked by path
 *    alone. `cleanupSkillFilesSafely` opens the file once (`openForRead`),
 *    reads its content and `dev`/`ino` from that SAME file descriptor, and
 *    only unlinks after a final fresh `lstat` on the path confirms it is
 *    still a non-symlink regular file with the identical `dev`/`ino` — a
 *    swap between verification and deletion is refused, not raced.
 *  - **Atomic claim, atomic write.** A skill directory is claimed with a
 *    non-recursive, exclusive `mkdir` (`EEXIST` ⇒ we lost the race or it's
 *    genuinely foreign ⇒ skip, no cleanup of it — we never remove a
 *    directory we didn't just create ourselves in this call). Every file
 *    and nested directory inside is written with the equivalent of
 *    `O_EXCL` (`writeExclusive`/`mkdirExclusive`), so a destination swapped
 *    in mid-copy fails loudly instead of being silently overwritten or
 *    followed. Source entries are re-`lstat`ed at copy time (not trusted
 *    from the `readdir` `Dirent` alone) — a symlink anywhere in a skill's
 *    source aborts that skill's copy and the partial claim is fully
 *    removed (safe: it's a directory we just created, tracked explicitly).
 *  - **Per-session manifests, no cross-session interference.** Each session
 *    (`sessionId`, the adapter's `threadId`) owns its own manifest file
 *    (`.station-materialized.<sessionId>.json`). A session only ever cleans
 *    its OWN manifest at stop. `sweepStaleManifests` — run best-effort at
 *    the next session's start — only ever touches OTHER sessions' manifests
 *    that are both not currently live (per the caller's `isLiveSessionId`)
 *    AND older than a grace threshold (`staleAfterMs`, default 5 minutes),
 *    so two sessions racing to start in the same `cwd` can't sweep each
 *    other's in-flight manifest. Two sessions selecting the same skill
 *    naturally resolve via the atomic claim: the second sees `EEXIST` and
 *    skips with a logged `target-exists-not-ours`.
 *  - **Tracked-only empty-dir pruning.** Only directories THIS module
 *    created while materializing a skill (recorded per-skill in the
 *    manifest's `dirs` list) are ever candidates for removal, deepest
 *    first, and only when empty — a user-created empty directory that
 *    happens to sit inside `.claude/skills/<id>/` is never touched because
 *    it was never recorded as ours.
 *
 * Pure(ish) and injectable: the only I/O is the `fs` port (defaults to real
 * `node:fs`/`node:fs/promises`) and the caller-supplied `resolveSkillDir`
 * callback. `materializeSkills` is opt-in gated — an absent/empty
 * `skillIds` is a true no-op: no manifest read, no directory created, no
 * writes at all.
 */
import { createHash } from 'node:crypto';
import {
  lstatSync as nodeLstatSync,
  realpathSync as nodeRealpathSync,
} from 'node:fs';
import {
  mkdir as nodeMkdir,
  open as nodeOpen,
  readdir as nodeReaddir,
  rename as nodeRename,
  rm as nodeRm,
  rmdir as nodeRmdir,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve as resolvePath,
} from 'node:path';
import { isSafeToolServerId } from '@kontourai/station-contracts/tool';

/** Matches the `any`-typed logger threaded through the rest of `providers/adapters`. */
type MaterializationLogger = any;

const CLAUDE_DIRNAME = '.claude';
const SKILLS_DIRNAME = 'skills';
const MANIFEST_PREFIX = '.station-materialized.';
const MANIFEST_SUFFIX = '.json';
const MANIFEST_ID_PATTERN = /^\.station-materialized\.(.+)\.json$/;
const MANIFEST_VERSION = 2 as const;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface SkillMaterializationDirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface SkillMaterializationStat {
  isSymbolicLink: boolean;
  isFile: boolean;
  isDirectory: boolean;
  dev: number;
  ino: number;
}

export interface SkillMaterializationFileHandle {
  isFile: boolean;
  dev: number;
  ino: number;
  read(): Promise<Buffer>;
  close(): Promise<void>;
}

/** Injectable fs primitives — defaults to real `node:fs`/`node:fs/promises`. Every path-mutating primitive here is deliberately narrow (no plain recursive "just delete/copy this" helper) so the safety logic above can't be bypassed by a shortcut. */
export interface SkillMaterializationFsPort {
  /** `null` on ENOENT — never follows symlinks for the purpose of reporting whether the path itself is one. */
  lstat: (path: string) => Promise<SkillMaterializationStat | null>;
  /** `null` if the path cannot be resolved (ENOENT, ELOOP, etc). */
  realpath: (path: string) => Promise<string | null>;
  /** `mkdir -p` semantics — tolerant of an already-existing directory. */
  mkdirRecursive: (path: string) => Promise<void>;
  /** Non-recursive, exclusive create. `'created'` on success; `'exists'` when the path already exists as anything at all (including a symlink) — never throws for that case. Any other error throws (e.g. missing parent). */
  mkdirExclusive: (path: string) => Promise<'created' | 'exists'>;
  readdir: (path: string) => Promise<SkillMaterializationDirEntry[]>;
  /** `null` on ENOENT. */
  openForRead: (path: string) => Promise<SkillMaterializationFileHandle | null>;
  /** `O_CREAT|O_EXCL|O_WRONLY` — throws `EEXIST` if the path already exists in any form. */
  writeExclusive: (path: string, data: Buffer) => Promise<void>;
  /** Used only for the manifest file itself. */
  writeFile: (path: string, data: Buffer) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  /** Removes `path` only if empty; returns whether it was removed. */
  rmdirIfEmpty: (path: string) => Promise<boolean>;
  /** Recursively removes `path` unconditionally — only ever invoked on a directory THIS module created via `mkdirExclusive` returning `'created'` earlier in the SAME call. */
  rmRecursive: (path: string) => Promise<void>;
}

function toStat(stat: {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  dev: number;
  ino: number;
}): SkillMaterializationStat {
  return {
    isSymbolicLink: stat.isSymbolicLink(),
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    dev: stat.dev,
    ino: stat.ino,
  };
}

function defaultFsPort(): SkillMaterializationFsPort {
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
    mkdirExclusive: async (path) => {
      try {
        await nodeMkdir(path);
        return 'created';
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST')
          return 'exists';
        throw error;
      }
    },
    readdir: (path) => nodeReaddir(path, { withFileTypes: true }),
    openForRead: async (path) => {
      let handle: Awaited<ReturnType<typeof nodeOpen>>;
      try {
        handle = await nodeOpen(path, 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw error;
      }
      const stat = await handle.stat();
      return {
        isFile: stat.isFile(),
        dev: stat.dev,
        ino: stat.ino,
        read: () => handle.readFile() as Promise<Buffer>,
        close: () => handle.close(),
      };
    },
    writeExclusive: async (path, data) => {
      await nodeWriteFile(path, data, { flag: 'wx' });
    },
    writeFile: (path, data) => nodeWriteFile(path, data),
    unlink: (path) => nodeUnlink(path),
    rename: (from, to) => nodeRename(from, to),
    rmdirIfEmpty: async (path) => {
      try {
        await nodeRmdir(path);
        return true;
      } catch {
        return false;
      }
    },
    rmRecursive: async (path) => {
      await nodeRm(path, { recursive: true, force: true });
    },
  };
}

export type SkillMaterializationSkipReason =
  | 'unsafe-id'
  | 'unsafe-session-id'
  | 'not-found'
  | 'target-exists-not-ours'
  | 'symlink-in-source'
  | 'containment-violation'
  | 'copy-failed'
  | 'global-config-target';

export interface SkillMaterializationSkip {
  id: string;
  reason: SkillMaterializationSkipReason;
  detail?: string;
}

export interface MaterializeSkillsInput {
  /** `AgentConnectionSettings.config.provideSkills` for `claude-runtime` — absent/empty ⇒ true no-op, no I/O at all. */
  skillIds: string[] | undefined;
  /** The session's working directory — skills land in `<cwd>/.claude/skills/<id>/`. */
  cwd: string;
  /** This session's own identity (the adapter's `threadId`) — owns its own manifest file, never another session's. */
  sessionId: string;
  /** Resolve a skill id to its installed on-disk directory (containing SKILL.md); `null` when unknown. */
  resolveSkillDir: (id: string) => Promise<string | null>;
  /**
   * Global engine config directories this workspace-overlay channel must
   * never write into or read out of (agent-engine-unification.md §6.1's
   * hard guard) — injectable for tests, defaulted at the call site via
   * `defaultClaudeGlobalConfigDirs()`. Absent/empty ⇒ the check is skipped
   * (no global dirs known), matching pre-guard behavior.
   */
  globalConfigDirs?: string[];
  logger?: MaterializationLogger;
  fs?: SkillMaterializationFsPort;
}

export interface MaterializeSkillsResult {
  materialized: string[];
  skipped: SkillMaterializationSkip[];
}

interface ManifestFileEntry {
  relativePath: string;
  sha256: string;
}

interface ManifestSkillEntry {
  files: ManifestFileEntry[];
  /** Directories THIS module created while materializing this skill, relative to the skill's own directory; `''` denotes the skill directory itself. Pruning at cleanup only ever considers these. */
  dirs: string[];
  materializedAt: string;
}

interface StationMaterializedManifest {
  version: typeof MANIFEST_VERSION;
  sessionId: string;
  skills: Record<string, ManifestSkillEntry>;
}

function emptyManifest(sessionId: string): StationMaterializedManifest {
  return { version: MANIFEST_VERSION, sessionId, skills: {} };
}

function skillsRootFor(cwd: string): string {
  return join(cwd, CLAUDE_DIRNAME, SKILLS_DIRNAME);
}

function manifestFileNameFor(sessionId: string): string {
  return `${MANIFEST_PREFIX}${sessionId}${MANIFEST_SUFFIX}`;
}

function manifestPathFor(cwd: string, sessionId: string): string {
  return join(skillsRootFor(cwd), manifestFileNameFor(sessionId));
}

function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Rejects absolute paths, empty segments, `.`/`..` segments, and backslashes — the manifest-derived counterpart to `isSafeToolServerId` for a multi-segment relative path. */
function isValidRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  return value
    .split('/')
    .every(
      (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
    );
}

/**
 * Validates a parsed manifest's ENTIRE shape and content — every skill id
 * with `isSafeToolServerId`, every `relativePath`/`dirs` entry with
 * `isValidRelativePath`, every hash as a well-formed sha256 hex digest, and
 * the embedded `sessionId` against the filename it was read from. This is
 * all-or-nothing: one invalid entry invalidates the whole manifest (`null`)
 * rather than trying to salvage the "good parts" of something that has
 * already proven to contain unsafe data.
 */
function validateManifestShape(
  raw: unknown,
  expectedSessionId: string,
): StationMaterializedManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== MANIFEST_VERSION) return null;
  if (candidate.sessionId !== expectedSessionId) return null;
  if (
    !candidate.skills ||
    typeof candidate.skills !== 'object' ||
    Array.isArray(candidate.skills)
  ) {
    return null;
  }

  const skills: StationMaterializedManifest['skills'] = {};
  for (const [id, entryRaw] of Object.entries(
    candidate.skills as Record<string, unknown>,
  )) {
    if (!isSafeToolServerId(id)) return null;
    if (!entryRaw || typeof entryRaw !== 'object') return null;
    const entry = entryRaw as Record<string, unknown>;
    if (!Array.isArray(entry.files) || !Array.isArray(entry.dirs)) return null;
    if (typeof entry.materializedAt !== 'string') return null;

    const files: ManifestFileEntry[] = [];
    for (const fileRaw of entry.files) {
      if (!fileRaw || typeof fileRaw !== 'object') return null;
      const relativePath = (fileRaw as Record<string, unknown>).relativePath;
      const sha256 = (fileRaw as Record<string, unknown>).sha256;
      if (!isValidRelativePath(relativePath)) return null;
      if (typeof sha256 !== 'string' || !SHA256_HEX_PATTERN.test(sha256)) {
        return null;
      }
      files.push({ relativePath, sha256 });
    }

    const dirs: string[] = [];
    for (const dirRaw of entry.dirs) {
      if (dirRaw === '') {
        dirs.push('');
        continue;
      }
      if (!isValidRelativePath(dirRaw)) return null;
      dirs.push(dirRaw);
    }

    skills[id] = { files, dirs, materializedAt: entry.materializedAt };
  }

  return { version: MANIFEST_VERSION, sessionId: expectedSessionId, skills };
}

async function quarantineManifest(
  path: string,
  fs: SkillMaterializationFsPort,
  logger: MaterializationLogger,
  reason: string,
): Promise<void> {
  const target = `${path}.invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.rename(path, target);
    logger.warn?.(
      `Claude skills materialization: quarantined manifest '${path}' -> '${target}' (${reason}); nothing in it is acted on.`,
    );
  } catch (error) {
    logger.warn?.(
      `Claude skills materialization: manifest '${path}' failed validation (${reason}) and could not be quarantined (${error instanceof Error ? error.message : String(error)}); treating it as absent — nothing in it is acted on.`,
    );
  }
}

/** Reads and fully validates a manifest, quarantining it (never unlinking it) on ANY failure — corrupt JSON, wrong shape, an unsafe id, an unsafe path, or a `sessionId` mismatch. */
async function readManifestOrQuarantine(
  path: string,
  sessionId: string,
  fs: SkillMaterializationFsPort,
  logger: MaterializationLogger,
): Promise<StationMaterializedManifest> {
  const stat = await fs.lstat(path);
  if (!stat) return emptyManifest(sessionId);
  if (stat.isSymbolicLink || !stat.isFile) {
    await quarantineManifest(path, fs, logger, 'not a regular file');
    return emptyManifest(sessionId);
  }

  const handle = await fs.openForRead(path);
  if (!handle) return emptyManifest(sessionId);
  let raw: unknown;
  try {
    if (!handle.isFile) {
      await quarantineManifest(path, fs, logger, 'not a regular file');
      return emptyManifest(sessionId);
    }
    const content = await handle.read();
    raw = JSON.parse(content.toString('utf-8'));
  } catch {
    await handle.close();
    await quarantineManifest(path, fs, logger, 'unparseable JSON');
    return emptyManifest(sessionId);
  }
  await handle.close();

  const validated = validateManifestShape(raw, sessionId);
  if (!validated) {
    await quarantineManifest(
      path,
      fs,
      logger,
      'failed schema/safety validation',
    );
    return emptyManifest(sessionId);
  }
  return validated;
}

async function writeManifest(
  path: string,
  manifest: StationMaterializedManifest,
  fs: SkillMaterializationFsPort,
): Promise<void> {
  await fs.writeFile(
    path,
    Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
  );
}

/**
 * Resolves this Claude installation's global config directories the SAME
 * way `claude-auth.ts`'s `detectClaudeAuthState` does: an explicit
 * `CLAUDE_CONFIG_DIR` env var (trimmed, when non-empty) is one candidate,
 * and `~/.claude` is always a candidate. Both are returned — the caller
 * checks a workspace-overlay target against every one of them, not just
 * whichever env resolution "wins" for auth purposes — because a stale or
 * differently-scoped `CLAUDE_CONFIG_DIR` must not let a session cwd land
 * inside the OTHER (default) global config dir either.
 *
 * MED-1 (security review): a RELATIVE `CLAUDE_CONFIG_DIR` value is resolved
 * against `sessionCwd` — the same directory the spawned Claude Code child
 * actually runs in (`Options.cwd`, per `claude-adapter.ts`'s `buildOptions`)
 * and therefore the directory a relative env var value would be interpreted
 * against in practice — never against Station's OWN server process cwd
 * (which is unrelated, typically the repo root, and was the pre-fix
 * default via plain `path.join`/`fs.realpath`'s implicit `process.cwd()`
 * fallback). Absent `sessionCwd`, falls back to `process.cwd()` for
 * call sites with no session context (documented, not a security boundary
 * on its own — those callers have no relative-path threat model to resolve
 * against).
 */
export function defaultClaudeGlobalConfigDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  sessionCwd?: string,
): string[] {
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = raw
    ? isAbsolute(raw)
      ? raw
      : resolvePath(sessionCwd ?? process.cwd(), raw)
    : undefined;
  return [configDir, join(home, '.claude')].filter((dir): dir is string =>
    Boolean(dir),
  );
}

/**
 * Default case-sensitivity posture for path containment comparisons:
 * case-INSENSITIVE on darwin (APFS's default mode) and win32 (NTFS's
 * default mode), case-sensitive everywhere else (ext4 and friends).
 * `process.platform`-keyed, matching this repo's other platform switches
 * (see AGENTS.md's Windows-compatibility guidance).
 */
const DEFAULT_CASE_INSENSITIVE_PLATFORM = (): boolean =>
  process.platform === 'darwin' || process.platform === 'win32';

/**
 * `true` when `child` is `parent` itself or nested under it, by resolved
 * path components (not string prefix — avoids `/foo-bar` falsely matching
 * parent `/foo`).
 *
 * MED-1 (security review): `realpath`'s OS-level case canonicalization only
 * applies to path components that ALREADY EXIST on disk — a not-yet-created
 * `.claude` (the exact common case here, since this guard runs BEFORE
 * `ensureContainmentAncestors` creates anything) never gets that
 * normalization, so on a case-insensitive filesystem a case-aliased path
 * (e.g. `.CLAUDE` vs. `.claude` — the SAME underlying directory on
 * APFS/NTFS) could otherwise dodge a case-sensitive string comparison. The
 * `caseInsensitive` flag (default: platform-keyed) lowercases both sides
 * before comparing so this can't be used to bypass the guard; it is also
 * test-injectable so the property can be pinned without depending on the
 * test host's actual filesystem case-sensitivity.
 */
function isPathContainedOrEqual(
  parent: string,
  child: string,
  caseInsensitive: boolean = DEFAULT_CASE_INSENSITIVE_PLATFORM(),
): boolean {
  const compareParent = caseInsensitive ? parent.toLowerCase() : parent;
  const compareChild = caseInsensitive ? child.toLowerCase() : child;
  const rel = relative(compareParent, compareChild);
  return rel === '' || (!rel.startsWith('..') && rel !== '..');
}

/**
 * Best-effort realpath: resolves symlinks/`..` when the path exists.
 * Otherwise walks UP to the nearest existing ancestor, realpaths THAT, and
 * rejoins the not-yet-existing suffix — never falls back to the raw,
 * unresolved input alone, which would silently miscompare against a
 * realpath'ed sibling on a host where an ancestor itself is a symlink
 * (e.g. macOS's `/tmp` -> `/private/tmp`): two paths that are really the
 * same directory could otherwise look unequal solely because one leaf
 * segment doesn't exist yet (a not-yet-created session cwd, or a global
 * config dir the user has never initialized).
 */
async function resolveBestEffortRealPath(
  path: string,
  fs: SkillMaterializationFsPort,
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
    if (parent === current) {
      // Reached the filesystem root without finding any existing ancestor
      // — nothing left to resolve against; return the normalized input.
      return normalize(path);
    }
    suffixSegments.push(basename(current));
    current = parent;
  }
}

/**
 * The workspace-overlay channel's hard guard (agent-engine-unification.md
 * §6.1): refuses any materialization whose `<cwd>/.claude` target resolves
 * (by REAL path, so a symlinked cwd cannot dodge it) into — or itself
 * contains — one of the caller's known global engine config directories.
 * A dirless/home-defaulted session cwd is a live hazard, not a hypothetical
 * one: `.claude/skills/` under `~` (or under a `CLAUDE_CONFIG_DIR`-pointed
 * dir) IS the user's real global config, and even an empty `mkdir` there is
 * already a violation — this MUST run before `ensureContainmentAncestors`,
 * which mkdirs unconditionally. `globalConfigDirs` absent/empty is a no-op
 * (nothing known to refuse against).
 */
async function isGlobalConfigTarget(
  cwd: string,
  globalConfigDirs: string[] | undefined,
  fs: SkillMaterializationFsPort,
): Promise<boolean> {
  if (!globalConfigDirs || globalConfigDirs.length === 0) return false;
  const realCwd = await resolveBestEffortRealPath(cwd, fs);
  const claudeDirCandidate = join(realCwd, CLAUDE_DIRNAME);
  for (const rawDir of globalConfigDirs) {
    if (!rawDir) continue;
    const realGlobalDir = await resolveBestEffortRealPath(rawDir, fs);
    if (
      isPathContainedOrEqual(realGlobalDir, claudeDirCandidate) ||
      isPathContainedOrEqual(claudeDirCandidate, realGlobalDir)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Verifies (creating if absent) that `.claude` and `.claude/skills` under
 * `cwd` are real, non-symlink directories, and resolves `.claude/skills`'s
 * realpath as the trusted containment anchor for the rest of the call.
 */
async function ensureContainmentAncestors(
  cwd: string,
  fs: SkillMaterializationFsPort,
): Promise<
  | { ok: true; skillsRoot: string; realSkillsRoot: string }
  | { ok: false; reason: string }
> {
  const claudeDir = join(cwd, CLAUDE_DIRNAME);
  const skillsRoot = join(claudeDir, SKILLS_DIRNAME);
  for (const dir of [claudeDir, skillsRoot]) {
    let stat = await fs.lstat(dir);
    if (!stat) {
      await fs.mkdirRecursive(dir);
      stat = await fs.lstat(dir);
    }
    if (!stat || stat.isSymbolicLink || !stat.isDirectory) {
      return {
        ok: false,
        reason: `'${dir}' is not a real, non-symlink directory`,
      };
    }
  }
  const realSkillsRoot = await fs.realpath(skillsRoot);
  if (!realSkillsRoot) {
    return {
      ok: false,
      reason: `'${skillsRoot}' vanished before it could be resolved`,
    };
  }
  return { ok: true, skillsRoot, realSkillsRoot };
}

/**
 * Resolves `segments` joined onto `realSkillsRoot`, `lstat`-checking every
 * intermediate component so a symlink anywhere in the chain — including one
 * nested inside a skill's own subtree — is refused rather than followed.
 * Returns `null` on any containment violation or malformed segment. A
 * segment that does not exist yet is fine (nothing to violate); an existing
 * NON-leaf segment must be a real directory.
 */
async function resolveContainedPath(
  realSkillsRoot: string,
  segments: string[],
  fs: SkillMaterializationFsPort,
): Promise<string | null> {
  let current = realSkillsRoot;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\')
    ) {
      return null;
    }
    current = join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat) continue;
    if (stat.isSymbolicLink) return null;
    const isLast = i === segments.length - 1;
    if (!isLast && !stat.isDirectory) return null;
  }
  return current;
}

class SymlinkEncounteredError extends Error {}
class ContainmentViolationError extends Error {}

/**
 * Copies `sourceDir`'s tree into the already-claimed `<realSkillsRoot>/<skillId>/`
 * directory. Every destination path is re-resolved through
 * `resolveContainedPath`; every nested directory is created with
 * `mkdirExclusive` (an unexpected `EEXIST` — something raced in after our
 * claim — aborts the whole copy); every file is written with
 * `writeExclusive`; every source entry is freshly `lstat`ed at copy time
 * (never trusting the `readdir` `Dirent` alone) and a symlink anywhere
 * aborts the copy.
 */
async function materializeSkillTree(
  sourceDir: string,
  realSkillsRoot: string,
  skillId: string,
  fs: SkillMaterializationFsPort,
): Promise<{ files: ManifestFileEntry[]; dirs: string[] }> {
  const files: ManifestFileEntry[] = [];
  const dirs: string[] = [''];

  async function walk(srcDir: string, relSegments: string[]): Promise<void> {
    const entries = await fs.readdir(srcDir);
    for (const entry of entries) {
      const srcPath = join(srcDir, entry.name);
      const freshStat = await fs.lstat(srcPath);
      if (!freshStat || freshStat.isSymbolicLink) {
        throw new SymlinkEncounteredError(srcPath);
      }
      const childRelSegments = [...relSegments, entry.name];
      const destPath = await resolveContainedPath(
        realSkillsRoot,
        [skillId, ...childRelSegments],
        fs,
      );
      if (!destPath) {
        throw new ContainmentViolationError(childRelSegments.join('/'));
      }
      if (freshStat.isDirectory) {
        const created = await fs.mkdirExclusive(destPath);
        if (created !== 'created') {
          throw new ContainmentViolationError(
            `${childRelSegments.join('/')} (unexpected pre-existing directory)`,
          );
        }
        dirs.push(childRelSegments.join('/'));
        await walk(srcPath, childRelSegments);
      } else if (freshStat.isFile) {
        const handle = await fs.openForRead(srcPath);
        if (!handle) {
          throw new Error(`source file vanished mid-copy: ${srcPath}`);
        }
        let content: Buffer;
        try {
          content = await handle.read();
        } finally {
          await handle.close();
        }
        await fs.writeExclusive(destPath, content);
        files.push({
          relativePath: childRelSegments.join('/'),
          sha256: sha256Of(content),
        });
      }
      // Other entry kinds (fifo, socket, char/block device) are not
      // expected inside a SKILL.md directory tree and are skipped.
    }
  }

  await walk(sourceDir, []);
  return { files, dirs };
}

/**
 * TOCTOU-safe per-file delete: opens the file once, reads its content AND
 * identity (`dev`/`ino`) from that SAME descriptor, hashes the content, and
 * — only if the hash matches — re-`lstat`s the path immediately before
 * unlinking to confirm it is STILL a non-symlink regular file with the
 * IDENTICAL `dev`/`ino` the descriptor reported. Any mismatch, at any step,
 * retains the file (never deletes it) and is logged.
 */
async function cleanupSkillFilesSafely(
  realSkillsRoot: string,
  skillId: string,
  files: ManifestFileEntry[],
  fs: SkillMaterializationFsPort,
  logger: MaterializationLogger = console,
): Promise<{ remainingFiles: ManifestFileEntry[] }> {
  const remainingFiles: ManifestFileEntry[] = [];
  for (const file of files) {
    const filePath = await resolveContainedPath(
      realSkillsRoot,
      [skillId, ...file.relativePath.split('/')],
      fs,
    );
    if (!filePath) {
      remainingFiles.push(file);
      logger.warn?.(
        `Claude skills materialization cleanup: refusing to touch '${skillId}/${file.relativePath}' — containment check failed (a symlink may have been introduced); leaving it in place.`,
      );
      continue;
    }

    const handle = await fs.openForRead(filePath);
    if (!handle) continue; // Already gone — nothing to remove, nothing to retry.

    let matches = false;
    try {
      if (handle.isFile) {
        const content = await handle.read();
        matches = sha256Of(content) === file.sha256;
      }
      if (matches) {
        // Tightest possible window: fresh lstat immediately before unlink,
        // requiring the SAME identity the open fd reported — closes the
        // hash-then-unlink swap race.
        const finalStat = await fs.lstat(filePath);
        if (
          !finalStat ||
          finalStat.isSymbolicLink ||
          finalStat.dev !== handle.dev ||
          finalStat.ino !== handle.ino
        ) {
          matches = false;
          logger.warn?.(
            `Claude skills materialization cleanup: '${skillId}/${file.relativePath}' changed identity between verification and deletion; leaving it in place rather than risk deleting the wrong file.`,
          );
        }
      }
    } finally {
      await handle.close();
    }

    if (!matches) {
      remainingFiles.push(file);
      continue;
    }
    try {
      await fs.unlink(filePath);
    } catch {
      remainingFiles.push(file);
    }
  }
  return { remainingFiles };
}

/** Prunes ONLY the directories this module recorded creating for `skillId` (`entryDirs`), deepest first, and only when actually empty. Never touches a directory it didn't create. */
async function pruneTrackedDirs(
  realSkillsRoot: string,
  skillId: string,
  entryDirs: string[],
  fs: SkillMaterializationFsPort,
): Promise<void> {
  const deepestFirst = [...entryDirs].sort(
    (a, b) =>
      b.split('/').filter(Boolean).length - a.split('/').filter(Boolean).length,
  );
  for (const dir of deepestFirst) {
    const segments = dir === '' ? [skillId] : [skillId, ...dir.split('/')];
    const dirPath = await resolveContainedPath(realSkillsRoot, segments, fs);
    if (!dirPath) continue;
    const stat = await fs.lstat(dirPath);
    if (!stat || stat.isSymbolicLink || !stat.isDirectory) continue;
    let entries: SkillMaterializationDirEntry[];
    try {
      entries = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    if (entries.length > 0) continue;
    await fs.rmdirIfEmpty(dirPath);
  }
}

/**
 * Attempts to fully reclaim a skill directory this module previously
 * materialized (tracked in `existingEntry`) under THIS session's own
 * manifest, so it can be re-copied cleanly. Returns `false` (leaving
 * whatever remains untouched) if any tracked file no longer matches its
 * recorded hash, or if the directory still exists after pruning (a
 * non-tracked file is sitting in it) — both are exactly the "don't
 * overwrite" case even though a manifest record exists.
 */
async function reclaimOwnedSkillDir(
  realSkillsRoot: string,
  skillId: string,
  existingEntry: ManifestSkillEntry,
  fs: SkillMaterializationFsPort,
  logger: MaterializationLogger,
): Promise<boolean> {
  const { remainingFiles } = await cleanupSkillFilesSafely(
    realSkillsRoot,
    skillId,
    existingEntry.files,
    fs,
    logger,
  );
  if (remainingFiles.length > 0) return false;
  await pruneTrackedDirs(realSkillsRoot, skillId, existingEntry.dirs, fs);
  const skillDirPath = await resolveContainedPath(
    realSkillsRoot,
    [skillId],
    fs,
  );
  if (skillDirPath) {
    const stat = await fs.lstat(skillDirPath);
    if (stat) return false; // Still exists — not fully reclaimed.
  }
  return true;
}

/**
 * Materializes the opted-in skill ids into `<cwd>/.claude/skills/`, scoped
 * to THIS session's own manifest (`sessionId`). A true no-op (no I/O
 * whatsoever) when `skillIds` is absent or empty — the off-by-default case
 * must never touch disk.
 */
export async function materializeSkills(
  input: MaterializeSkillsInput,
): Promise<MaterializeSkillsResult> {
  const {
    skillIds,
    cwd,
    sessionId,
    resolveSkillDir,
    globalConfigDirs,
    logger = console,
    fs = defaultFsPort(),
  } = input;

  const materialized: string[] = [];
  const skipped: SkillMaterializationSkip[] = [];

  if (!skillIds || skillIds.length === 0) {
    return { materialized, skipped };
  }

  if (!isSafeToolServerId(sessionId)) {
    logger.warn?.(
      `Claude skills materialization: session id '${sessionId}' is not filesystem-safe; refusing to materialize anything for it.`,
    );
    return {
      materialized,
      skipped: skillIds.map((id) => ({
        id,
        reason: 'unsafe-session-id' as const,
      })),
    };
  }

  // Workspace-overlay channel policy (agent-engine-unification.md §6.1):
  // MUST run before ensureContainmentAncestors, which mkdirs unconditionally
  // — creating even an empty directory inside the user's global engine
  // config is already a violation. Zero filesystem writes on refusal.
  if (await isGlobalConfigTarget(cwd, globalConfigDirs, fs)) {
    logger.warn?.(
      `Claude skills materialization: '${cwd}' resolves '.claude' into a global Claude Code config directory; refusing to materialize anything for it.`,
    );
    return {
      materialized,
      skipped: skillIds.map((id) => ({
        id,
        reason: 'global-config-target' as const,
      })),
    };
  }

  const ancestors = await ensureContainmentAncestors(cwd, fs);
  if (!ancestors.ok) {
    logger.warn?.(
      `Claude skills materialization: ${ancestors.reason}; refusing to materialize into '${cwd}'.`,
    );
    return {
      materialized,
      skipped: skillIds.map((id) => ({
        id,
        reason: 'containment-violation' as const,
      })),
    };
  }
  const { realSkillsRoot } = ancestors;
  const manifestPath = manifestPathFor(cwd, sessionId);
  const manifest = await readManifestOrQuarantine(
    manifestPath,
    sessionId,
    fs,
    logger,
  );
  let manifestDirty = false;

  for (const rawId of skillIds) {
    if (!isSafeToolServerId(rawId)) {
      skipped.push({ id: rawId, reason: 'unsafe-id' });
      logger.warn?.(
        `Claude skills materialization: id '${rawId}' is not filesystem-safe (empty, '.', '..', or a path separator); skipping.`,
      );
      continue;
    }

    const existingEntry = manifest.skills[rawId];
    if (existingEntry) {
      const reclaimed = await reclaimOwnedSkillDir(
        realSkillsRoot,
        rawId,
        existingEntry,
        fs,
        logger,
      );
      if (!reclaimed) {
        skipped.push({ id: rawId, reason: 'target-exists-not-ours' });
        logger.warn?.(
          `Claude skills materialization: this session's own prior copy of '${rawId}' has user-modified or foreign content; skipping rather than overwrite it.`,
        );
        continue;
      }
      delete manifest.skills[rawId];
      manifestDirty = true;
    }

    const claimPath = await resolveContainedPath(realSkillsRoot, [rawId], fs);
    if (!claimPath) {
      skipped.push({ id: rawId, reason: 'containment-violation' });
      logger.warn?.(
        `Claude skills materialization: '${rawId}' failed containment resolution; skipping.`,
      );
      continue;
    }
    const claim = await fs.mkdirExclusive(claimPath);
    if (claim !== 'created') {
      // Someone else — a concurrent session, or a genuine pre-existing
      // directory — owns this path. We never remove a directory we didn't
      // just create ourselves in this call.
      skipped.push({ id: rawId, reason: 'target-exists-not-ours' });
      logger.warn?.(
        `Claude skills materialization: '${claimPath}' already exists (another session or the user); skipping '${rawId}' rather than contend for it.`,
      );
      continue;
    }

    const sourceDir = await resolveSkillDir(rawId);
    if (!sourceDir) {
      skipped.push({ id: rawId, reason: 'not-found' });
      logger.warn?.(
        `Claude skills materialization: skill '${rawId}' could not be resolved to an installed directory; skipping.`,
      );
      await fs.rmRecursive(claimPath).catch(() => {});
      continue;
    }

    try {
      const { files, dirs } = await materializeSkillTree(
        sourceDir,
        realSkillsRoot,
        rawId,
        fs,
      );
      manifest.skills[rawId] = {
        files,
        dirs,
        materializedAt: new Date().toISOString(),
      };
      manifestDirty = true;
      materialized.push(rawId);
    } catch (error) {
      // We claimed `claimPath` exclusively in THIS call — safe to remove it
      // entirely on failure; nothing else could legitimately be in it yet.
      await fs.rmRecursive(claimPath).catch(() => {});
      const reason: SkillMaterializationSkipReason =
        error instanceof SymlinkEncounteredError
          ? 'symlink-in-source'
          : error instanceof ContainmentViolationError
            ? 'containment-violation'
            : 'copy-failed';
      skipped.push({
        id: rawId,
        reason,
        detail: error instanceof Error ? error.message : String(error),
      });
      logger.warn?.(
        reason === 'symlink-in-source'
          ? `Claude skills materialization: skill '${rawId}' contains a symlink; real copies only, skipping.`
          : `Claude skills materialization: failed to copy skill '${rawId}' from '${sourceDir}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (manifestDirty) {
    await writeManifest(manifestPath, manifest, fs);
  }

  return { materialized, skipped };
}

export interface CleanupMaterializedSkillsInput {
  cwd: string;
  /** This session's own identity — cleans exactly this session's own manifest, never another session's. */
  sessionId: string;
  /** Same global-config refusal guard as `materializeSkills` (channel-policy symmetry) — never even reads a manifest out of a global config dir. */
  globalConfigDirs?: string[];
  logger?: MaterializationLogger;
  fs?: SkillMaterializationFsPort;
}

export interface CleanupMaterializedSkillsResult {
  /** Skill ids fully removed (every tracked file matched and was deleted; tracked-only empty dirs pruned). */
  removedSkillIds: string[];
  /** Skill ids left in place because at least one tracked file no longer matched its recorded identity/hash — logged, not deleted. */
  retainedSkillIds: string[];
}

/**
 * Removes THIS session's own manifest-listed materialized skills whose
 * files still match what Station wrote, then prunes the tracked-only empty
 * directories left behind. Safe to call unconditionally and best-effort:
 * with no manifest present this is a true no-op.
 */
export async function cleanupMaterializedSkills(
  input: CleanupMaterializedSkillsInput,
): Promise<CleanupMaterializedSkillsResult> {
  const {
    cwd,
    sessionId,
    globalConfigDirs,
    logger = console,
    fs = defaultFsPort(),
  } = input;

  if (!isSafeToolServerId(sessionId)) {
    logger.warn?.(
      `Claude skills materialization cleanup: session id '${sessionId}' is not filesystem-safe; refusing to touch anything for it.`,
    );
    return { removedSkillIds: [], retainedSkillIds: [] };
  }

  if (await isGlobalConfigTarget(cwd, globalConfigDirs, fs)) {
    logger.warn?.(
      `Claude skills materialization cleanup: '${cwd}' resolves '.claude' into a global Claude Code config directory; refusing to touch anything for it.`,
    );
    return { removedSkillIds: [], retainedSkillIds: [] };
  }

  const skillsRootPath = skillsRootFor(cwd);
  const rootStat = await fs.lstat(skillsRootPath);
  if (!rootStat) return { removedSkillIds: [], retainedSkillIds: [] };
  if (rootStat.isSymbolicLink || !rootStat.isDirectory) {
    logger.warn?.(
      `Claude skills materialization cleanup: '${skillsRootPath}' is not a real, non-symlink directory; refusing to touch it.`,
    );
    return { removedSkillIds: [], retainedSkillIds: [] };
  }
  const realSkillsRoot = await fs.realpath(skillsRootPath);
  if (!realSkillsRoot) return { removedSkillIds: [], retainedSkillIds: [] };

  const manifestPath = manifestPathFor(cwd, sessionId);
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat) return { removedSkillIds: [], retainedSkillIds: [] };

  const manifest = await readManifestOrQuarantine(
    manifestPath,
    sessionId,
    fs,
    logger,
  );
  const removedSkillIds: string[] = [];
  const retainedSkillIds: string[] = [];
  const remainingSkills: StationMaterializedManifest['skills'] = {};

  for (const [skillId, entry] of Object.entries(manifest.skills)) {
    const { remainingFiles } = await cleanupSkillFilesSafely(
      realSkillsRoot,
      skillId,
      entry.files,
      fs,
      logger,
    );
    if (remainingFiles.length === 0) {
      await pruneTrackedDirs(realSkillsRoot, skillId, entry.dirs, fs);
      removedSkillIds.push(skillId);
    } else {
      retainedSkillIds.push(skillId);
      remainingSkills[skillId] = { ...entry, files: remainingFiles };
      logger.warn?.(
        `Claude skills materialization cleanup: kept '${skillId}' — ${remainingFiles.length} file(s) no longer match what Station wrote (user-modified or swapped); not deleting.`,
      );
    }
  }

  if (Object.keys(remainingSkills).length > 0) {
    await writeManifest(
      manifestPath,
      { version: MANIFEST_VERSION, sessionId, skills: remainingSkills },
      fs,
    );
  } else {
    try {
      await fs.unlink(manifestPath);
    } catch {
      // Best-effort — a missing/already-removed manifest is not an error.
    }
  }
  // Best-effort only: succeeds solely when truly empty, so other sessions'
  // still-live directories (or manifests) in the same `.claude/skills/`
  // safely keep this a no-op.
  await fs.rmdirIfEmpty(skillsRootPath);

  return { removedSkillIds, retainedSkillIds };
}

export interface SweepStaleManifestsInput {
  cwd: string;
  /** `true` for a session id that must never be swept — the caller's live session set PLUS its own about-to-start session id. */
  isLiveSessionId: (sessionId: string) => boolean;
  /** Only sweep a manifest whose newest `materializedAt` is at least this old. Defaults to 5 minutes — a grace window for two sessions racing to start in the same `cwd`. */
  staleAfterMs?: number;
  /** Same global-config refusal guard as `materializeSkills` (channel-policy symmetry) — never even reads a manifest out of a global config dir. */
  globalConfigDirs?: string[];
  logger?: MaterializationLogger;
  fs?: SkillMaterializationFsPort;
  now?: () => number;
}

export interface SweepStaleManifestsResult {
  swept: Array<{ sessionId: string; result: CleanupMaterializedSkillsResult }>;
  skippedLive: string[];
  skippedRecent: string[];
}

/**
 * Crash-safety sweep: best-effort at the start of a new session, over every
 * OTHER session's manifest file found in `<cwd>/.claude/skills/`. Never
 * touches a live session's manifest (per `isLiveSessionId`) or one whose
 * newest `materializedAt` is inside the grace window — both guard the exact
 * "two sessions starting in the same cwd at once" race.
 */
export async function sweepStaleManifests(
  input: SweepStaleManifestsInput,
): Promise<SweepStaleManifestsResult> {
  const {
    cwd,
    isLiveSessionId,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    globalConfigDirs,
    logger = console,
    fs = defaultFsPort(),
    now = () => Date.now(),
  } = input;

  const swept: SweepStaleManifestsResult['swept'] = [];
  const skippedLive: string[] = [];
  const skippedRecent: string[] = [];

  if (await isGlobalConfigTarget(cwd, globalConfigDirs, fs)) {
    logger.warn?.(
      `Claude skills materialization sweep: '${cwd}' resolves '.claude' into a global Claude Code config directory; refusing to sweep anything for it.`,
    );
    return { swept, skippedLive, skippedRecent };
  }

  const skillsRootPath = skillsRootFor(cwd);
  const rootStat = await fs.lstat(skillsRootPath);
  if (!rootStat || rootStat.isSymbolicLink || !rootStat.isDirectory) {
    return { swept, skippedLive, skippedRecent };
  }

  let entries: SkillMaterializationDirEntry[];
  try {
    entries = await fs.readdir(skillsRootPath);
  } catch {
    return { swept, skippedLive, skippedRecent };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = MANIFEST_ID_PATTERN.exec(entry.name);
    if (!match) continue;
    const sessionId = match[1];
    if (isLiveSessionId(sessionId)) {
      skippedLive.push(sessionId);
      continue;
    }

    const manifestPath = join(skillsRootPath, entry.name);
    const manifest = await readManifestOrQuarantine(
      manifestPath,
      sessionId,
      fs,
      logger,
    );
    const newestMs = Object.values(manifest.skills).reduce(
      (acc, skillEntry) => {
        const parsed = Date.parse(skillEntry.materializedAt);
        return Number.isFinite(parsed) ? Math.max(acc, parsed) : acc;
      },
      0,
    );
    if (newestMs > 0 && now() - newestMs < staleAfterMs) {
      skippedRecent.push(sessionId);
      continue;
    }

    const result = await cleanupMaterializedSkills({
      cwd,
      sessionId,
      logger,
      fs,
    });
    swept.push({ sessionId, result });
  }

  return { swept, skippedLive, skippedRecent };
}
