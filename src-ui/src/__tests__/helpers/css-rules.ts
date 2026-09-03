/**
 * Reading declarations out of a stylesheet by selector, for the tests that
 * assert stacking and geometry contracts against the CSS source.
 *
 * It exists because those tests looked for a block whose selector list was
 * EXACTLY the selector — `.chat-dock {` — and archive#3929 consolidated the
 * dock's shared geometry into `:is(.chat-dock, .dock-slot) {` so that one
 * placement is stated once instead of twice. The declarations still reach
 * `.chat-dock`; the tests simply could not see them, and reported a missing
 * `z-index` on a dock that has one.
 *
 * The widening is deliberately narrow: an `:is` list naming the selector,
 * and nothing else. A rule that merely MENTIONS the selector somewhere in its
 * list — `.app__main:has(> [data-region="right"]) > .banner-host` — is a rule
 * about the banner host, and treating it as a dock rule would be a worse
 * error than the one this fixes.
 */

/**
 * Selectors wrap across lines in this stylesheet, so every comparison is on
 * whitespace-normalised text — otherwise a rule the caller names with single
 * spaces never matches the same rule as the file happens to have wrapped it.
 */
const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');

/**
 * Split a selector list on its TOP-LEVEL commas. A naive split cuts
 * `:is(.chat-dock, .dock-slot)` in half and neither piece matches anything —
 * which is the bug that made the first version of this helper find no rule at
 * all for the selector it was consolidating around.
 */
function splitSelectorList(list: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const char = list[i];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) {
      entries.push(list.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(list.slice(start));
  return entries;
}

/** A selector list entry targets `selector` when it IS it, or `:is(…)` it. */
function entryTargets(entry: string, selector: string): boolean {
  const wanted = normalize(selector);
  const trimmed = normalize(entry);
  if (trimmed === wanted) return true;
  const isList = /^:is\((.*)\)$/.exec(trimmed);
  if (!isList) return false;
  return splitSelectorList(isList[1]).some(
    (part) => normalize(part) === wanted,
  );
}

/**
 * Every rule body whose selector list targets `selector`, in source order.
 * Media-query nesting is included, matching what these callers already read.
 */
export function ruleBodiesFor(css: string, selector: string): string[] {
  const bodies: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // Everything between the previous `}` and this `{` — which includes any
    // comment sitting above the rule, and a section banner comment is enough
    // to stop `.settings__save-pill` matching itself. Comments are stripped
    // from the SELECTOR text only; rule bodies keep theirs, because callers
    // assert on what those comments say.
    const list = match[1].replace(/\/\*[\s\S]*?\*\//g, '');
    // An at-rule prelude is not a selector list.
    if (list.trimStart().startsWith('@')) continue;
    if (splitSelectorList(list).some((entry) => entryTargets(entry, selector)))
      bodies.push(match[2]);
  }
  return bodies;
}
