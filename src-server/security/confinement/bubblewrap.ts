/**
 * #4770: a bubblewrap (`bwrap`) sandbox Station applies around an engine
 * process on Linux, as an `os-profile` confinement provider: the Linux
 * counterpart of the Seatbelt profile (`seatbelt.ts`). See
 * docs/design/approval-posture-server-ordered.md#410-confinement-providers-2494,
 * which also records why bubblewrap and not Landlock.
 *
 * The sandbox mounts the whole filesystem read-only in a new user, mount,
 * PID and IPC namespace, re-mounts the write grants writable, and hides the
 * secret stores and Station's data under empty read-only mounts. Bubblewrap
 * execs the engine only once that is in place.
 *
 * What it cannot do, unlike the Seatbelt profile, because a mount covers a
 * path that exists and nothing else:
 *
 * - Grant one file that git replaces by rename (a branch ref, its lock and
 *   its log): git writes `<ref>.lock` beside the ref and renames it over
 *   the ref, which needs the whole directory. So no git metadata is
 *   writable: the workspace's `.git` (a directory or a linked worktree's
 *   pointer file) stays read-only, and a confined session cannot stage or
 *   commit.
 * - Deny a name at any depth: only an existing `.codex` or `.claude` at the
 *   root of a write grant is read-only. One created anywhere, or an existing
 *   nested one, stays writable.
 * - Hide a secret path that does not exist when the session starts.
 * - Refuse a read: a hidden directory reads as empty and a hidden file as
 *   empty (`/dev/null`), where Seatbelt refuses the read itself.
 *
 * Its network is open (#4769), as Seatbelt's is. Unix sockets outside the
 * hidden paths (an `ssh-agent` socket under `/tmp`, an abstract socket)
 * stay connectable.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  ConfinementPosture,
  ConfinementWriteGrant,
} from '@kontourai/station-contracts/execution-confinement';
import { PROVIDER_CLAUDE } from '@kontourai/station-contracts/provider';
import { errorMessage } from '../../utils/error-message.js';
import { isCanonicalPathWithin } from '../../utils/path-containment.js';
import type {
  ConfinementAvailability,
  ConfinementProvider,
  ConfinementSpawnSpec,
} from './confinement-provider.js';
import {
  canonicalPath,
  isConfinedSessionTempDir,
  type SeatbeltBounds,
  type SeatbeltEvidence,
  type SeatbeltGitLayout,
  seatbeltConfigRoot,
  seatbeltHiddenPaths,
  seatbeltWorkspaceRefusal,
} from './seatbelt.js';

/** Where distributions install bubblewrap. A fixed path: never PATH. */
export const BUBBLEWRAP = '/usr/bin/bwrap';

/**
 * What every Station bubblewrap launch starts with, in this order:
 *
 * - A new user namespace that may not create another (`--disable-userns`),
 *   so the mounts below cannot be rearranged from inside.
 * - A new PID namespace with its own `/proc`: the host's processes, and
 *   `/proc/<pid>/root` (which would reach their unconfined view of the
 *   filesystem), are not visible.
 * - A new IPC namespace, a new session (no terminal to inject input into),
 *   and the sandbox ends with Station's process.
 * - The whole filesystem read-only, then a private `/dev`.
 */
export const BUBBLEWRAP_BASE_ARGS: readonly string[] = [
  '--unshare-user',
  '--unshare-pid',
  '--unshare-ipc',
  '--disable-userns',
  '--die-with-parent',
  '--new-session',
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
];

/** The arguments each bubblewrap option Station emits takes. */
const OPTION_ARITY: Readonly<Record<string, number>> = {
  '--unshare-user': 0,
  '--unshare-pid': 0,
  '--unshare-ipc': 0,
  '--disable-userns': 0,
  '--die-with-parent': 0,
  '--new-session': 0,
  '--dev': 1,
  '--proc': 1,
  '--tmpfs': 1,
  '--remount-ro': 1,
  '--chdir': 1,
  '--bind': 2,
  '--ro-bind': 2,
};

