/**
 * Text a terminal renders from untrusted sources (a Station's error text, a
 * device name): control, format and separator characters are escaped so a
 * compromised or failed peer cannot write into the operator's terminal.
 * Shared by the environment and device-access commands.
 */
export function terminalSafeText(value: string): string {
  return Array.from(value, (character) => {
    if (!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) return character;
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0xffff) {
      return `\\u${codePoint.toString(16).padStart(4, '0')}`;
    }
    const offset = codePoint - 0x10000;
    const high = 0xd800 + (offset >> 10);
    const low = 0xdc00 + (offset & 0x3ff);
    return `\\u${high.toString(16)}\\u${low.toString(16)}`;
  }).join('');
}

// Format characters (`Cf`) include the zero-width joiner, so an emoji
// sequence joined by one comes apart: safety over emoji fidelity, since the
// same class carries the bidi overrides that can disguise text.
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Controls and separators that break text rather than hide it: tab, line and page breaks. */
const WHITESPACE_CONTROL = /[\t\n\v\f\r\u0085\u2028\u2029]/u;

function codeIn(character: string | undefined, low: number, high: number) {
  const code = character?.codePointAt(0);
  return code !== undefined && code >= low && code <= high;
}

/** The index just past the escape sequence that starts at `start`. */
function escapeEnd(characters: readonly string[], start: number): number {
  const introducer = characters[start];
  let index = start + 1;
  // CSI: `ESC [` or the C1 `CSI`, parameters, intermediates, one final byte.
  const csi = introducer === '\u009b' || characters[index] === '[';
  if (csi) {
    if (introducer !== '\u009b') index += 1;
    while (codeIn(characters[index], 0x30, 0x3f)) index += 1;
    while (codeIn(characters[index], 0x20, 0x2f)) index += 1;
    return codeIn(characters[index], 0x40, 0x7e) ? index + 1 : index;
  }
  // OSC (a title, a hyperlink): up to BEL or `ESC \`.
  if (characters[index] === ']') {
    index += 1;
    while (index < characters.length) {
      if (characters[index] === '\u0007') return index + 1;
      if (characters[index] === '\u001b' && characters[index + 1] === '\\')
        return index + 2;
      index += 1;
    }
    return index;
  }
  // Any other two-character escape.
  return codeIn(characters[index], 0x40, 0x5f) ? index + 1 : index;
}

/**
 * Text with terminal escape sequences (CSI such as `ESC[2J`, OSC such as a
 * title or hyperlink, other two-character escapes) removed, each run of
 * tabs, line and page breaks between visible text replaced by one space
 * (and dropped at either end), and every other control, format and
 * separator character removed, for text shown where an escaped `\u001b`
 * would itself be noise. Unlike {@link terminalSafeText}, nothing of a
 * removed sequence remains.
 */
export function stripTerminalControls(value: string): string {
  const characters = Array.from(value);
  let text = '';
  let pendingSpace = false;
  let index = 0;
  while (index < characters.length) {
    const character = characters[index];
    if (character === '\u001b' || character === '\u009b') {
      index = escapeEnd(characters, index);
      continue;
    }
    if (WHITESPACE_CONTROL.test(character)) pendingSpace = text !== '';
    else if (!CONTROL_CHARACTER.test(character)) {
      if (pendingSpace && !text.endsWith(' ')) text += ' ';
      pendingSpace = false;
      text += character;
    }
    index += 1;
  }
  return text;
}

export function terminalSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => terminalSafeText(character),
  );
}
