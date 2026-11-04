/**
 * Whether a prompt says nothing a conversation could be named by.
 *
 * A conversation is titled from what its person first wrote, and a
 * continuation often opens with "Continue" or "ok go ahead" (or Station's own
 * memory-recovery prompt). Every surface that derives a title (the server's
 * `displayTitle` and history row, and the client's fallback before the server
 * title arrives) skips such a prompt and keeps the previous title, so this is
 * the one rule they share.
 *
 * The rule, after lowercasing, NFKC folding and treating everything that is
 * not a letter or digit as a word break:
 * - nothing is left (punctuation, emoji, whitespace); or
 * - every word is conversational filler from `FILLER_WORDS` ("ok", "yes",
 *   "continue", "go", "on", "please", "thanks"…), so "Continue.",
 *   "OK, go ahead!", "yes please" and "keep going" are low-content; or
 * - it is one of the exact `STATION_CONTINUATION_PROMPTS`.
 *
 * Deliberately NOT a length rule ("two words or fewer"): "Deploy staging" and
 * "Fix login" are real titles, and skipping them would title the conversation
 * from whatever the person said next. A word outside the filler list is
 * content, however short the prompt is.
 */

/**
 * Words that carry no subject on their own. A prompt made only of these is
 * an instruction to carry on, an acknowledgement or a greeting.
 */
const FILLER_WORDS = new Set([
  'ahead',
  'again',
  'alright',
  'and',
  'carry',
  'continue',
  'cool',
  'do',
  'done',
  'go',
  'going',
  'good',
  'great',
  'hello',
  'hey',
  'hi',
  'it',
  'k',
  'keep',
  'let',
  'lets',
  'more',
  'next',
  'nice',
  'no',
  'nope',
  'now',
  'ok',
  'okay',
  'on',
  'please',
  'pls',
  'plz',
  'proceed',
  'resume',
  'retry',
  's',
  'sure',
  'thank',
  'thanks',
  'that',
  'the',
  'then',
  'this',
  'thx',
  'try',
  'ty',
  'y',
  'yeah',
  'yep',
  'yes',
  'you',
]);

/**
 * Prompts Station itself sends to carry a conversation on. Compared after
 * the same normalization as the filler words; the server pins each against
 * its source constant (`MEMORY_CONTINUATION_TEXT`).
 */
const STATION_CONTINUATION_PROMPTS = new Set([
  'continue the task from where it stopped',
]);

function promptWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function isLowContentPrompt(text: string | undefined): boolean {
  if (text === undefined) return true;
  const words = promptWords(text);
  if (words.length === 0) return true;
  if (words.every((word) => FILLER_WORDS.has(word))) return true;
  return STATION_CONTINUATION_PROMPTS.has(words.join(' '));
}