/** The engines' project configuration directory names (#3800). */
const ENGINE_CONFIG_NAMES: readonly string[] = ['.codex', '.claude'];

/**
 * The paths a confined process may not read on Linux: the Seatbelt list
 * (`seatbeltHiddenPaths`), plus the login keyring's files and the user's
 * runtime directory, which holds the session bus (through which the Secret
 * Service hands out unlocked keyring items) and the keyring's SSH agent
 * socket. `readable` re-opens Station's installed binaries.
 */
export function bubblewrapHiddenPaths(
  options: {
    home?: string;
    stationRoot?: string;
    stationHome?: string;
    /** The user's runtime directory; defaults to `/run/user/<uid>`. */
    runtimeDir?: string | null;
  } = {},
): { hidden: string[]; readable: string[] } {
  const home = options.home ?? homedir();
  const base = seatbeltHiddenPaths(options);
  const uid = process.getuid?.();
  const runtimeDir =
    options.runtimeDir === undefined
      ? uid === undefined
        ? null
        : `/run/user/${uid}`
      : options.runtimeDir;
  return {
    hidden: [
      ...base.hidden,
      canonicalPath(join(home, '.local', 'share', 'keyrings')),
      ...(runtimeDir ? [canonicalPath(runtimeDir)] : []),
    ],
    readable: base.readable,
  };
}

export interface BubblewrapGrantInput {
  /** Every path symlink-resolved. */
  workspace: string;
  stationTempDir: string;
  stationConfigDir: string;
  git?: SeatbeltGitLayout;
  hidden: readonly string[];
  readable: readonly string[];
}

/**
 * The write and read grants of a confined start under bubblewrap: the
 * workspace, the session's Station temp directory and the Station-owned
 * configuration directory, with the workspace's own `.git` read-only
 * whenever the workspace has a git layout (its directory, or a linked
 * worktree's pointer file). No other git directory is granted, so the
 * shared repository, its refs and hooks stay read-only too.
 */
export function bubblewrapGrants(
  input: BubblewrapGrantInput,
): ConfinementSpawnSpec['grants'] {
  return {
    writable: [input.workspace, input.stationTempDir, input.stationConfigDir],
    readable: [...input.readable],
    writableFiles: [],
    writeDenied: input.git ? [join(input.workspace, '.git')] : [],
    writeDeniedExact: [],
    writeDeniedNames: [...ENGINE_CONFIG_NAMES],
    hidden: [...input.hidden],
  };
}

function kindOf(path: string): 'directory' | 'other' | undefined {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'other';
  } catch {
    return undefined;
  }
}

function requireAbsolute(path: string): string {
  if (!isAbsolute(path)) throw new Error('A confinement path is not absolute.');
  return path;
}

/** The nearest existing ancestor of an absent `path`. */
function nearestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * The bubblewrap arguments for `spec`, ending in the engine command. Later
 * mounts cover earlier ones, so the order is load-bearing: the read-only
 * root, the hidden paths (an empty read-only directory, or `/dev/null` for a
 * file), the readable and writable grants re-opened inside them, then the
 * writes no grant may cover, and finally the hidden directories made
 * read-only.
 *
 * Refused (it throws) rather than silently narrowed or widened: a grant of a
 * single file, an exact-path deny, a writable grant that does not exist, a
 * denied path that cannot be covered without covering a whole grant, and a
 * network policy other than `full`.
 */
