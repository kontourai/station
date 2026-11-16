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
/**
 * What a label must not carry. The goal is to stop line injection, terminal
 * escapes and visual reordering, not to strip the joiners scripts and emoji
 * need: controls (Cc, after line breaks became spaces), bidi embedding,
 * override and isolate controls, the Arabic letter mark, soft hyphen,
 * zero-width spaces and invisible operators, the BOM, interlinear annotation
 * marks, Hangul and Mongolian fillers and the combining grapheme joiner.
 * ZWJ/ZWNJ, variation selectors and the LRM/RLM weak marks stay: they cannot
 * reorder runs the way overrides do. Tag characters are handled below.
 */
const UNSAFE_IN_LABEL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing controls is the point.
  /[\p{Cc}\u202A-\u202E\u2066-\u2069\u061C\u00AD\u200B\u2060-\u2064\uFEFF\uFFF9-\uFFFB\u115F\u1160\u3164\uFFA0\u180E]|\u034F/gu;
/**
 * An emoji tag sequence (a flag such as Scotland's) keeps its tag
 * characters; any other tag character is dropped.
 */
const TAG_SEQUENCE_OR_TAG =
  /(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\u{E0000}-\u{E007F}]/gu;
/** Kept marks that are not a name on their own. */
const ONLY_JOINERS_OR_MARKS = /^(?:[\s\u200C-\u200F]|[\uFE00-\uFE0F])*$/u;

/**
 * A short label someone else supplied (another Station's name, origin chain
 * or conversation title), with terminal escapes and unsafe invisible
 * characters removed and collapsed to one line. `''` when nothing visible is
 * left, including a label of only joiners or marks: a caller refuses or
 * replaces that.
 */
export function cleanLabel(text: string): string {
  const cleaned = singleLine(
    singleLine(text.replace(ESCAPE_SEQUENCE, ''))
      .replace(UNSAFE_IN_LABEL, '')
      .replace(
        TAG_SEQUENCE_OR_TAG,
        (_tag, sequence?: string) => sequence ?? '',
      ),
  );
  return ONLY_JOINERS_OR_MARKS.test(cleaned) ? '' : cleaned;
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
  // Whole graphemes only: a cut never splits a flag, an emoji sequence or a
  // letter from its combining marks.
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      label,
    ),
  ].map((segment) => segment.segment);
  let tail = '';
  for (let index = graphemes.length - 1; index >= 0; index--) {
    const next = `${graphemes[index]}${tail}`;
    if (!fits(`…${next}`)) break;
    tail = next;
  }
  return `…${tail}`;
}
