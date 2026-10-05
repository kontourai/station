/**
 * How untrusted engine or model text is shown on a one-line surface: a
 * transcript row's label, an approval toast, an inbox notification, a button.
 *
 * The text a person is asked to approve must read the same on every surface
 * that shows it, so every surface goes through these helpers. The raw value is
 * never changed: the call's arguments, and the details views that print them,
 * keep the text exactly as the engine sent it.
 */

/**
 * Characters that change how text reads without being seen, removed from
 * every displayed form: bidi marks, embeddings, overrides and isolates (ALM
 * U+061C, LRM, RLM, U+202A–202E, U+2066–2069), so shown text cannot reorder
 * ("Trojan source"); and the invisible characters that can hide or smuggle
 * text: soft hyphen, zero-width space, word joiner and invisible operators
 * (U+2060–2064), BOM, and tag characters (U+E0000–E007F); and the fillers
 * that draw as blank space without being whitespace, so they cannot push a
 * command's tail out of view: CGJ (U+034F), Hangul fillers (U+115F, U+1160,
 * U+3164, U+FFA0), Mongolian variation selectors (U+180B–180F), the blank
 * braille pattern (U+2800), and variation selectors (U+FE00–FE0F,
 * U+E0100–E01EF), except VS15/VS16 after an emoji, which choose how it is
 * drawn. ZWJ and ZWNJ are kept: emoji and several scripts need them, and
 * they cannot hide a word.
 */
const INVISIBLE_FORMAT =
  /[\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]|[\u115F\u1160\u2800\u3164\uFFA0]|\u034F|[\u180B-\u180F]|[\uFE00-\uFE0D]|[\u{E0100}-\u{E01EF}]|(?<!\p{Emoji})(?:\uFE0E|\uFE0F)/gu;

/** C0, DEL and C1 controls. Replaced by a space, not deleted, so "a\u0085b"
 * does not merge into one word. */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * The line breaks a shown value is split on: CRLF as one break, then LF, CR,
 * LINE SEPARATOR and PARAGRAPH SEPARATOR. Splitting on all of them, on every
 * surface, is what makes "how many lines is this" one answer: before, a
 * command split by CR or U+2028 showed whole on one line while one split by
 * LF showed only its first line. Other controls (NEL, BEL, ...) are not
 * breaks; `displayText` turns them into spaces.
 */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/u;

/**
 * The displayed form of untrusted text: invisible format characters
 * (`INVISIBLE_FORMAT`) removed, control characters turned into spaces,
 * whitespace collapsed onto one trimmed line.
 */
