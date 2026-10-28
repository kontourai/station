/**
 * How far a Project's checkout is behind its upstream
 * (`@kontourai/station-contracts/project-checkout-freshness`).
 *
 * Local refs only: nothing here fetches, so the answer is "as of the last
 * fetch", and that fetch's time is reported beside it. Every git call runs
 * through {@link readProjectRepository}, because a Project's folder is
 * member-writable and the repository git would discover there is not
 * trusted on its own.
 *
 * Facts are remembered per directory for {@link FRESHNESS_TTL_MS}, and
 * callers that arrive while a read is running join it, so a settings page,
 * a new chat and an agent's `get_project` cost one read between them.
 * Thresholds are applied per call, so a changed setting applies at once.
 */
import { lstat, realpath } from 'node:fs/promises';
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

/** How long a read's facts are reused. */
export const FRESHNESS_TTL_MS = 60_000;
/** Directories remembered at once; the oldest is forgotten first. */
const MAX_REMEMBERED = 256;
/** Each git call is a local ref read; this only bounds a wedged mount. */
const GIT_TIMEOUT_MS = 5_000;

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

/** The latest modification time among regular files that exist. */
async function latestModification(
  paths: readonly string[],
): Promise<Date | undefined> {
  let latest: Date | undefined;
  for (const path of paths) {
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

  let branch: string;
  try {
    branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch (error) {
    // `symbolic-ref --quiet` exits 1 exactly when HEAD is not a branch.
    if (exitCode(error) === 1)
      return { kind: 'unknown', reason: 'detached-head' };
    throw error;
  }
  let upstreamRef: string;
  try {
    upstreamRef = await git([
      'rev-parse',
      '--symbolic-full-name',
      '--verify',
      '--quiet',
      '@{upstream}',
    ]);
  } catch (error) {
    // No upstream configured, or the configured one has no local ref.
    if (exitCode(error) !== undefined)
      return { kind: 'unknown', reason: 'no-upstream' };
    throw error;
  }
  if (!upstreamRef) return { kind: 'unknown', reason: 'no-upstream' };

  const [ahead, behind] = (
    await git(['rev-list', '--left-right', '--count', `HEAD...${upstreamRef}`])
  )
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));
  if (!Number.isInteger(ahead) || !Number.isInteger(behind))
    throw new Error('git reported an unreadable ahead/behind count');

  let oldestMissingCommitAt: string | undefined;
  if (behind > 0) {
    // The upstream's first-parent line records when each change landed
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
      const committed = await git([
        'log',
        '-1',
        '--first-parent',
        `--skip=${landed - 1}`,
        '--format=%cI',
        `HEAD..${upstreamRef}`,
      ]);
      const time = Date.parse(committed);
      if (Number.isFinite(time))
        oldestMissingCommitAt = new Date(time).toISOString();
    }
  }

  const fetched = await latestModification([
    join(repository.gitDir, 'FETCH_HEAD'),
    join(repository.commonDir, 'FETCH_HEAD'),
    join(repository.commonDir, 'logs', ...upstreamRef.split('/')),
  ]);

  return {
    kind: 'known',
    facts: {
      branch,
      upstream: upstreamRef.replace(/^refs\/(?:remotes|heads)\//, ''),
      behind,
      ahead,
      ...(oldestMissingCommitAt ? { oldestMissingCommitAt } : {}),
      ...(fetched ? { upstreamFetchedAt: fetched.toISOString() } : {}),
    },
  };
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
    if (outcome.state === 'not-a-repository')
      return { kind: 'unknown', reason: 'not-a-repository', at };
    return { kind: 'unknown', reason: 'unreadable', at };
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
    void fresh.observation.then(() => {
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
