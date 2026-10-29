/**
 * #2494: a macOS Seatbelt (`sandbox-exec`) profile Station applies around an
 * engine process, as an `os-profile` confinement provider. See
 * docs/design/approval-posture-server-ordered.md#410-confinement-providers-2494.
 *
 * The profile reads broadly and writes narrowly: on macOS 26 a profile that
 * allows reads only from system paths aborts even `/usr/bin/true`, so every
 * read is allowed except the operator's secret stores and Station's own
 * data, and every write is denied except the workspace, the git subset a
 * worktree needs, and Station-owned temp and configuration directories.
 *
 * What it does not do: it does not hide arbitrary operator files (reads are
 * broad; `container` is the level that does), and it does not stop Apple
 * Events to unconfined applications or attacks on the operator's other
 * processes through broadly allowed Mach services. Its network is open.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { lstat } from 'node:fs/promises';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type {
  ConfinementPosture,
  ConfinementWriteGrant,
} from '@kontourai/station-contracts/execution-confinement';
import { PROVIDER_CLAUDE } from '@kontourai/station-contracts/provider';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import {
  locateGitDirectories,
  readSmallRegularFile,
} from '../../services/projects/git-directory-confinement.js';
import { resolveHomeDir } from '../../utils/paths.js';
import type {
  ConfinementAvailability,
  ConfinementProvider,
  ConfinementSpawnSpec,
} from './confinement-provider.js';

/** The macOS tool that applies a Seatbelt profile and then execs a command. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The symlink-resolved path, resolving the nearest existing ancestor. */
export function canonicalPath(path: string): string {
  const trailing: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = realpathSync(current);
      return trailing.length > 0 ? join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      trailing.push(basename(current));
      current = parent;
    }
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function strictlyWithin(root: string, path: string): boolean {
  return path !== root && within(root, path);
}

/** A worktree's git layout, as git's own pointer files name it. */
export interface SeatbeltGitLayout {
  /** The workspace's git directory, symlink-resolved. */
  gitDir: string;
  /** The repository's common directory, symlink-resolved. */
  commonDir: string;
  /** The branch HEAD names, absent when it is detached or unreadable. */
  branch?: string;
}

const MAX_HEAD_BYTES = 4096;

/** A control character, a quote or a backslash: nothing SBPL can spell. */
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || character === '"' || character === '\\')
      return true;
  }
  return false;
}

/** A branch name that maps to exactly one loose ref file under refs/heads. */
function safeBranch(name: string): boolean {
  return (
    name.length > 0 &&
    !hasUnsafeCharacter(name) &&
    name
      .split('/')
      .every(
        (segment) =>
          segment.length > 0 &&
          !segment.startsWith('.') &&
          !segment.endsWith('.lock'),
      )
  );
}

/**
 * The git layout of `workspace`'s own `.git` entry, read from git's pointer
 * files (`locateGitDirectories`), never by running git in it. `undefined`
 * when the workspace has no `.git` of its own.
 */
export async function discoverSeatbeltGitLayout(
  workspace: string,
): Promise<SeatbeltGitLayout | undefined> {
  const dotGit = join(workspace, '.git');
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(dotGit, { bigint: true });
  } catch {
    return undefined;
  }
  const located = await locateGitDirectories(workspace, dotGit, stats);
  if (!located) return undefined;
  let branch: string | undefined;
  try {
    const head = await readSmallRegularFile(
      join(located.gitDir, 'HEAD'),
      MAX_HEAD_BYTES,
    );
    const named = /^ref: refs\/heads\/([^\r\n]+)\r?\n?$/.exec(
      head?.toString('utf8') ?? '',
    );
    if (named && safeBranch(named[1]!)) branch = named[1];
  } catch {
    branch = undefined;
  }
  return { ...located, ...(branch ? { branch } : {}) };
}

/**
 * The operator's secret stores and Station's own data, unreadable from the
 * profile: credentials Station's own guards treat as secrets
 * (`git-guards.ts`), the engines' global credential files, the login
 * Keychain (a confined engine never reads the operator's Keychain login),
 * and Station's root and runtime home. `readable` re-opens Station's
 * installed binaries inside the root.
 */
