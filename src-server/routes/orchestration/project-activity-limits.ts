/**
 * station#3413: the bounds of `list_project_activity` and `get_session_digest`,
 * dependency-free so the station-control tools (bundled into the stdio child)
 * and their routes share one definition.
 */

/** The hard maximum list `limit`; `limit=51` is refused, never cut to 50. */
export const PROJECT_ACTIVITY_MAX_LIMIT = 50;
export const PROJECT_ACTIVITY_DEFAULT_LIMIT = 25;

/** The hard cap on one digest page's serialized `turns`. */
export const SESSION_DIGEST_PAGE_MAX_BYTES = 8 * 1024;
export const SESSION_DIGEST_DEFAULT_TURNS = 10;
/** The hard maximum `turnLimit`; more is refused, never cut. */
export const SESSION_DIGEST_MAX_TURNS = 25;
