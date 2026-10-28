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
  /** Stale once the upstream has held a commit this checkout lacks for this many days. */
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
  /** The branch has no upstream, or its upstream ref does not exist locally. */
  | 'no-upstream'
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
   * ISO time the oldest commit HEAD lacks landed on the upstream's
   * first-parent line (its committer date). Absent when `behind` is 0.
   */
  oldestMissingCommitAt?: string;
  /**
   * ISO time of the most recent local record of a fetch (`FETCH_HEAD`, or
   * the upstream ref's reflog). Absent when the checkout holds neither.
   */
  upstreamFetchedAt?: string;
}

export type ProjectCheckoutStaleReason = 'commits' | 'age';

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
  facts: Pick<ProjectCheckoutFacts, 'behind' | 'oldestMissingCommitAt'>,
  thresholds: ProjectCheckoutStaleThresholds,
  now: Date = new Date(),
): ProjectCheckoutStaleReason[] {
  if (facts.behind <= 0) return [];
  const reasons: ProjectCheckoutStaleReason[] = [];
  if (facts.behind >= thresholds.commits) reasons.push('commits');
  const oldest = facts.oldestMissingCommitAt
    ? Date.parse(facts.oldestMissingCommitAt)
    : Number.NaN;
  if (
    Number.isFinite(oldest) &&
    now.getTime() - oldest >= thresholds.days * DAY_MS
  )
    reasons.push('age');
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
