/**
 * How far a Project's checkout is behind its upstream
 * (`@kontourai/station-contracts/project-checkout-freshness`).
 *
 * Local refs only: nothing here fetches, so the answer is "as of the last
 * fetch", and that fetch's time is reported beside it. Every git call runs
 * through {@link readProjectRepository}, because a Project's folder is
 * member-writable and the repository git would discover there is not
 * trusted on its own. The files read directly (the fetch records' times and
 * the tail of the upstream ref's reflog) are read only when no component of
 * their path below the resolved git directory is a link, and nothing read
 * from them reaches git unless it is a bare object id.
 *
 * Facts are remembered per directory for {@link FRESHNESS_TTL_MS}, and
 * callers that arrive while a read is running join it, so a settings page
 * and an agent's `get_project` cost one read between them. A read that could
 * not complete is not remembered. Thresholds are applied per call, so a
 * changed setting applies at once.
 */
import { type BigIntStats, constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  PROJECT_CHECKOUT_FRESHNESS_VERSION,
  type ProjectCheckoutFacts,
  type ProjectCheckoutFreshness,
  type ProjectCheckoutStaleThresholds,
  type ProjectCheckoutUnknownReason,
  projectCheckoutStaleReasons,
} from '@kontourai/station-contracts/project-checkout-freshness';
import { errorMessage } from '../../utils/error-message.js';
import { execGit } from '../../utils/git-exec.js';
import { createLogger } from '../../utils/logger.js';
import { expandTilde } from '../../utils/paths.js';
import {
  type ReadRepository,
  readProjectRepository,
} from './git-read-repository.js';

const logger = createLogger({ name: 'project-checkout-freshness' });

/**
 * How long a read's facts are reused. Short, so a warning clears soon after
 * the person pulls.
 */
const FRESHNESS_TTL_MS = 10_000;
/** Directories remembered at once; the oldest is forgotten first. */
const MAX_REMEMBERED = 256;
/** Each git call is a local ref read; this only bounds a wedged mount. */
const GIT_TIMEOUT_MS = 5_000;
/** The newest reflog entries examined; enough for months of fetches. */
const REFLOG_TAIL_BYTES = 64 * 1024;
/** A FETCH_HEAD larger than this is read from its end only. */
const FETCH_HEAD_BYTES = 1024 * 1024;
/**
 * A whole observation, file system included: a wedged mount can hold a
 * `realpath` or `lstat` that no git timeout bounds.
 */
const OBSERVATION_DEADLINE_MS = 15_000;
const MAX_REFLOG_ENTRIES = 32;

type Observation =
  | { kind: 'known'; facts: ProjectCheckoutFacts; at: Date }
  | { kind: 'unknown'; reason: ProjectCheckoutUnknownReason; at: Date };

/** git exited with a status; a killed (timed-out) call has none. */
function exitCode(error: unknown): number | undefined {
  const failure = error as { code?: unknown; killed?: unknown };
  return failure?.killed !== true && typeof failure?.code === 'number'
    ? failure.code
    : undefined;
}

interface Walk {
  path: string;
  /** `dev:ino` of each part, the record itself last. */
  identities: string[];
  /** The record's own `lstat`. */
  stat: BigIntStats;
}

/**
 * `base` joined with `parts` when none of those parts is a link (each is
 * checked with `lstat`), with the identity of each. `base` is a git
 * directory and is already symlink-resolved. A member could otherwise point
 * a record at any file this process can read and learn or forge its time.
 * Checked part by part rather than by comparing a resolved path, which on a
 * case-insensitive file system can differ in case alone. A part swapped for
 * a link after this walk is caught by walking again after the read
 * ({@link sameWalk}).
 */
async function walk(
  base: string,
  parts: readonly string[],
): Promise<Walk | undefined> {
  let path = base;
  const identities: string[] = [];
  let stat: Walk['stat'] | undefined;
  for (const part of parts) {
    // The parts come from ref and remote names in member-written config;
    // none may step out of `base`.
    if (!part || part === '.' || part === '..' || /[\\/]/.test(part))
      return undefined;
    path = join(path, part);
    try {
      stat = await lstat(path, { bigint: true });
    } catch {
      return undefined;
    }
    if (stat.isSymbolicLink()) return undefined;
    identities.push(`${stat.dev}:${stat.ino}`);
  }
  return stat ? { path, identities, stat } : undefined;
}

/** Whether every part still is what {@link walk} saw. */
async function sameWalk(
  base: string,
  parts: readonly string[],
  before: Walk,
): Promise<boolean> {
  const after = await walk(base, parts);
  return (
    after !== undefined &&
    after.identities.join('/') === before.identities.join('/')
  );
}