export function bubblewrapArgs(spec: ConfinementSpawnSpec): string[] {
  if (spec.network !== 'full')
    throw new Error('The bubblewrap sandbox does not restrict the network.');
  const grants = spec.grants;
  if ((grants.writableFiles ?? []).length > 0)
    throw new Error(
      'The bubblewrap sandbox cannot grant a single file that git replaces by rename.',
    );
  if ((grants.writeDeniedExact ?? []).length > 0)
    throw new Error(
      'The bubblewrap sandbox cannot deny a path exactly while its contents stay writable.',
    );
  const writable = grants.writable.map(requireAbsolute);
  const args: string[] = [...BUBBLEWRAP_BASE_ARGS];
  const hiddenDirectories: string[] = [];
  const hidden = [...(grants.hidden ?? [])]
    .map(requireAbsolute)
    .sort((left, right) => left.length - right.length);
  for (const path of hidden) {
    if (hiddenDirectories.some((dir) => isCanonicalPathWithin(dir, path)))
      continue;
    const kind = kindOf(path);
    if (kind === 'directory') {
      args.push('--tmpfs', path);
      hiddenDirectories.push(path);
    } else if (kind === 'other') args.push('--ro-bind', '/dev/null', path);
  }
  for (const path of grants.readable.map(requireAbsolute))
    if (kindOf(path)) args.push('--ro-bind', path, path);
  for (const path of writable) {
    if (kindOf(path) !== 'directory')
      throw new Error('A writable confinement grant is not a directory.');
    args.push('--bind', path, path);
  }
  const denied = new Set<string>();
  for (const path of (grants.writeDenied ?? []).map(requireAbsolute)) {
    const target = nearestExisting(path);
    const root = writable.find((grant) => isCanonicalPathWithin(grant, target));
    // Outside every write grant it is read-only already.
    if (!root) continue;
    if (target === root)
      throw new Error(
        'A denied confinement path does not exist and cannot be covered without covering its whole grant.',
      );
    denied.add(target);
  }
  for (const root of writable) {
    const names = new Set(
      (grants.writeDeniedNames ?? []).map((name) => name.toLowerCase()),
    );
    if (names.size === 0) continue;
    // Only a real directory: a link could be replaced by one, which is
    // the creation this cannot deny.
    for (const entry of readdirSync(root))
      if (
        names.has(entry.toLowerCase()) &&
        lstatSync(join(root, entry)).isDirectory()
      )
        denied.add(join(root, entry));
  }
  for (const path of denied) args.push('--ro-bind', path, path);
  for (const path of hiddenDirectories) args.push('--remount-ro', path);
  args.push('--chdir', requireAbsolute(spec.cwd), '--', spec.command);
  args.push(...spec.args);
  return args;
}

/** `spec` wrapped in bubblewrap. */
export function confineWithBubblewrap(
  spec: ConfinementSpawnSpec,
  bwrap: string = BUBBLEWRAP,
): ConfinementSpawnSpec {
  return { ...spec, command: bwrap, args: bubblewrapArgs(spec) };
}

type MountOperation = { option: string; values: string[] };

/** The options before `--`, or `undefined` for an option Station never emits. */
function parseOptions(args: readonly string[]): MountOperation[] | undefined {
  const operations: MountOperation[] = [];
  let index = 0;
  while (index < args.length && args[index] !== '--') {
    const option = args[index]!;
    const arity = Object.hasOwn(OPTION_ARITY, option)
      ? OPTION_ARITY[option]!
      : undefined;
    if (arity === undefined || index + arity >= args.length) return undefined;
    operations.push({
      option,
      values: args.slice(index + 1, index + 1 + arity),
    });
    index += 1 + arity;
  }
  return index < args.length ? operations : undefined;
}

/**
 * The kinds of the writes the bubblewrap arguments `args` allow, read from
 * the arguments themselves (what was applied, not what was asked), or
 * `undefined` when they do not start with {@link BUBBLEWRAP_BASE_ARGS}, use
 * an option Station never emits, mount anything writable past the
 * workspace, the session's Station temp directory and a directory directly
 * under Station's confined homes, or leave the workspace's `.git` writable
 * while it has a git layout.
 */