export function seatbeltHiddenPaths(
  options: { home?: string; stationRoot?: string; stationHome?: string } = {},
): { hidden: string[]; readable: string[] } {
  const home = options.home ?? homedir();
  const stationRoot = options.stationRoot ?? resolveStationRoot();
  const stationHome = options.stationHome ?? resolveHomeDir();
  const fromHome = [
    '.ssh',
    '.aws',
    '.gnupg',
    '.kube',
    '.azure',
    join('.config', 'gh'),
    join('.config', 'gcloud'),
    join('Library', 'Keychains'),
    '.netrc',
    '.git-credentials',
    '.npmrc',
    '.pypirc',
    join('.docker', 'config.json'),
    '.claude.json',
    join('.claude', '.credentials.json'),
    join('.codex', 'auth.json'),
  ].map((entry) => join(home, entry));
  return {
    hidden: [...fromHome, stationRoot, stationHome].map(canonicalPath),
    readable: [canonicalPath(join(stationRoot, 'installs'))],
  };
}

/**
 * #3800: the engines' project configuration directories, write-denied at
 * every depth of every writable grant. Codex merges each `.codex` from the
 * project root down to the session's cwd over the user's configuration
 * (writable roots, MCP server commands and approval reviewer included), and
 * a session may start in a subdirectory, so a nested one is as live as the
 * root one. Claude reads `.claude/settings.json` and `settings.local.json`
 * (hooks, MCP approvals) and agents and commands that carry hooks of their
 * own. Denying the name, not its files, also refuses creating, renaming,
 * linking or replacing such a directory, and a directory prepared in the
 * session's temp directory cannot carry one either, because that grant is
 * covered too.
 */
const SEATBELT_ENGINE_CONFIG_NAMES: readonly string[] = ['.codex', '.claude'];

export interface SeatbeltGrantInput {
  /** Every path symlink-resolved. */
  workspace: string;
  stationTempDir: string;
  stationConfigDir: string;
  git?: SeatbeltGitLayout;
  hidden: readonly string[];
  readable: readonly string[];
}

/**
 * The write and read grants of a confined start. Git reads configuration,
 * hooks and redirects from its directories, and the operator's unconfined
 * git later runs in the same checkout, so every such file stays read-only:
 *
 * - Always: the repository's `hooks`, `config`, `info`, a `commondir` (in a
 *   main `.git` it would redirect the repository), `objects/info/alternates`,
 *   and the worktree's `config.worktree`.
 * - A linked worktree may write its own git directory, the shared object
 *   store, and only its own branch's ref, lock and log. Its `.git` pointer
 *   file and its git directory's `commondir` and `gitdir` (each could be
 *   repointed at a directory carrying a `config` with `core.fsmonitor` or
 *   `core.hooksPath`), and a `config` or `hooks` there, stay read-only.
 * - A checkout whose `.git` is inside the workspace keeps, besides the
 *   above, every other worktree's and submodule's pointers and config
 *   (`worktrees`, `modules`) read-only, and the `.git` directory itself
 *   cannot be removed, renamed or replaced by a pointer file. Its
 *   remote-tracking refs (`refs/remotes`, `packed-refs`) are read-only too
 *   (#3800): a Codex start trusts a nested `.codex` only by them, so `git
 *   fetch`, `pull` and ref packing are refused there, as in a linked
 *   worktree.
 * - Always (#3800): the engines' project configuration directories, at any
 *   depth (`SEATBELT_ENGINE_CONFIG_NAMES`). A confined agent that could
 *   write one could widen the next Codex session's sandbox, or plant hooks
 *   and MCP servers that the next session there runs outside it.
 */
