/**
 * Every declaration in a stylesheet as `{ property, value }`. Comments and
 * quoted strings are blanked first so neither a commented-out rule nor a
 * `url("#id")` reads as a value. A selector never counts: it ends at `{`,
 * and only text ending at `;` or `}` is a declaration.
 */
export function cssDeclarations(source, { positions = false } = {}) {
  const blank = (text) => text.replace(/[^\r\n]/g, ' ');
  const css = source
    .replace(/\/\*[\s\S]*?\*\//g, positions ? blank : ' ')
    .replace(
      /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
      positions ? blank : '""',
    );
  const declarations = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const char = css[i];
    if (char !== '{' && char !== '}' && char !== ';') continue;
    const raw = css.slice(start, i);
    const segment = raw.trim();
    const offset = start + raw.length - raw.trimStart().length;
    start = i + 1;
    if (char === '{' || !segment || segment.startsWith('@')) continue;
    const colon = segment.indexOf(':');
    if (colon <= 0) continue;
    declarations.push({
      property: segment.slice(0, colon).trim().toLowerCase(),
      value: segment.slice(colon + 1).trim(),
      ...(positions && {
        offset,
        end: i - (raw.length - raw.trimEnd().length),
      }),
    });
  }
  return declarations;
}
