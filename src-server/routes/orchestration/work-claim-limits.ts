/**
 * station#3413 part B: the bounds of `claim_work`, `renew_claim` and
 * `release_claim`, dependency-free so the station-control tools (bundled into
 * the stdio child) and their routes share one definition. A value past a bound
 * is refused, never cut.
 */

/** How long a claim lasts unless renewed: Flow Agents' default claim TTL. */
export const WORK_CLAIM_DEFAULT_TTL_SECONDS = 30 * 60;
export const WORK_CLAIM_MIN_TTL_SECONDS = 60;
export const WORK_CLAIM_MAX_TTL_SECONDS = 4 * 60 * 60;

/** Active claims one Session may hold at once; the next is refused. */
export const WORK_CLAIM_MAX_ACTIVE_PER_SESSION = 10;

export const WORK_CLAIM_WORK_ITEM_REF_MAX_CHARS = 200;
export const WORK_CLAIM_MAX_PATHS = 20;
export const WORK_CLAIM_PATH_MAX_CHARS = 512;
export const WORK_CLAIM_NOTE_MAX_CHARS = 500;

/** Active claims one Station UI read returns; more is refused, never cut. */
export const WORK_CLAIM_LIST_MAX = 500;