export function bubblewrapWriteGrantKinds(
  args: readonly string[],
  bounds: SeatbeltBounds,
): ConfinementWriteGrant[] | undefined {
  if (seatbeltWorkspaceRefusal(bounds.workspace, bounds)) return undefined;
  if (!BUBBLEWRAP_BASE_ARGS.every((value, index) => args[index] === value))
    return undefined;
  const operations = parseOptions(args);
  if (!operations) return undefined;
  const kinds = new Set<ConfinementWriteGrant>();
  let workspaceAt = -1;
  for (const [index, { option, values }] of operations.entries()) {
    if (option !== '--bind') continue;
    const [source, target] = values as [string, string];
    if (source !== target) return undefined;
    if (target === bounds.workspace) {
      kinds.add('workspace');
      workspaceAt = index;
    } else if (isConfinedSessionTempDir(target, bounds.stationHome))
      kinds.add('station-temp');
    else if (dirname(target) === seatbeltConfigRoot(bounds.stationHome))
      kinds.add('station-config');
    else return undefined;
  }
  if (bounds.git) {
    const dotGit = join(bounds.workspace, '.git');
    const covered = operations.some(
      ({ option, values }, index) =>
        option === '--ro-bind' &&
        values[0] === dotGit &&
        values[1] === dotGit &&
        index > workspaceAt,
    );
    if (!covered) return undefined;
  }
  return [...kinds].sort();
}

/**
 * The posture of a bubblewrap-confined start: `confined` only when the
 * engine was spawned through bubblewrap with exactly these arguments,
 * answered its handshake over that process's stdout (bubblewrap execs it
 * only after the sandbox is in place), and the arguments it was spawned with
 * keep every write in bounds. Anything else is `configured-but-failed`.
 */
export function observeBubblewrapPosture(
  confined: Pick<ConfinementSpawnSpec, 'command' | 'args'>,
  evidence: SeatbeltEvidence | undefined,
): ConfinementPosture {
  if (!evidence || evidence.handshake !== 'completed' || !evidence.spawned)
    return 'configured-but-failed';
  const spawned = evidence.spawned;
  if (
    spawned.command !== confined.command ||
    spawned.args.length !== confined.args.length ||
    !spawned.args.every((value, index) => value === confined.args[index])
  )
    return 'configured-but-failed';
  return bubblewrapWriteGrantKinds(spawned.args, evidence.bounds)
    ? 'confined'
    : 'configured-but-failed';
}

/** What a failed probe script's exit status means. */
const PROBE_FAILURES: Readonly<Record<number, string>> = {
  3: 'a write outside the workspace was not refused',
  4: 'a write inside the workspace was refused',
  5: "a hidden file's content was readable",
  6: "the workspace's .git was writable",
};

/**
 * Whether the production sandbox applies AND enforces on this host: the
 * real argument shape (the real hidden list, a linked worktree's pointer
 * file, an engine configuration directory) around `/bin/sh` in a throwaway
 * directory, which must be able to write the workspace and must be refused
 * a write outside it, the content of a hidden directory's file and of a
 * hidden file, and a write to `.git`. A host
 * without unprivileged user namespaces (a kernel setting, AppArmor's
 * `apparmor_restrict_unprivileged_userns`, a container's seccomp profile)
 * fails here, with bubblewrap's own reason.
 */
