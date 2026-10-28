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
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
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
export const FRESHNESS_TTL_MS = 10_000;
/** Directories remembered at once; the oldest is forgotten first. */
const MAX_REMEMBERED = 256;
/** Each git call is a local ref read; this only bounds a wedged mount. */
const GIT_TIMEOUT_MS = 5_000;
/** The newest reflog entries examined; enough for months of fetches. */
const REFLOG_TAIL_BYTES = 64 * 1024;
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

/**
 * `path` when no component of it is a link, else `undefined`. The git
 * directories these paths are joined to are already symlink-resolved, so a
 * link anywhere below them (`logs`, `logs/refs/remotes`, the file itself)
 * shows up as a different resolved path. A member could otherwise point a
 * record at any file this process can read and learn or forge its time.
 */
async function unlinked(path: string): Promise<string | undefined> {
  try {
    return (await realpath(path)) === path ? path : undefined;
  } catch {
    return undefined;
  }
}

/** The latest modification time among regular files that exist. */
async function latestModification(
  paths: readonly string[],
): Promise<Date | undefined> {
  let latest: Date | undefined;
  for (const path of paths) {
    if (!(await unlinked(path))) continue;
    try {
      const stat = await lstat(path);
      if (stat.isFile() && (!latest || stat.mtime > latest))
        latest = stat.mtime;
    } catch {
      // Absent: this record of a fetch does not exist.
    }
  }
  return latest;
}

/**
 * The last {@link REFLOG_TAIL_BYTES} of a regular file, or `undefined` when
 * there is none (absent, a link, a FIFO, unreadable).
 */
async function readTail(path: string): Promise<string | undefined> {
  if (!(await unlinked(path))) return undefined;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return undefined;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;
    const length = Math.min(stats.size, REFLOG_TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(
        bytes,
        read,
        length - read,
        stats.size - length + read,
      );
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return bytes.subarray(0, read).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
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
  // The configured upstream, whether or not its ref exists; empty for none.
  // Ref names cannot hold glob characters, so this pattern names one ref.
  const upstreamRef = await git(['for-each-ref', '--format=%(upstream)', head]);
  if (!upstreamRef) return { kind: 'unknown', reason: 'no-upstream' };
  // Whether the ref exists, without reading the object it names: a ref
  // whose commit is missing is a damaged repository, which the reads below
  // fail on (`unreadable`), not an absent upstream.
  if (!(await git(['for-each-ref', '--format=%(objectname)', upstreamRef])))
    return { kind: 'unknown', reason: 'no-upstream' };

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

  // A remote-tracking upstream only. `git clone` writes neither FETCH_HEAD
  // nor the branch's reflog, only the remote's HEAD reflog.
  const remote = /^refs\/remotes\/([^/]+)\//.exec(upstreamRef)?.[1];
  const fetched = remote
    ? await latestModification([
        join(repository.gitDir, 'FETCH_HEAD'),
        join(repository.commonDir, 'FETCH_HEAD'),
        join(repository.commonDir, 'logs', ...upstreamRef.split('/')),
        join(repository.commonDir, 'logs', 'refs', 'remotes', remote, 'HEAD'),
      ])
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
  const text = await readTail(
    join(repository.commonDir, 'logs', ...upstreamRef.split('/')),
  );
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
  options: { now?: () => Date; ttlMs?: number } = {},
): ProjectCheckoutFreshnessReader {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? FRESHNESS_TTL_MS;
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
      const directory = expandTilde(workingDirectory.trim());
      const seen = await observation(directory);
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
