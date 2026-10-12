/**
 * #3159: the bounds of the `read_conversation` read, dependency-free so the
 * station-control tool (bundled into the stdio child) and the route share
 * one definition.
 */

/** The hard maximum `limit`; `limit=51` is refused, never truncated. */
export const READ_CONVERSATION_MAX_LIMIT = 50;
export const READ_CONVERSATION_DEFAULT_LIMIT = 20;
/** One page's serialized `messages` never exceed this many bytes. */
export const READ_CONVERSATION_PAGE_MAX_BYTES = 64 * 1024;
/**
 * One message's text is clipped (and says so) past this many bytes, so a
 * single message always fits a page and paging always advances.
 */
export const READ_CONVERSATION_MESSAGE_TEXT_MAX_BYTES = 16 * 1024;