export function displayText(value: string): string {
  return value
    .replace(INVISIBLE_FORMAT, '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The lines of a value that show anything, as written (not sanitised). A line
 * that is blank once displayed (whitespace, controls or bidi marks only) is
 * dropped: it cannot hide a command, and counting it would overstate what is
 * not shown.
 */
export function displayLines(value: string): string[] {
  return value.split(LINE_BREAK).filter((line) => displayText(line) !== '');
}

/** What joins the lines of a value shown whole on one line. */
export const DISPLAY_LINE_SEPARATOR = ' ⏎ ';

/**
 * A multi-line value shown whole on one line: each line in `displayText`
 * form, joined by ` ⏎ `, not by a space. Joined by a space, `echo a` and
 * `rm -rf /` read as one `echo` printing `a rm -rf /`.
 */
export function displayJoinedLines(value: string): string {
  return displayLines(value).map(displayText).join(DISPLAY_LINE_SEPARATOR);
}

/**
 * The marker for lines a surface does not show: "(+1 line)", "(+3 lines)".
 * Empty for none.
 */
export function hiddenLinesMarker(hidden: number): string {
  if (hidden <= 0) return '';
  return `(+${hidden} ${hidden === 1 ? 'line' : 'lines'})`;
}

/**
 * Cut to at most `max` code points, ending in "…" when anything was cut. By
 * code point, so an emoji at the cut is never split into a lone surrogate.
 * Does not sanitise: pass `displayText` output.
 */
export function truncateDisplay(value: string, max: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= max) return value;
  return `${codePoints.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** The length of a value in code points, the unit `truncateDisplay` cuts in. */
export function displayLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** Controls other than the line breaks `displayLines` splits on. */
const NON_BREAK_CONTROLS = /[^\P{Cc}\n\r]/gu;
/** Runs of whitespace that do not break a line. */
const INLINE_WHITESPACE = /[^\S\n\r\u2028\u2029]+/gu;
/** Runs of line breaks, with the spaces around them. */
const LINE_BREAK_RUNS = / ?(?:(?:\r\n|[\n\r\u2028\u2029]) ?)+/gu;

/**
 * A value with its padding taken out, keeping its lines: invisible format
 * characters removed, controls turned into spaces, every run of spaces made
 * one space and every run of blank lines one LF. Linear, so it runs on the
 * whole unbounded value before a coarse cut: 5000 spaces or 5000 RLOs
 * between `echo a` and `; rm -rf /` can then not push the second command past
 * the cut, which they did when padding was only collapsed after it. What a
 * line says is unchanged; only `displayText` would change it further.
 */
export function compactDisplaySource(value: string): string {
  return value
    .replace(INVISIBLE_FORMAT, '')
    .replace(NON_BREAK_CONTROLS, ' ')
    .replace(INLINE_WHITESPACE, ' ')
    .replace(LINE_BREAK_RUNS, '\n');
}

/**
 * Lines already in display form, shown whole on one line (joined by
 * `DISPLAY_LINE_SEPARATOR`) within `max` code points.
 *
 * - Anything cut ends in "…". `truncated` says the lines themselves are
 *   already a cut of a longer value, so "…" is added even when they fit.
 * - When lines go unshown (cut off here, or past `totalLines`), "(+N lines)"
 *   follows, inside `max`: room for the widest marker the value can need is
 *   reserved first, so the marker can never push the text past the bound.
 * - A line counts as shown when its first character is shown.
 */
export function boundedJoinedLines(
  lines: readonly string[],
  max: number,
  options: { truncated?: boolean; totalLines?: number } = {},
): string {
  const total = Math.max(options.totalLines ?? lines.length, lines.length);
  const truncated = options.truncated === true;
  const joined = lines.join(DISPLAY_LINE_SEPARATOR);
  const length = displayLength(joined);
  if (!truncated && total === lines.length && length <= max) return joined;
  const reserve =
    total > 1 ? displayLength(` ${hiddenLinesMarker(total - 1)}`) : 0;
  const budget = Math.max(1, max - reserve);
  let shown: string;
  let visible: number;
  if (length <= budget - 1 || (!truncated && length <= budget)) {
    shown = truncated ? `${joined}…` : joined;
    visible = length;
  } else {
    visible = budget - 1;
    // Trailing spaces before the "…" would only push it away from the text.
    shown = `${Array.from(joined).slice(0, visible).join('').trimEnd()}…`;
  }
  const marker = hiddenLinesMarker(total - linesStartedWithin(lines, visible));
  return marker ? `${shown} ${marker}` : shown;
}

/**
 * Untrusted text in display form that keeps its line breaks, for a surface
 * that can show more than one line (a notification body, an OS
 * notification): each line in `displayText` form, blank lines dropped,
 * joined by LF.
 */
export function displayMultilineText(value: string): string {
  return displayLines(value).map(displayText).join('\n');
}

/**
 * Untrusted text shown on one line next to a decision: its lines in display
 * form, joined and bounded by `boundedJoinedLines`. The one call for a title
 * or body that arrives raw (a stored notification, a request title).
 */
export function boundedDisplayText(value: string, max: number): string {
  const lines = displayLines(value).map(displayText);
  const joined = lines.join(DISPLAY_LINE_SEPARATOR);
  // Text that already says how many lines it hides (a Codex approval title,
  // stored as a notification title) keeps saying so when it is cut again.
  const marker = TRAILING_LINES_MARKER.exec(joined);
  if (!marker || displayLength(joined) <= max) {
    return boundedJoinedLines(lines, max);
  }
  const head = joined.slice(0, marker.index);
  const room = Math.max(1, max - displayLength(marker[0]));
  return `${boundedJoinedLines([head], room, { truncated: true })}${marker[0]}`;
}

/** A " (+N lines)" marker (`hiddenLinesMarker`) ending a value. */
const TRAILING_LINES_MARKER = / \(\+\d+ lines?\)$/;

/** How many of `lines`, joined by `DISPLAY_LINE_SEPARATOR`, have their first
 * character within the first `visible` code points. */
function linesStartedWithin(lines: readonly string[], visible: number): number {
  const separator = displayLength(DISPLAY_LINE_SEPARATOR);
  let offset = 0;
  let started = 0;
  for (const line of lines) {
    if (offset >= visible) break;
    started += 1;
    offset += displayLength(line) + separator;
  }
  return started;
}

/**
 * Characters a raw view must not apply or hide: everything `displayText`
 * removes (`INVISIBLE_FORMAT`), ZWNJ, a ZWJ that is not joining two emoji
 * (inside an emoji sequence it is how the emoji is drawn, so it stays), and
 * every C0/C1 control but LF and tab, which a raw view shows as the line
 * break and spacing they are.
 */
const HIDDEN_CHARACTERS =
  /[\u00AD\u061C\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]|[\u115F\u1160\u2800\u3164\uFFA0]|\u034F|[\u180B-\u180F]|[\uFE00-\uFE0D]|[\u{E0100}-\u{E01EF}]|(?<!\p{Emoji})(?:\uFE0E|\uFE0F)|[^\P{Cc}\n\t]|(?<!\p{Extended_Pictographic}|\u{FE0F}|[\u{1F3FB}-\u{1F3FF}])\u200D|\u200D(?!\p{Extended_Pictographic})/gu;

/** One run of a raw value: text shown as written, or a hidden character
 * shown as its token (`hiddenCharacterToken`). */
export type RevealedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'hidden'; codePoint: number; token: string; name: string };

/** "«U+202E»": how a raw view shows a hidden character. Guillemets, not
 * angle brackets: they cannot be read as shell redirection, and the bundled
 * Latin-1 font subset draws them. */
export function hiddenCharacterToken(codePoint: number): string {
  return `«U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}»`;
}

const HIDDEN_CHARACTER_NAMES: Readonly<Record<number, string>> = {
  173: 'soft hyphen',
  847: 'combining grapheme joiner',
  4447: 'Hangul filler',
  4448: 'Hangul filler',
  10240: 'blank braille pattern',
  12644: 'Hangul filler',
  65440: 'Hangul filler',
  1564: 'arabic letter mark',
  8203: 'zero-width space',
  8204: 'zero-width non-joiner',
  8205: 'zero-width joiner',
  8206: 'left-to-right mark',
  8207: 'right-to-left mark',
  8234: 'left-to-right embedding',
  8235: 'right-to-left embedding',
  8236: 'pop directional formatting',
  8237: 'left-to-right override',
  8238: 'right-to-left override',
  8288: 'word joiner',
  8289: 'function application',
  8290: 'invisible times',
  8291: 'invisible separator',
  8292: 'invisible plus',
  8294: 'left-to-right isolate',
  8295: 'right-to-left isolate',
  8296: 'first strong isolate',
  8297: 'pop directional isolate',
  65279: 'zero-width no-break space',
};

function hiddenCharacterName(codePoint: number): string {
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return 'tag character';
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  )
    return 'variation selector';
  if (codePoint >= 0x180b && codePoint <= 0x180f)
    return 'Mongolian variation selector';
  return HIDDEN_CHARACTER_NAMES[codePoint] ?? 'control character';
}

/**
 * A raw value split so that a view can show it exactly as written EXCEPT for
 * the characters that would change what it looks like without being seen
 * (`HIDDEN_CHARACTERS`): each of those becomes its own segment, to be shown
 * as a visible token instead of being applied. Joining the segments' `text`
 * and `token` gives the value in logical order, so a right-to-left override
 * cannot make `echo done` read `echo enod`. Line breaks, tabs, spaces and all
 * other text are untouched.
 */
export function revealHiddenCharacters(value: string): RevealedSegment[] {
  const segments: RevealedSegment[] = [];
  let last = 0;
  for (const match of value.matchAll(HIDDEN_CHARACTERS)) {
    const index = match.index ?? 0;
    if (index > last) {
      segments.push({ kind: 'text', text: value.slice(last, index) });
    }
    const codePoint = match[0].codePointAt(0)!;
    segments.push({
      kind: 'hidden',
      codePoint,
      token: hiddenCharacterToken(codePoint),
      name: hiddenCharacterName(codePoint),
    });
    last = index + match[0].length;
  }
  if (last < value.length) {
    segments.push({ kind: 'text', text: value.slice(last) });
  }
  return segments;
}

/** Whether `revealHiddenCharacters` would reveal anything in `value`. */
export function hasHiddenCharacters(value: string): boolean {
  HIDDEN_CHARACTERS.lastIndex = 0;
  const found = HIDDEN_CHARACTERS.test(value);
  HIDDEN_CHARACTERS.lastIndex = 0;
  return found;
}

/** `revealHiddenCharacters` as one string, for a server-side or plain-text
 * raw view. */
export function revealHiddenCharactersText(value: string): string {
  return revealHiddenCharacters(value)
    .map((segment) => (segment.kind === 'text' ? segment.text : segment.token))
    .join('');
}
