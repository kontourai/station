/**
 * String order by Unicode code point, which is the order SQLite's default
 * BINARY collation gives UTF-8 text. JavaScript's `<` compares UTF-16 code
 * units instead, and the two disagree for characters above U+FFFF against
 * U+E000..U+FFFF. Every adapter must order keys and timestamps the same way.
 */
export function compareCodePoints(left: string, right: string): number {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  for (;;) {
    const x = a.next();
    const y = b.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}
