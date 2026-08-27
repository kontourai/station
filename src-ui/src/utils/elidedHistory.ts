import type { RuntimeEventElisionReason } from '@kontourai/station-contracts/orchestration';

/**
 * How much of a bounded history read came back reduced, split by which budget
 * did it (station#3386).
 *
 * Two surfaces render this — the chat dock and the sessions detail — off the
 * same `elided` markers, so the counting and the wording live here rather than
 * twice. A second copy is how the two halves of one disclosure start
 * disagreeing about what the reader was told.
 */
export interface ElidedHistorySummary {
  total: number;
  byteLimit: number;
  outputLimit: number;
}

export const NO_ELIDED_HISTORY: ElidedHistorySummary = {
  total: 0,
  byteLimit: 0,
  outputLimit: 0,
};

export function summarizeElidedReasons(
  reasons: Iterable<RuntimeEventElisionReason | undefined>,
): ElidedHistorySummary {
  let byteLimit = 0;
  let outputLimit = 0;
  for (const reason of reasons) {
    if (reason === 'byte_limit') byteLimit += 1;
    else if (reason === 'output_limit') outputLimit += 1;
  }
  return { total: byteLimit + outputLimit, byteLimit, outputLimit };
}

/**
 * The sentence a reader gets, or `undefined` when the read returned everything.
 *
 * The two reasons are worded apart on purpose: choosing a reason code over a
 * `truncated: true` boolean is worthless if the surface folds them back into
 * one sentence. `byte_limit` removed a whole payload — a turn's prompt and its
 * attachment chip go with it; `output_limit` shortened one tool result and
 * left the rest of that event intact. Those are different losses, and only one
 * of them explains a turn that looks like it never had a prompt.
 */
export function elidedHistoryNoticeText(
  summary: ElidedHistorySummary,
): string | undefined {
  if (summary.total === 0) return undefined;
  const clauses: string[] = [];
  if (summary.byteLimit > 0) {
    clauses.push(
      summary.byteLimit === 1
        ? '1 earlier item is shown without its content'
        : `${summary.byteLimit} earlier items are shown without their content`,
    );
  }
  if (summary.outputLimit > 0) {
    clauses.push(
      summary.outputLimit === 1
        ? '1 tool result is shortened'
        : `${summary.outputLimit} tool results are shortened`,
    );
  }
  // Worded for the reader, not the mechanism (the "history read's size
  // budget" phrasing leaked an internal name — chat-surface honesty pass):
  // say what is reduced and that nothing is lost, without naming the budget.
  return `${clauses.join(', and ')} — too large to load in full here. The session still holds the complete content.`;
}
