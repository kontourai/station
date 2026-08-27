/**
 * Deterministic development-only expansion. Interpolation tokens deliberately
 * pass through unchanged: a pseudo locale must exercise the surrounding layout
 * without changing the named values a caller supplies.
 */
const ACCENTED: Record<string, string> = {
  a: 'à',
  b: 'ƀ',
  c: 'ç',
  d: 'đ',
  e: 'ē',
  f: 'ƒ',
  g: 'ğ',
  h: 'ħ',
  i: 'ī',
  j: 'ĵ',
  k: 'ķ',
  l: 'ľ',
  m: 'ḿ',
  n: 'ñ',
  o: 'ō',
  p: 'ƥ',
  q: 'ɋ',
  r: 'ř',
  s: 'ş',
  t: 'ŧ',
  u: 'ū',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ŷ',
  z: 'ž',
};

function pseudoText(text: string): string {
  const expanded = text.replace(/[a-z]/gi, (letter) => {
    const lower = ACCENTED[letter.toLowerCase()] ?? letter;
    return letter === letter.toUpperCase() ? lower.toUpperCase() : lower;
  });
  const padding = '~'.repeat(Math.max(1, Math.ceil(text.length * 0.35)));
  return `［${expanded}${padding}］`;
}

export function pseudoLocalize(message: string): string {
  return message
    .split(/(\{[a-zA-Z][a-zA-Z0-9_]*\})/g)
    .map((part) =>
      /^\{[a-zA-Z][a-zA-Z0-9_]*\}$/.test(part) ? part : pseudoText(part),
    )
    .join('');
}
