/**
 * Text someone else wrote, rendered so it reads as data (#4003 review F1-F3).
 *
 * Station hands agents text that other agents, people and public trackers
 * wrote: Task memory, a Task document, tracker comments. Rendered raw, a line
 * of that text can pose as one of Station's own headings, rules or footers.
 * Rendered by these helpers it cannot: every line of quoted text starts with
 * `> ` (an empty one is `>`), so no quoted line can equal a line Station
 * writes, and every line terminator JS and Unicode know is treated as one, so
 * a lone `\r` or U+2028 cannot start an unquoted line. The same rule as the
 * agent-message frame (`@kontourai/station-shared/agent-message-frame`).
 */

/** Every line terminator JS and Unicode know. */
const LINE_TERMINATORS = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/u;
/** Whitespace a single line must not keep, line terminators included. */
const ANY_BREAK_OR_SPACE = /[\s\u0085]+/gu;

const CUT_MARKER = ' …(cut)';

/** `value` cut to `max` UTF-16 code units, with a visible marker. */
export function cutText(value: string, max: number, marker = CUT_MARKER) {
  return value.length <= max
    ? value
    : `${value.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

/** `text` split at every line terminator. */
export function splitLines(text: string): string[] {
  return text.split(LINE_TERMINATORS);
}

/** `value` collapsed to one line: no terminator survives. */
export function singleLine(value: string): string {
  return value.replace(ANY_BREAK_OR_SPACE, ' ').trim();
}

/**
 * `text`, cut to `max` when given, as quoted lines: each prefixed `> `, an
 * empty one `>`. Leading and trailing blank lines are dropped.
 */
export function quotedLines(
  text: string,
  max?: number,
  marker?: string,
): string[] {
  const trimmed = text.trim();
  const bounded = max === undefined ? trimmed : cutText(trimmed, max, marker);
  return splitLines(bounded).map((line) =>
    line.length === 0 ? '>' : `> ${line}`,
  );
}

/**
 * One quoted line: `text` collapsed to a single line and prefixed `> `. With
 * `max`, the whole line, prefix included, is at most `max` long.
 */
export function quotedLine(text: string, max?: number): string {
  const line = singleLine(text);
  return `> ${max === undefined ? line : cutText(line, Math.max(0, max - 2))}`;
}

/** Terminal escape sequences: CSI, OSC (to BEL or ST) and single-character escapes. */
const ESCAPE_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing terminal escapes is the point.
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/gu;
/** C0 and C1 controls, zero-width characters and bidirectional overrides. */
const INVISIBLE_OR_CONTROL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing controls is the point.
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/**
 * A short label someone else supplied (another Station's name or origin
 * chain), with terminal escapes, controls, zero-width and bidi characters
 * removed and collapsed to one line. May be `''`: a caller refuses that.
 */
export function cleanLabel(text: string): string {
  return singleLine(
    text.replace(ESCAPE_SEQUENCE, '').replace(INVISIBLE_OR_CONTROL, ''),
  );
}

/**
 * `label` within `fits`, keeping its END: an origin chain names its latest,
 * verified hop last, so any cut falls on the earlier, unverified ones.
 */
export function boundLabelKeepingTail(
  label: string,
  fits: (candidate: string) => boolean,
): string {
  if (fits(label)) return label;
  const characters = [...label];
  let tail = '';
  for (let index = characters.length - 1; index >= 0; index--) {
    const next = `${characters[index]}${tail}`;
    if (!fits(`…${next}`)) break;
    tail = next;
  }
  return `…${tail}`;
}
