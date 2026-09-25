/**
 * Engines stream each assistant MESSAGE as its own run of deltas and put no
 * whitespace between messages, so two messages in one turn with no tool or
 * reasoning between them rendered as one run-on paragraph ("…the PR.The
 * focused tests…"). The adapter that can see the message boundary inserts
 * the break INTO the delta it publishes, so the live fold, the durable
 * replay and any `outputText` the adapter builds from its deltas all carry
 * the same bytes (the terminal reconciliation compares them verbatim).
 *
 * The key must be a MESSAGE boundary, never the content-item id: Claude
 * splits one message into several text blocks at citation boundaries, and
 * transcript sources split one block into chunks — both mid-prose.
 */
export interface ParagraphBoundaryState {
  turnKey?: string;
  messageKey?: string;
  /** Last two characters of this turn's text so far. */
  tail?: string;
}

export const PARAGRAPH_BREAK = '\n\n';

export function withParagraphBreak(
  state: ParagraphBoundaryState,
  turnKey: string,
  messageKey: string,
  delta: string,
): string {
  if (state.turnKey !== turnKey) {
    state.turnKey = turnKey;
    state.messageKey = undefined;
    state.tail = '';
  }
  const tail = state.tail ?? '';
  const breaks =
    tail.length > 0 &&
    state.messageKey !== undefined &&
    state.messageKey !== messageKey &&
    !tail.endsWith(PARAGRAPH_BREAK) &&
    !delta.startsWith(PARAGRAPH_BREAK);
  const text = breaks ? `${PARAGRAPH_BREAK}${delta}` : delta;
  state.messageKey = messageKey;
  state.tail = `${tail}${text}`.slice(-2);
  return text;
}
