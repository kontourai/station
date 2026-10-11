/**
 * How a RAW view of untrusted text (a pending tool call's command and
 * arguments) shows the characters that would change what it looks like
 * without being seen: as visible «U+XXXX» tokens, never applied (#3382).
 *
 * Split from `display-text` so a surface can load it only with its raw view:
 * the one-line display form is needed on first paint, this is not.
 */

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
