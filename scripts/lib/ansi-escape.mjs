/**
 * One definition of an ANSI SGR/CSI escape sequence, for every gate that has
 * to read output a terminal coloured.
 *
 * station#1471: vitest, biome and tsc all colour their output whenever they
 * write to a terminal, and a GitHub Actions runner is one. An escape sequence
 * sits BEFORE the first visible character of the line, so every `^`-anchored
 * matcher in the verification reporter — the `FAIL <file>` banner, biome's
 * `×`/`!` severity markers — silently stopped matching on hosted runs while
 * continuing to pass every local fixture, which is plain text. The reporter
 * strips escapes before it matches; the gate summary strips them before it
 * renders. Two copies of this pattern is one copy too many.
 *
 * It lives in its own module rather than in `verification-reporter.mjs`
 * because `scripts/verification-gate-summary.mjs` is a reporting script that
 * must never fail the job it reports on, and the reporter's module graph
 * reaches Ajv and the receipt schema. A regex is not worth that import.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the terminal escape byte is exactly the job.
export const ANSI_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/** The same text with every escape sequence removed. */
export function withoutAnsi(value) {
  return String(value ?? '').replace(ANSI_SEQUENCE, '');
}