export function seatbeltGrants(
  input: SeatbeltGrantInput,
): ConfinementSpawnSpec['grants'] {
  const writable = [
    input.workspace,
    input.stationTempDir,
    input.stationConfigDir,
  ];
  const writableFiles: string[] = [];
  const writeDenied: string[] = [];
  const writeDeniedExact: string[] = [];
  const git = input.git;
  if (git) {
    const common = git.commonDir;
    writeDenied.push(
      join(common, 'hooks'),
      join(common, 'config'),
      join(common, 'info'),
      join(common, 'commondir'),
      join(common, 'objects', 'info', 'alternates'),
      join(git.gitDir, 'config.worktree'),
    );
    if (within(input.workspace, common)) {
      // #3800: remote-tracking refs are what a later Codex start trusts a
      // nested `.codex` by, so a confined session may not write them, here
      // or packed (a linked worktree never could).
      writeDenied.push(
        join(common, 'worktrees'),
        join(common, 'modules'),
        join(common, 'refs', 'remotes'),
        join(common, 'packed-refs'),
        join(common, 'packed-refs.lock'),
      );
      writeDeniedExact.push(common, join(common, 'refs'));
    } else {
      writeDenied.push(
        join(input.workspace, '.git'),
        join(git.gitDir, 'commondir'),
        join(git.gitDir, 'gitdir'),
        join(git.gitDir, 'config'),
        join(git.gitDir, 'hooks'),
      );
      writable.push(git.gitDir, join(common, 'objects'));
      if (git.branch) {
        const ref = join(common, 'refs', 'heads', git.branch);
        writableFiles.push(
          ref,
          `${ref}.lock`,
          join(common, 'logs', 'refs', 'heads', git.branch),
        );
      }
    }
  }
  return {
    writable,
    writableFiles,
    writeDenied,
    writeDeniedExact,
    writeDeniedNames: [...SEATBELT_ENGINE_CONFIG_NAMES],
    hidden: [...input.hidden],
    readable: [...input.readable],
  };
}

/** A path as an SBPL string literal; a path it cannot spell safely is refused. */
function sbplPath(path: string): string {
  if (!isAbsolute(path) || hasUnsafeCharacter(path))
    throw new Error(
      'A confinement path is not absolute or contains a character the Seatbelt profile cannot express.',
    );
  return `"${path}"`;
}

/**
 * A rule denying writes to every path under `root` that has a segment named
 * `name`, as an SBPL regex. The name is matched case-insensitively, as the
 * default macOS filesystem resolves it; a name or root it cannot spell
 * safely is refused.
 */
function sbplNamedSegmentDeny(root: string, name: string): string {
  sbplPath(root);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..')
    throw new Error(
      'A confinement directory name contains a character the Seatbelt profile cannot express.',
    );
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const caseless = [...name]
    .map((character) =>
      /[A-Za-z]/.test(character)
        ? `[${character.toUpperCase()}${character.toLowerCase()}]`
        : literal(character),
    )
    .join('');
  return `(deny file-write* (regex #"^${literal(root)}/(.*/)?${caseless}(/|$)"))`;
}

/**
 * The Seatbelt profile for `grants`. Later rules win in SBPL, so the order
 * is load-bearing: deny everything, allow the broad base, hide the secret
 * stores, re-open the readable and writable grants, and finally deny the
 * writes no grant may cover.
 */
export function seatbeltProfile(
  grants: ConfinementSpawnSpec['grants'],
): string {
  const rule = (
    action: 'allow' | 'deny',
    operations: string,
    filter: 'subpath' | 'literal',
    paths: readonly string[] | undefined,
  ) =>
    (paths ?? []).map(
      (path) => `(${action} ${operations} (${filter} ${sbplPath(path)}))`,
    );
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    // Signals only to processes inside this sandbox (its own children).
    '(allow signal (target same-sandbox))',
    '(allow file-read*)',
    '(allow mach*)',
    '(allow sysctl*)',
    '(allow ipc*)',
    '(allow network*)',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper"))',
    ...rule('deny', 'file-read*', 'subpath', grants.hidden),
    ...rule('allow', 'file-read*', 'subpath', grants.readable),
    ...rule('allow', 'file-read* file-write*', 'subpath', grants.writable),
    ...rule('allow', 'file-read* file-write*', 'literal', grants.writableFiles),
    ...rule('deny', 'file-write*', 'subpath', grants.writeDenied),
    ...rule('deny', 'file-write*', 'literal', grants.writeDeniedExact),
    ...grants.writable.flatMap((root) =>
      (grants.writeDeniedNames ?? []).map((name) =>
        sbplNamedSegmentDeny(root, name),
      ),
    ),
  ].join('\n');
}

/**
 * What a confined start's grants are held to, derived independently of the
 * grant builder: the workspace, Station's runtime home (whose `tmp` and
 * `app-homes` hold the session's temp and configuration directories), and
 * the workspace's git layout.
 */
