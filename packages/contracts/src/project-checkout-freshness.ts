/**
 * How far a Project's checkout is behind its upstream, from local refs only
 * (`GET /api/projects/:slug/checkout-freshness`).
 *
 * An agent started in a Project reads that checkout's instructions. When the
 * checkout is far behind its upstream it can follow a rule the upstream has
 * since removed. This view lets a person, and an agent through
 * `get_project`, notice that. Station never fetches or updates the checkout
 * itself: `behind` counts commits the last fetch brought in, and
 * `upstreamFetchedAt` says when that was.
 */

export const PROJECT_CHECKOUT_FRESHNESS_VERSION =
  'station.project-checkout-freshness/v1';

/** The Feature Preview that gates the read and every surface showing it. */
export const PROJECT_CHECKOUT_FRESHNESS_PREVIEW_ID = 'stale-project-checkout';

/** `AppConfig.checkoutStaleAfterCommits` when unset. */
export const DEFAULT_CHECKOUT_STALE_AFTER_COMMITS = 50;
/** `AppConfig.checkoutStaleAfterDays` when unset. */
export const DEFAULT_CHECKOUT_STALE_AFTER_DAYS = 3;

export interface ProjectCheckoutStaleThresholds {
  /** Stale at this many commits behind, or more. */
  commits: number;
  /**
   * Stale once this checkout has lacked an upstream commit for this many
   * days (`behindSince`), or its last recorded fetch is this old.
   */
  days: number;
}

/** Why nothing can be said about the checkout. None of these is an error. */
export type ProjectCheckoutUnknownReason =
  /** The Project names no working directory. */
  | 'no-working-directory'
  /** The working directory does not exist on this Station. */
  | 'missing-directory'
  /** It is not inside a git work tree. */
  | 'not-a-repository'
  /** HEAD is not on a branch. */
  | 'detached-head'
  /**
   * The branch has no upstream, its remote does not exist, its upstream ref
   * does not exist locally, or the configured value is not a ref name.
   */
  | 'no-upstream'
  /**
   * The repository's own config sets options Station does not run git with
   * (a credential helper, an ssh command, …), so Station did not read it.
   */
  | 'config-refused'
  /** Station could not read the repository (refused, timed out, or changing). */
  | 'unreadable';

/** What git reported about the checkout, before thresholds apply. */
export interface ProjectCheckoutFacts {
  /** Current branch, short name. */
  branch: string;
  /** Upstream ref, short name (`origin/main`). */
  upstream: string;
  /** Commits on the upstream that HEAD lacks. */
  behind: number;
  /** Commits on HEAD that the upstream lacks. */
  ahead: number;
  /**
   * ISO time from which this checkout can be shown to have lacked an
   * upstream commit: the later of the committer date of the oldest missing
   * commit on the upstream's first-parent line, and the time the upstream
   * ref's reflog first moved past HEAD. A committer date alone can be far
   * older than when the commit arrived (a fast-forward of old work); the
   * reflog time is never earlier than the arrival. Absent when `behind` is 0.
   */
  behindSince?: string;
  /**
   * ISO time of the most recent local record of a fetch: `FETCH_HEAD` (of
   * any remote), the upstream ref's reflog, or the remote's HEAD reflog
   * (written by `git clone`). Only for an upstream from a remote, not a
   * local branch; absent when the checkout holds none of these.
   */
  upstreamFetchedAt?: string;
}

/**
 * `commits`: behind by the commit threshold. `age`: behind since at least
 * the day threshold. `fetch-age`: the last recorded fetch is at least the day
 * threshold old, so the local refs may hide more (`behind` can be 0).
 */
export type ProjectCheckoutStaleReason = 'commits' | 'age' | 'fetch-age';

/** A checkout whose branch and upstream could be read. */
export interface ProjectCheckoutKnownFreshness extends ProjectCheckoutFacts {
  version: typeof PROJECT_CHECKOUT_FRESHNESS_VERSION;
  /** Empty exactly when `status` is `not-stale`. */
  staleBecause: ProjectCheckoutStaleReason[];
  thresholds: ProjectCheckoutStaleThresholds;
  /**
   * The command that updates the checkout. Station never runs it. It
   * refuses when `ahead` is also above 0 (the histories diverged).
   */
  updateCommand: string;
  checkedAt: string;
}

export type ProjectCheckoutFreshness =
  | {
      version: typeof PROJECT_CHECKOUT_FRESHNESS_VERSION;
      status: 'unknown';
      reason: ProjectCheckoutUnknownReason;
      checkedAt: string;
    }
  | (ProjectCheckoutKnownFreshness & { status: 'stale' })
  | (ProjectCheckoutKnownFreshness & { status: 'not-stale' });

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which thresholds the facts cross, as of `now`. */
export function projectCheckoutStaleReasons(
  facts: Pick<
    ProjectCheckoutFacts,
    'behind' | 'behindSince' | 'upstreamFetchedAt'
  >,
  thresholds: ProjectCheckoutStaleThresholds,
  now: Date = new Date(),
): ProjectCheckoutStaleReason[] {
  const olderThanDays = (iso: string | undefined) => {
    const time = iso ? Date.parse(iso) : Number.NaN;
    return (
      Number.isFinite(time) && now.getTime() - time >= thresholds.days * DAY_MS
    );
  };
  const reasons: ProjectCheckoutStaleReason[] = [];
  if (facts.behind > 0 && facts.behind >= thresholds.commits)
    reasons.push('commits');
  if (facts.behind > 0 && olderThanDays(facts.behindSince)) reasons.push('age');
  if (olderThanDays(facts.upstreamFetchedAt)) reasons.push('fetch-age');
  return reasons;
}

/**
 * The thresholds in force: the configured values when they are positive
 * integers, else the defaults.
 */
export function resolveProjectCheckoutStaleThresholds(config: {
  checkoutStaleAfterCommits?: number;
  checkoutStaleAfterDays?: number;
}): ProjectCheckoutStaleThresholds {
  const positive = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1
      ? value
      : fallback;
  return {
    commits: positive(
      config.checkoutStaleAfterCommits,
      DEFAULT_CHECKOUT_STALE_AFTER_COMMITS,
    ),
    days: positive(
      config.checkoutStaleAfterDays,
      DEFAULT_CHECKOUT_STALE_AFTER_DAYS,
    ),
  };
}