/** A record's modification time, when it is a regular file reached without a link. */
async function recordTime(
  base: string,
  parts: readonly string[],
): Promise<Date | undefined> {
  const seen = await walk(base, parts);
  if (!seen?.stat.isFile()) return undefined;
  return (await sameWalk(base, parts, seen)) ? seen.stat.mtime : undefined;
}

/**
 * The last `maxBytes` of a record and its modification time, or
 * `undefined` when there is none (absent, a link anywhere on the way, a
 * FIFO, unreadable, or swapped while it was read).
 */
async function readRecord(
  base: string,
  parts: readonly string[],
  maxBytes: number,
): Promise<{ text: string; mtime: Date } | undefined> {
  const seen = await walk(base, parts);
  if (!seen) return undefined;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      seen.path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return undefined;
  }
  let result: { text: string; mtime: Date } | undefined;
  try {
    const stats = await handle.stat({ bigint: true });
    // The file opened must be the one the walk saw.
    if (
      !stats.isFile() ||
      `${stats.dev}:${stats.ino}` !== seen.identities.at(-1)
    )
      return undefined;
    if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    const size = Number(stats.size);
    const length = Math.min(size, maxBytes);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(
        bytes,
        read,
        length - read,
        size - length + read,
      );
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    result = {
      text: bytes.subarray(0, read).toString('utf8'),
      mtime: stats.mtime,
    };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
  return (await sameWalk(base, parts, seen)) ? result : undefined;
}

/**
 * `<old> <new> <identity> <seconds> <zone>`, then a tab and a message when
 * the update had one (`git update-ref` without `-m` writes none). Newest last.
 */
function reflogEntries(text: string): Array<{ old: string; time: number }> {
  const entries: Array<{ old: string; time: number }> = [];
  for (const line of text.split('\n')) {
    const match =
      /^([0-9a-f]{40,64}) [0-9a-f]{40,64} .*> (\d+) [+-]\d{4}(?:\t|\r?$)/.exec(
        line,
      );
    if (match) entries.push({ old: match[1], time: Number(match[2]) * 1000 });
  }
  return entries;
}

/**
 * A name under `refs/` with none of the characters git forbids in a ref
 * (control characters, space, DEL, `~^:?*[\`): never an option, a revision
 * or a line break.
 */