export interface SeatbeltBounds {
  workspace: string;
  stationHome: string;
  home: string;
  git?: SeatbeltGitLayout;
}

/** Where a confined session's temp directory lives, under Station's home. */
export function seatbeltTempRoot(stationHome: string): string {
  return join(stationHome, 'tmp', 'confined-sessions');
}

/**
 * Where confined engines' Station-owned configuration homes live: a root of
 * their own, never `app-homes`, which unconfined spawns (the app-home
 * opt-in, credential profiles) use. A file planted in a confined home (a
 * `settings.json` hook) therefore never reaches an unconfined session.
 */
export function seatbeltConfigRoot(stationHome: string): string {
  return join(stationHome, 'confined-homes');
}

/** A confined session's temp directory name: `session-<owner pid>-<random>`. */
const SESSION_DIR = /^session-(\d+)-[A-Za-z0-9]{6}$/;

/** The prefix `mkdtemp` completes for a session owned by `pid`. */
export function seatbeltSessionDirPrefix(pid: number = process.pid): string {
  return `session-${pid}-`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Removes confined sessions' temp directories whose owner process is gone
 * (a crash or a kill skipped their cleanup). An entry is removed only when
 * ownership is proven: it is a real directory (not a link) directly in
 * Station's confined-session root, owned by this user, named
 * `session-<pid>-<random>`, and no process `pid` exists. A live owner, this
 * process included, keeps its directory: its sessions remove their own on
 * stop. Best-effort: an entry that cannot be read or removed is skipped.
 */
export function reapStaleSeatbeltSessionDirs(
  stationHome: string,
  deps: {
    isAlive?: (pid: number) => boolean;
    uid?: number | undefined;
  } = {},
): number {
  const root = seatbeltTempRoot(canonicalPath(stationHome));
  let entries: string[];
  try {
    if (realpathSync(root) !== root) return 0;
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  const isAlive = deps.isAlive ?? processAlive;
  const uid = 'uid' in deps ? deps.uid : process.getuid?.();
  let reaped = 0;
  for (const entry of entries) {
    const owner = SESSION_DIR.exec(entry);
    if (!owner) continue;
    const pid = Number(owner[1]);
    const path = join(root, entry);
    try {
      const stats = lstatSync(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      if (uid !== undefined && stats.uid !== uid) continue;
      if (pid === process.pid || isAlive(pid)) continue;
      rmSync(path, { recursive: true, force: true });
      reaped += 1;
    } catch {
      // Best-effort.
    }
  }
  return reaped;
}

/**
 * Why `workspace` cannot be a confined write grant, or `undefined` when it
 * can: a workspace that is or contains the home folder or Station's data,
 * or sits in a hidden folder or `~/Library`, would let confined code plant
 * something the operator's unconfined sessions run.
 */
export function seatbeltWorkspaceRefusal(
  workspace: string,
  bounds: Pick<SeatbeltBounds, 'home' | 'stationHome'>,
): string | undefined {
  if (workspace === sep) return 'it is the filesystem root';
  if (within(workspace, bounds.home))
    return 'it is or contains the home folder';
  if (
    within(workspace, bounds.stationHome) ||
    within(bounds.stationHome, workspace)
  )
    return "it is or overlaps Station's data";
  if (strictlyWithin(bounds.home, workspace)) {
    const [first = ''] = relative(bounds.home, workspace).split(sep);
    if (first.startsWith('.') || first === 'Library')
      return `it is inside ~${sep}${first}`;
  }
  return undefined;
}

/**
 * The kinds of the writes `grants` allows, or `undefined` when any grant
 * reaches past the workspace, the git subset, the session's Station temp
 * directory and the Station configuration directory, or when a deny the
 * layout needs is missing (slice 1 F3: breadth is part of the posture).
 */
export function seatbeltWriteGrantKinds(
  grants: ConfinementSpawnSpec['grants'],
  bounds: SeatbeltBounds,
): ConfinementWriteGrant[] | undefined {
  if (seatbeltWorkspaceRefusal(bounds.workspace, bounds)) return undefined;
  const deniedNames = new Set(grants.writeDeniedNames ?? []);
  if (!SEATBELT_ENGINE_CONFIG_NAMES.every((name) => deniedNames.has(name)))
    return undefined;
  const kinds = new Set<ConfinementWriteGrant>();
  const git = bounds.git;
  const linked = git && !within(bounds.workspace, git.commonDir);
  for (const path of grants.writable) {
    if (path === bounds.workspace) kinds.add('workspace');
    else if (
      dirname(path) === seatbeltTempRoot(bounds.stationHome) &&
      SESSION_DIR.test(basename(path))
    )
      kinds.add('station-temp');
    else if (dirname(path) === seatbeltConfigRoot(bounds.stationHome))
      kinds.add('station-config');
    else if (
      linked &&
      path === git.gitDir &&
      dirname(path) === join(git.commonDir, 'worktrees')
    )
      kinds.add('git-worktree');
    else if (linked && path === join(git.commonDir, 'objects'))
      kinds.add('git-objects');
    else return undefined;
  }
  for (const path of grants.writableFiles ?? []) {
    if (!linked || !git.branch) return undefined;
    const ref = join(git.commonDir, 'refs', 'heads', git.branch);
    const log = join(git.commonDir, 'logs', 'refs', 'heads', git.branch);
    if (path !== ref && path !== `${ref}.lock` && path !== log)
      return undefined;
    kinds.add('git-branch-ref');
  }
  if (git) {
    const denied = new Set(grants.writeDenied ?? []);
    const needed = [
      join(git.commonDir, 'hooks'),
      join(git.commonDir, 'config'),
      join(git.commonDir, 'info'),
      join(git.commonDir, 'commondir'),
      join(git.commonDir, 'objects', 'info', 'alternates'),
      join(git.gitDir, 'config.worktree'),
      ...(linked
        ? [
            join(bounds.workspace, '.git'),
            join(git.gitDir, 'commondir'),
            join(git.gitDir, 'gitdir'),
            join(git.gitDir, 'config'),
            join(git.gitDir, 'hooks'),
          ]
        : [
            join(git.commonDir, 'worktrees'),
            join(git.commonDir, 'modules'),
            join(git.commonDir, 'refs', 'remotes'),
            join(git.commonDir, 'packed-refs'),
            join(git.commonDir, 'packed-refs.lock'),
          ]),
    ];
    if (!needed.every((path) => denied.has(path))) return undefined;
    if (
      !linked &&
      ![git.commonDir, join(git.commonDir, 'refs')].every((path) =>
        (grants.writeDeniedExact ?? []).includes(path),
      )
    )
      return undefined;
  }
  return [...kinds].sort();
}

/**
 * What the Seatbelt posture is derived from, gathered after the start:
 *
 * - `spawned`: the command and arguments the engine process was actually
 *   spawned with, recorded at the spawn call itself.
 * - `handshake`: whether the engine answered its startup handshake over that
 *   process's stdout. `sandbox-exec` execs the engine only after the profile
 *   applied, so an answer from that process is an answer from inside it.
 * - `bounds`: what the grants are held to.
 */
export interface SeatbeltEvidence {
  spawned: { command: string; args: readonly string[] } | undefined;
  handshake: 'completed' | 'failed';
  bounds: SeatbeltBounds;
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * The posture of a Seatbelt-confined start: `confined` only when the
 * engine was spawned through `sandbox-exec` with exactly this profile and
 * command, answered its handshake, and the grants stay in bounds. Anything
 * else (no spawn recorded, a different command, no answer, a grant past
 * the bounds) is `configured-but-failed`: the mechanism was engaged and is
 * not known to hold.
 */
export function observeSeatbeltPosture(
  confined: Pick<ConfinementSpawnSpec, 'command' | 'args' | 'grants'>,
  evidence: SeatbeltEvidence | undefined,
): ConfinementPosture {
  if (!evidence || evidence.handshake !== 'completed' || !evidence.spawned)
    return 'configured-but-failed';
  if (
    evidence.spawned.command !== confined.command ||
    !sameArgs(evidence.spawned.args, confined.args)
  )
    return 'configured-but-failed';
  return seatbeltWriteGrantKinds(confined.grants, evidence.bounds)
    ? 'confined'
    : 'configured-but-failed';
}

/** `spec` wrapped in `sandbox-exec` with its profile. */
export function confineWithSeatbelt(
  spec: ConfinementSpawnSpec,
  sandboxExec: string = SANDBOX_EXEC,
): ConfinementSpawnSpec {
  if (spec.network !== 'full')
    throw new Error('The Seatbelt profile does not restrict the network.');
  return {
    ...spec,
    command: sandboxExec,
    args: ['-p', seatbeltProfile(spec.grants), spec.command, ...spec.args],
  };
}

/**
 * Whether the production profile applies on this host: the real profile
 * shape (every rule kind, with a linked-worktree layout and the real hidden
 * list) around `/usr/bin/true`, in a throwaway directory.
 */
export function probeSeatbelt(sandboxExec: string = SANDBOX_EXEC): {
  ok: boolean;
  reason: string;
} {
  const root = canonicalPath(mkdtempSync(join(tmpdir(), 'station-seatbelt-')));
  try {
    const workspace = join(root, 'workspace');
    const common = join(root, 'repository.git');
    mkdirSync(workspace);
    const { hidden, readable } = seatbeltHiddenPaths();
    const spec = confineWithSeatbelt(
      {
        command: '/usr/bin/true',
        args: [],
        cwd: workspace,
        env: {},
        grants: seatbeltGrants({
          workspace,
          stationTempDir: join(root, 'tmp'),
          stationConfigDir: join(root, 'config'),
          git: {
            gitDir: join(common, 'worktrees', 'workspace'),
            commonDir: common,
            branch: 'probe',
          },
          hidden,
          readable,
        }),
        network: 'full',
      },
      sandboxExec,
    );
    const result = spawnSync(spec.command, spec.args, {
      cwd: workspace,
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    });
    return result.status === 0
      ? { ok: true, reason: 'the Seatbelt profile applies on this host' }
      : {
          ok: false,
          reason: `the Seatbelt profile did not apply (${result.error?.message ?? `exit ${result.status ?? result.signal}`})`,
        };
  } catch (error) {
    return {
      ok: false,
      reason: `the Seatbelt profile could not be probed (${error instanceof Error ? error.message : String(error)})`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export interface SeatbeltProviderDeps {
  platform?: () => NodeJS.Platform;
  sandboxExec?: string;
  /** Defaults to {@link probeSeatbelt}, run once per provider. */
  probe?: (sandboxExec: string) => { ok: boolean; reason: string };
}

/**
 * Station's Seatbelt profile as a spawn-wrapper `os-profile` provider for
 * Claude: the Claude adapter wraps the engine spawn through `confine` and
 * derives the posture through `pending.observe` once the engine has
 * answered its handshake.
 */
export function createSeatbeltConfinementProvider(
  deps: SeatbeltProviderDeps = {},
): ConfinementProvider<SeatbeltEvidence> {
  const sandboxExec = deps.sandboxExec ?? SANDBOX_EXEC;
  const probe = deps.probe ?? probeSeatbelt;
  let probed: { ok: boolean; reason: string } | undefined;
  return {
    level: 'os-profile',
    mechanism: 'seatbelt',
    workspaceAccess: 'mounted',
    supportedIsolationModes: ['shared', 'worktree'],
    engagement: 'spawn-wrapper',
    engines: [PROVIDER_CLAUDE],
    availability(): ConfinementAvailability {
      const platform = (deps.platform ?? osPlatform)();
      if (platform !== 'darwin')
        return {
          available: false,
          reason: `Seatbelt is macOS-only; this host is ${platform}`,
        };
      try {
        accessSync(sandboxExec, constants.X_OK);
      } catch {
        return {
          available: false,
          reason: `${sandboxExec} is missing or not executable`,
        };
      }
      probed ??= probe(sandboxExec);
      return probed.ok
        ? { available: true, reason: probed.reason }
        : { available: false, reason: probed.reason };
    },
    confine(spec) {
      const confined = confineWithSeatbelt(spec, sandboxExec);
      return {
        spec: confined,
        pending: {
          observe: (evidence) => observeSeatbeltPosture(confined, evidence),
        },
      };
    },
  };
}

/** The process-wide Seatbelt provider the server engages by default. */
export const seatbeltConfinementProvider = createSeatbeltConfinementProvider();
