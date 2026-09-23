/**
 * A JavaScript string literal for a value Station embeds in a script it
 * evaluates in the page (CDP `Runtime.evaluate`). `JSON.stringify` alone is a
 * valid literal there, but it leaves `<`, `>`, `/` and the line separators
 * U+2028/U+2029 raw, which break out of the literal if the script is ever
 * embedded in HTML or read by a pre-ES2019 parser. Escaping them keeps the
 * literal inert in every context, and is the form CodeQL's
 * `js/bad-code-sanitization` recognises.
 */
const UNSAFE_IN_CODE: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

export function jsStringLiteral(value: string): string {
  return JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/g,
    (char) => UNSAFE_IN_CODE[char] ?? char,
  );
}