function isRefName(name: string): boolean {
  return (
    name.length > 'refs/'.length &&
    name.startsWith('refs/') &&
    !/[~^:?*[\\]/.test(name) &&
    ![...name].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  );
}

type RepositoryFacts =
  | { kind: 'known'; facts: ProjectCheckoutFacts }
  | { kind: 'unknown'; reason: 'detached-head' | 'no-upstream' };

async function readFacts(repository: ReadRepository): Promise<RepositoryFacts> {
  const git = async (args: string[]) =>
    (
      await execGit([...repository.repoArgs, ...args], {
        cwd: repository.top,
        encoding: 'utf-8',
        timeout: GIT_TIMEOUT_MS,
      })
    ).stdout.trim();

  // The full name: `--short` would say `heads/main` when a tag `main`
  // exists too.
  let head: string;
  try {
    head = await git(['symbolic-ref', '--quiet', 'HEAD']);
  } catch (error) {
    // `symbolic-ref --quiet` exits 1 exactly when HEAD is not a branch.
    if (exitCode(error) === 1)
      return { kind: 'unknown', reason: 'detached-head' };
    throw error;
  }
  const branch = head.replace(/^refs\/heads\//, '');
  // The configured upstream, whether or not its ref exists, and its remote
  // as configured; empty for none. A branch cannot have a branch under it,
  // so this pattern names one ref. NUL-separated: the config these come
  // from is member-written, and a value can hold a line break but no NUL.
  const [upstreamRef = '', remote = ''] = (
    await git([
      'for-each-ref',
      '--format=%(upstream)%00%(upstream:remotename)',
      head,
    ])
  ).split('\0');
  // A ref name, never something git would take as an option, with none of
  // the characters git forbids in one (control characters, space, `~^:?*[\`).
  // A remote's refspec may map it anywhere under `refs/`.
  if (!isRefName(upstreamRef))
    return { kind: 'unknown', reason: 'no-upstream' };
  // Whether exactly that ref exists. `show-ref --verify` takes the full name
  // as written, with no guessing at other refs, and reads it by name (so a
  // case-insensitive file system finds it whatever the folder's case). It
  // exits 1 for a missing ref; a missing object (a damaged repository) is
  // another failure, `unreadable` rather than an absent upstream.
  try {
    await git(['show-ref', '--verify', '--quiet', upstreamRef]);
  } catch (error) {
    if (exitCode(error) === 1)
      return { kind: 'unknown', reason: 'no-upstream' };
    throw error;
  }

  const [ahead, behind] = (
    await git(['rev-list', '--left-right', '--count', `HEAD...${upstreamRef}`])
  )
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));
  if (!Number.isInteger(ahead) || !Number.isInteger(behind))
    throw new Error('git reported an unreadable ahead/behind count');

  let behindSince: number | undefined;
  if (behind > 0) {
    // The upstream's first-parent line records each change as it landed
    // there; a merged branch's own commits keep their older dates.
    const landed = Number.parseInt(
      await git([
        'rev-list',
        '--first-parent',
        '--count',
        `HEAD..${upstreamRef}`,
      ]),
      10,
    );
    if (landed > 0) {
      const committed = Date.parse(
        await git([
          'log',
          '-1',
          '--first-parent',
          `--skip=${landed - 1}`,
          '--format=%cI',
          `HEAD..${upstreamRef}`,
        ]),
      );
      if (Number.isFinite(committed)) behindSince = committed;
    }
    // A committer date can be far older than the commit's arrival (a
    // fast-forward of old work). When the upstream ref's reflog shows when
    // it moved past HEAD, that time is never earlier than the arrival.
    const learned = await reflogMovedPastHead(repository, upstreamRef, git);
    if (learned !== undefined)
      behindSince = Math.max(behindSince ?? learned, learned);
  }

  // An upstream from a remote only (a local branch's remote is `.`).
  const fetched =
    remote && remote !== '.'
      ? await lastFetch(repository, upstreamRef, remote, git)
      : undefined;

  return {
    kind: 'known',
    facts: {
      branch,
      upstream: upstreamRef.replace(/^refs\/(?:remotes|heads)\//, ''),
      behind,
      ahead,
      ...(behindSince !== undefined
        ? { behindSince: new Date(behindSince).toISOString() }
        : {}),
      ...(fetched ? { upstreamFetchedAt: fetched.toISOString() } : {}),
    },
  };
}

/**
 * The newest record of a fetch that brought in the upstream: a FETCH_HEAD
 * (the worktree's or the repository's) that lists the upstream's current
 * commit, so a fetch of some other remote does not count; the upstream
 * ref's reflog; or the remote's HEAD reflog, which `git clone` writes when
 * it writes neither of the others.
 */
async function lastFetch(
  repository: ReadRepository,
  upstreamRef: string,
  remote: string,
  git: (args: string[]) => Promise<string>,
): Promise<Date | undefined> {
  const tip = await git(['rev-parse', '--verify', `${upstreamRef}^{commit}`]);
  const times: Array<Date | undefined> = [];
  for (const base of new Set([repository.gitDir, repository.commonDir])) {
    const record = await readRecord(base, ['FETCH_HEAD'], FETCH_HEAD_BYTES);
    times.push(
      record?.text.split('\n').some((line) => line.startsWith(`${tip}\t`))
        ? record.mtime
        : undefined,
    );
  }
  times.push(
    await recordTime(repository.commonDir, ['logs', ...upstreamRef.split('/')]),
    await recordTime(repository.commonDir, [
      'logs',
      'refs',
      'remotes',
      ...remote.split('/'),
      'HEAD',
    ]),
  );
  let latest: Date | undefined;
  for (const time of times)
    if (time && (!latest || time > latest)) latest = time;
  return latest;
}

/**
 * When the upstream ref moved from a commit HEAD contains to one it lacks:
 * the newest reflog entry whose previous value HEAD contains. Walks back
 * from the newest entry, at most {@link MAX_REFLOG_ENTRIES}; past that, or
 * past the oldest entry kept, the oldest time examined (which can only
 * understate how long the checkout has been behind). `undefined` without a
 * reflog.
 */
async function reflogMovedPastHead(
  repository: ReadRepository,
  upstreamRef: string,
  git: (args: string[]) => Promise<string>,
): Promise<number | undefined> {
  const text = (
    await readRecord(
      repository.commonDir,
      ['logs', ...upstreamRef.split('/')],
      REFLOG_TAIL_BYTES,
    )
  )?.text;
  const entries = text ? reflogEntries(text) : [];
  if (entries.length === 0) return undefined;
  const examined = entries.slice(-MAX_REFLOG_ENTRIES).reverse();
  for (const entry of examined) {
    if (/^0+$/.test(entry.old)) return entry.time;
    try {
      await git(['merge-base', '--is-ancestor', entry.old, 'HEAD']);
      return entry.time;
    } catch (error) {
      // Exit 1: HEAD lacks it too, so the ref was already past HEAD then.
      // Another exit (an id whose object is gone): this entry says nothing.
      if (exitCode(error) === undefined) throw error;
    }
  }
  return examined[examined.length - 1].time;
}

async function observe(directory: string): Promise<Observation> {
  const at = new Date();
  let resolved: string;
  try {
    resolved = await realpath(directory);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return { kind: 'unknown', reason: 'missing-directory', at };
    logger.warn('Could not resolve a Project working directory', {
      error: errorMessage(error),
    });
    return { kind: 'unknown', reason: 'unreadable', at };
  }
  try {
    const outcome = await readProjectRepository(
      resolved,
      resolved,
      { timeoutMs: GIT_TIMEOUT_MS },
      readFacts,
    );
    if (outcome.ok) {
      return outcome.value.kind === 'known'
        ? { kind: 'known', facts: outcome.value.facts, at }
        : { kind: 'unknown', reason: outcome.value.reason, at };
    }
    switch (outcome.state) {
      case 'not-a-repository':
        return { kind: 'unknown', reason: 'not-a-repository', at };
      case 'config-refused':
      case 'config-unreadable':
        return { kind: 'unknown', reason: 'config-refused', at };
      default:
        return { kind: 'unknown', reason: 'unreadable', at };
    }
  } catch (error) {
    logger.warn('Could not read a Project checkout against its upstream', {
      error: errorMessage(error),
    });
    return { kind: 'unknown', reason: 'unreadable', at };
  }
}

/** Single-quoted for a POSIX shell unless every character is plainly safe. */
function shellArgument(value: string): string {
  return /^[A-Za-z0-9_/.,:@%+=-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ProjectCheckoutFreshnessReader {
  read(
    workingDirectory: string | undefined,
    thresholds: ProjectCheckoutStaleThresholds,
  ): Promise<ProjectCheckoutFreshness>;
}

export function createProjectCheckoutFreshnessReader(
  options: { now?: () => Date; ttlMs?: number; deadlineMs?: number } = {},
): ProjectCheckoutFreshnessReader {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? FRESHNESS_TTL_MS;
  const deadlineMs = options.deadlineMs ?? OBSERVATION_DEADLINE_MS;
  const remembered = new Map<
    string,
    { observation: Promise<Observation>; settledAt?: number }
  >();

  const observation = (directory: string): Promise<Observation> => {
    const entry = remembered.get(directory);
    if (
      entry &&
      (entry.settledAt === undefined ||
        now().getTime() - entry.settledAt < ttlMs)
    )
      return entry.observation;
    remembered.delete(directory);
    const fresh = {
      observation: observe(directory),
      settledAt: undefined as number | undefined,
    };
    remembered.set(directory, fresh);
    void fresh.observation.then((seen) => {
      // A read that could not complete is not an answer worth keeping.
      if (seen.kind === 'unknown' && seen.reason === 'unreadable') {
        if (remembered.get(directory) === fresh) remembered.delete(directory);
        return;
      }
      fresh.settledAt = now().getTime();
    });
    while (remembered.size > MAX_REMEMBERED) {
      const oldest = remembered.keys().next().value;
      if (oldest === undefined) break;
      remembered.delete(oldest);
    }
    return fresh.observation;
  };

  return {
    async read(workingDirectory, thresholds) {
      if (!workingDirectory?.trim()) {
        return {
          version: PROJECT_CHECKOUT_FRESHNESS_VERSION,
          status: 'unknown',
          reason: 'no-working-directory',
          checkedAt: now().toISOString(),
        };
      }
      // Absolute, so the command means the same folder in any terminal.
      const directory = resolve(expandTilde(workingDirectory.trim()));
      const pending = observation(directory);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const seen = await Promise.race([
        pending,
        new Promise<Observation>((settle) => {
          timer = setTimeout(() => {
            // Forget the wedged read, so the next request tries again.
            if (remembered.get(directory)?.observation === pending)
              remembered.delete(directory);
            settle({ kind: 'unknown', reason: 'unreadable', at: now() });
          }, deadlineMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (seen.kind === 'unknown') {
        return {
          version: PROJECT_CHECKOUT_FRESHNESS_VERSION,
          status: 'unknown',
          reason: seen.reason,
          checkedAt: seen.at.toISOString(),
        };
      }
      const staleBecause = projectCheckoutStaleReasons(
        seen.facts,
        thresholds,
        now(),
      );
      return {
        version: PROJECT_CHECKOUT_FRESHNESS_VERSION,
        status: staleBecause.length > 0 ? 'stale' : 'not-stale',
        staleBecause,
        thresholds,
        ...seen.facts,
        updateCommand: `git -C ${shellArgument(directory)} pull --ff-only`,
        checkedAt: seen.at.toISOString(),
      };
    },
  };
}