export function probeBubblewrap(bwrap: string = BUBBLEWRAP): {
  ok: boolean;
  reason: string;
} {
  let root: string | undefined;
  try {
    root = canonicalPath(mkdtempSync(join(tmpdir(), 'station-bubblewrap-')));
    const workspace = join(root, 'workspace');
    const secret = join(root, 'secret');
    const common = join(root, 'repository.git');
    for (const dir of [
      join(workspace, '.claude'),
      join(root, 'tmp'),
      join(root, 'config'),
      secret,
    ])
      mkdirSync(dir, { recursive: true });
    const pointer = `gitdir: ${join(common, 'worktrees', 'workspace')}\n`;
    writeFileSync(join(workspace, '.git'), pointer);
    writeFileSync(join(secret, 'key'), 'probe\n');
    const secretFile = join(root, 'secret-file');
    writeFileSync(secretFile, 'probe\n');
    const { hidden, readable } = bubblewrapHiddenPaths();
    const outside = join(root, 'outside');
    const inside = join(workspace, 'inside');
    const args = bubblewrapArgs({
      command: '/bin/sh',
      args: [
        '-c',
        // Each write runs in a subshell: a failed redirection of a special
        // built-in (`:`) would end the whole script instead of failing.
        [
          'if (echo probe > "$1") 2>/dev/null; then exit 3; fi',
          '(echo probe > "$2") || exit 4',
          'if grep -q probe "$3" 2>/dev/null; then exit 5; fi',
          'if grep -q probe "$5" 2>/dev/null; then exit 5; fi',
          'if (echo probe > "$4") 2>/dev/null; then exit 6; fi',
          'exit 0',
        ].join('\n'),
        'probe',
        outside,
        inside,
        join(secret, 'key'),
        join(workspace, '.git'),
        secretFile,
      ],
      cwd: workspace,
      env: {},
      grants: bubblewrapGrants({
        workspace,
        stationTempDir: join(root, 'tmp'),
        stationConfigDir: join(root, 'config'),
        git: {
          gitDir: join(common, 'worktrees', 'workspace'),
          commonDir: common,
        },
        hidden: [...hidden, secret, secretFile],
        readable,
      }),
      network: 'full',
    });
    const result = spawnSync(bwrap, args, {
      cwd: workspace,
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    const enforced =
      result.status === 0 &&
      !existsSync(outside) &&
      existsSync(inside) &&
      readFileSync(join(workspace, '.git'), 'utf8') === pointer;
    if (enforced)
      return {
        ok: true,
        reason: 'the bubblewrap sandbox applies and enforces on this host',
      };
    const said = (result.stderr ?? '').trim().split('\n').pop()?.slice(0, 300);
    const detail =
      result.error?.message ??
      (result.status !== null && PROBE_FAILURES[result.status]) ??
      (said || `exit ${result.status ?? result.signal}`);
    return {
      ok: false,
      reason: `the bubblewrap sandbox did not apply (${detail})`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `the bubblewrap sandbox could not be probed (${errorMessage(error)})`,
    };
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

export interface BubblewrapProviderDeps {
  platform?: () => NodeJS.Platform;
  bwrap?: string;
  /** Defaults to {@link probeBubblewrap}, run once per provider. */
  probe?: (bwrap: string) => { ok: boolean; reason: string };
}

/**
 * Station's bubblewrap sandbox as a spawn-wrapper `os-profile` provider for
 * Claude on Linux: the Claude adapter wraps the engine spawn through
 * `confine` and derives the posture through `pending.observe` once the
 * engine has answered its handshake, exactly as for Seatbelt.
 */
export function createBubblewrapConfinementProvider(
  deps: BubblewrapProviderDeps = {},
): ConfinementProvider<SeatbeltEvidence> {
  const bwrap = deps.bwrap ?? BUBBLEWRAP;
  const probe = deps.probe ?? probeBubblewrap;
  let probed: { ok: boolean; reason: string } | undefined;
  return {
    level: 'os-profile',
    mechanism: 'bubblewrap',
    workspaceAccess: 'mounted',
    supportedIsolationModes: ['shared', 'worktree'],
    engagement: 'spawn-wrapper',
    engines: [PROVIDER_CLAUDE],
    availability(): ConfinementAvailability {
      const platform = (deps.platform ?? osPlatform)();
      if (platform !== 'linux')
        return {
          available: false,
          reason: `bubblewrap is Linux-only; this host is ${platform}`,
        };
      try {
        accessSync(bwrap, constants.X_OK);
      } catch {
        return {
          available: false,
          reason: `${bwrap} is missing or not executable (install the bubblewrap package)`,
        };
      }
      probed ??= probe(bwrap);
      return probed.ok
        ? { available: true, reason: probed.reason }
        : { available: false, reason: probed.reason };
    },
    confine(spec) {
      const confined = confineWithBubblewrap(spec, bwrap);
      return {
        spec: confined,
        pending: {
          observe: (evidence) => observeBubblewrapPosture(confined, evidence),
        },
      };
    },
  };
}

/** The process-wide bubblewrap provider the server engages by default. */
export const bubblewrapConfinementProvider =
  createBubblewrapConfinementProvider();
