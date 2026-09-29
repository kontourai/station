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

export function terminalSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => terminalSafeText(character),
  );
}
