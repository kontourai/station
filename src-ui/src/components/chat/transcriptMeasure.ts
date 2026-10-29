/**
 * The transcript column's floor — the narrowest it may be squeezed by
 * something beside it before it stops being readable. Derived from the
 * transcript's own rules: a message bubble is 80% of its row (`.message`,
 * `max-width: 80%`) with 48px of its own padding, and the row sits inside the
 * column's two 20px gutters (`--chat-message-gutter`). A 640px column is a
 * 600px row, a 480px bubble, 432px of text past the padding: sixty-odd
 * characters of the body, the measure under which a reply's lines break too
 * often to scan. (The design audit's 500px column, beside an unfolded inbox
 * at 1440, showed exactly that: a two-line composer and wrapped cards.)
 *
 * Owned here, beside the transcript, because two neighbours read it: the
 * Coding workbench's side panel and the Chat dock's session context card.
 */
export const TRANSCRIPT_MIN_WIDTH = 640;
