// Pure helpers for scripts/ui-glyph-coverage-ratchet.mjs — split out so the
// comment strippers, the `unicode-range` parser and the allowlist reconciler
// can be unit-tested directly. See the ratchet's header for what the gate
// does and does not prove.

import ts from 'typescript';

/**
 * The floor the inventory starts at. Below U+2000 the bundled latin /
 * latin-ext subsets cover everything the UI plausibly draws (the ranges run
 * U+0000-00FF and U+0100-02FF), and every codepoint in between that is NOT
 * covered is a diacritic or an IPA letter that only reaches the DOM inside
 * user content, which has always had unbounded fallback. #1649 measured the
 * inventory from U+2000 up; keeping the same floor keeps the number in the
 * issue and the number this gate prints comparable.
 */
export const INVENTORY_FLOOR = 0x2000;

/* ── unicode-range parsing ─────────────────────────────────────────────── */

/**
 * Parse every `unicode-range` declaration out of a CSS text into a flat list
 * of `{ start, end }` intervals, plus the number of declarations seen.
 *
 * The ranges are UNIONED across every @font-face. That is the right question
 * for "can a bundled face draw this codepoint at all", and it is exactly
 * right today because all four faces in `src-ui/src/fonts.css` declare
 * byte-identical ranges. It would be too generous if some future face
 * declared a NARROWER range than another — a codepoint covered only by the
 * mono face would read as covered for sans text too. `assertCoverageIntegrity`
 * does not catch that; a face declaring its own narrow range is the moment to
 * revisit this function.
 */
export function parseUnicodeRanges(css) {
  const declarations = [];
  // `unicode-range:` up to the terminating `;`. CSS comments are stripped
  // first so a commented-out declaration cannot widen the covered set.
  const source = stripCssComments(css);
  const declarationPattern = /unicode-range\s*:\s*([^;}]+)[;}]/gi;
  let match = declarationPattern.exec(source);
  while (match) {
    declarations.push(match[1]);
    match = declarationPattern.exec(source);
  }

  const ranges = [];
  for (const declaration of declarations) {
    for (const token of declaration.split(',')) {
      const range = parseUnicodeRangeToken(token.trim());
      if (range) ranges.push(range);
    }
  }
  return { ranges, declarationCount: declarations.length };
}

/**
 * One `U+...` token. Handles the three CSS forms: a single codepoint
 * (`U+2014`), an interval (`U+0100-02BA`) and a wildcard (`U+25??`).
 */
export function parseUnicodeRangeToken(token) {
  const single = /^u\+([0-9a-f]{1,6})$/i.exec(token);
  if (single) {
    const value = Number.parseInt(single[1], 16);
    return { start: value, end: value };
  }
  const interval = /^u\+([0-9a-f]{1,6})-([0-9a-f]{1,6})$/i.exec(token);
  if (interval) {
    return {
      start: Number.parseInt(interval[1], 16),
      end: Number.parseInt(interval[2], 16),
    };
  }
  const wildcard = /^u\+([0-9a-f]{0,5})(\?{1,6})$/i.exec(token);
  if (wildcard && wildcard[1].length + wildcard[2].length <= 6) {
    const low = `${wildcard[1]}${'0'.repeat(wildcard[2].length)}`;
    const high = `${wildcard[1]}${'F'.repeat(wildcard[2].length)}`;
    return {
      start: Number.parseInt(low, 16),
      end: Number.parseInt(high, 16),
    };
  }
  return null;
}

export function isCovered(ranges, codepoint) {
  return ranges.some(
    (range) => codepoint >= range.start && codepoint <= range.end,
  );
}

/**
 * Refuse to run against a covered set that cannot be right. A parse that
 * silently produced nothing would flood the report; a parse that produced a
 * wildcard-wide set would make the gate vacuously green, which is the failure
 * mode worth being loud about (station#1559 class).
 */
export function assertCoverageIntegrity({ ranges, declarationCount }) {
  if (declarationCount < 4) {
    throw new Error(
      `ui-glyph-coverage: parsed ${declarationCount} unicode-range declaration(s) from src-ui/src/fonts.css, expected at least 4 (one per bundled @font-face). The parser has stopped tracking the file it exists to track.`,
    );
  }
  // U+2014 EM DASH is in the bundled latin subset and is the single most
  // common non-Latin-1 codepoint in the UI. If it is not covered, the parse
  // produced garbage rather than a range set.
  if (!isCovered(ranges, 0x2014)) {
    throw new Error(
      'ui-glyph-coverage: parsed ranges do not cover U+2014 (—), which the bundled latin subset declares. The unicode-range parse is broken.',
    );
  }
  const total = ranges.reduce(
    (sum, range) => sum + (range.end - range.start + 1),
    0,
  );
  if (total > 20000) {
    throw new Error(
      `ui-glyph-coverage: parsed ranges cover ${total} codepoints, far more than the bundled latin + latin-ext subsets (~2k). A wildcard or malformed token has widened the covered set into a vacuous green.`,
    );
  }
}

/* ── comment stripping ─────────────────────────────────────────────────── */

/**
 * Replace `[start, end)` with spaces, preserving newlines so every later
 * line/column is still the line/column in the original file.
 */
function blank(text, start, end) {
  let out = '';
  for (let index = start; index < end; index += 1) {
    out += text[index] === '\n' ? '\n' : ' ';
  }
  return out;
}

function applyBlanks(text, spans) {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((left, right) => left.start - right.start);
  let out = '';
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue; // already inside a blanked span
    out += text.slice(cursor, span.start);
    out += blank(text, span.start, span.end);
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Comment spans inside `[start, end)`, a region the parser has already told
 * us contains nothing but trivia: whitespace and comments. Because there are
 * no string, template or regex literals in a trivia region, this scan cannot
 * mistake a `//` in a URL for a comment — the parser decided that question
 * before we got here, by deciding where the region ends.
 */
function scanTriviaComments(text, start, end) {
  const spans = [];
  let index = start;
  while (index < end) {
    if (text[index] === '/' && text[index + 1] === '/') {
      let stop = index + 2;
      while (stop < end && text[stop] !== '\n' && text[stop] !== '\r')
        stop += 1;
      spans.push({ start: index, end: stop });
      index = stop;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      const stop = close === -1 || close + 2 > end ? end : close + 2;
      spans.push({ start: index, end: stop });
      index = stop;
      continue;
    }
    index += 1;
  }
  return spans;
}

/**
 * Strip `//` and block comments from TypeScript / TSX.
 *
 * This asks the TypeScript parser where the comments are rather than pattern
 * matching, because every hazard here is a case where `//` or `/*` is NOT a
 * comment: inside a string literal, inside a URL in a string, inside a
 * template literal, inside a regex literal, and — the one a hand-rolled
 * scanner gets wrong most often — inside a JSX text node, where `//` is
 * ordinary rendered text. The parser knows which is which; a scanner run in
 * the wrong lexical mode does not.
 *
 * The mechanism is deliberately NOT `ts.getLeadingCommentRanges` at each
 * token: that helper only accumulates comments once it has crossed a newline
 * (or at position 0), so it silently drops every same-line comment —
 * `foo(); // ...` and an inline block comment on an assignment both
 * survive it. Instead each
 * token's trivia region `[getFullStart(), getStart())` is scanned directly.
 * A trivia region contains only whitespace and comments by construction, so
 * the scan inside it is unambiguous.
 *
 * The one comment position that is not token trivia is a JSX expression
 * container holding nothing but a comment, where the parser
 * reports the close brace as starting at the open brace's end. Those are
 * handled explicitly; missing them left 110 box-drawing characters looking
 * like rendered chrome while this was being written.
 *
 * Comments are blanked rather than deleted so reported line numbers are the
 * line numbers a reader will find in the file.
 */
export function stripTsComments(text, fileName = 'input.tsx') {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const spans = [];
  const visit = (node) => {
    if (
      ts.isJsxExpression(node) &&
      !node.expression &&
      node.end - node.pos >= 2
    ) {
      // `{` … `}` with no expression: everything between the braces is trivia.
      spans.push(...scanTriviaComments(text, node.pos + 1, node.end - 1));
    }
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      // JSX text is literal rendered content, not code: `//` in it is two
      // slashes the user reads, and it has no trivia region of its own.
      if (
        node.kind !== ts.SyntaxKind.JsxText &&
        node.kind !== ts.SyntaxKind.JsxTextAllWhiteSpaces
      ) {
        spans.push(
          ...scanTriviaComments(
            text,
            node.getFullStart(),
            node.getStart(sourceFile),
          ),
        );
      }
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sourceFile);

  return applyBlanks(text, spans);
}

/**
 * Strip CSS block comments.
 *
 * Deliberately hand-rolled and deliberately small, but it does track string
 * literals: a `content` value holding block-comment punctuation is text the
 * browser renders,
 * and a stripper that treated it as a comment would hide whatever glyph the
 * `content` declaration draws. `//` is NOT a comment in CSS and is left alone
 * (it appears in every `url(https://...)`).
 */
export function stripCssComments(text) {
  const spans = [];
  let index = 0;
  let stringDelimiter = null;
  while (index < text.length) {
    const char = text[index];
    if (stringDelimiter) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === stringDelimiter) stringDelimiter = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      stringDelimiter = char;
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      const end = close === -1 ? text.length : close + 2;
      spans.push({ start: index, end });
      index = end;
      continue;
    }
    index += 1;
  }
  return applyBlanks(text, spans);
}

export function stripComments(text, file) {
  if (file.endsWith('.css')) return stripCssComments(text);
  return stripTsComments(text, file);
}

/* ── inventory ─────────────────────────────────────────────────────────── */

/**
 * Every codepoint at or above {@link INVENTORY_FLOOR} in `text` that `ranges`
 * does not cover, with the 1-based line and column of each occurrence.
 * `text` is expected to have had comments blanked already.
 */
export function collectUncovered(text, ranges, file) {
  const findings = [];
  let line = 1;
  let column = 1;
  for (const char of text) {
    if (char === '\n') {
      line += 1;
      column = 1;
      continue;
    }
    const codepoint = char.codePointAt(0);
    if (codepoint >= INVENTORY_FLOOR && !isCovered(ranges, codepoint)) {
      findings.push({ file, line, column, codepoint, character: char });
    }
    column += 1;
  }
  return findings;
}

/**
 * True when the raw bytes of a file contain no uncovered codepoint at all.
 * A file that passes this cannot produce a finding after comment stripping
 * either (stripping only removes characters), so it can be skipped without
 * parsing — which is what keeps the gate off the TypeScript parser for the
 * ~1,900 files that have nothing to say.
 */
export function hasCandidateCodepoint(text, ranges) {
  for (const char of text) {
    const codepoint = char.codePointAt(0);
    if (codepoint >= INVENTORY_FLOOR && !isCovered(ranges, codepoint)) {
      return true;
    }
  }
  return false;
}

export function formatCodepoint(codepoint) {
  return `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/* ── allowlist ─────────────────────────────────────────────────────────── */

/**
 * Validate the allowlist's own shape before trusting it. An entry whose
 * `character` does not decode to its `codepoint` is the failure that would
 * make the whole allowlist a label nothing computes: the reader sees a glyph
 * and a reason, and the gate is silently permitting a different codepoint.
 */
export function loadAllowlist(document) {
  const categories = document?.categories;
  if (!categories || typeof categories !== 'object') {
    throw new Error('ui-glyph-coverage: allowlist has no `categories` object.');
  }
  for (const [name, category] of Object.entries(categories)) {
    if (!category || typeof category.reason !== 'string' || !category.reason) {
      throw new Error(
        `ui-glyph-coverage: allowlist category "${name}" has no reason. Every category states why the codepoints under it may fall through to host fonts.`,
      );
    }
  }

  const entries = document?.codepoints;
  if (!Array.isArray(entries)) {
    throw new Error('ui-glyph-coverage: allowlist has no `codepoints` array.');
  }

  const byCodepoint = new Map();
  for (const entry of entries) {
    const parsed = parseUnicodeRangeToken(String(entry?.codepoint ?? ''));
    if (!parsed || parsed.start !== parsed.end) {
      throw new Error(
        `ui-glyph-coverage: allowlist entry has a malformed codepoint: ${JSON.stringify(entry?.codepoint)}. Use the single-codepoint form, e.g. "U+2318".`,
      );
    }
    const codepoint = parsed.start;
    if (
      typeof entry.character !== 'string' ||
      entry.character.codePointAt(0) !== codepoint ||
      [...entry.character].length !== 1
    ) {
      throw new Error(
        `ui-glyph-coverage: allowlist entry ${formatCodepoint(codepoint)} carries character ${JSON.stringify(entry.character)}, which is not that codepoint. The character is what a reader checks the reason against; it must be the codepoint it claims.`,
      );
    }
    if (!Object.hasOwn(categories, entry.category)) {
      throw new Error(
        `ui-glyph-coverage: allowlist entry ${formatCodepoint(codepoint)} has unknown category "${entry.category}". Known: ${Object.keys(categories).join(', ')}.`,
      );
    }
    if (byCodepoint.has(codepoint)) {
      throw new Error(
        `ui-glyph-coverage: allowlist lists ${formatCodepoint(codepoint)} twice.`,
      );
    }
    byCodepoint.set(codepoint, entry);
  }
  return byCodepoint;
}

/**
 * Reconcile the derived inventory against the allowlist.
 *
 * Two directions, both of which matter:
 * - `unlisted`: an uncovered codepoint nothing has accounted for. This is the
 *   gate's reason to exist.
 * - `stale`: an allowlist entry no occurrence justifies any more, because the
 *   last use was removed or because `fonts.css` grew to cover it. Leaving
 *   these behind is how an allowlist stops describing the product; #1704
 *   shrinks the `icon` category, and the shrink has to be visible.
 */
export function reconcile(findings, allowlist) {
  const unlisted = new Map();
  const used = new Set();
  for (const finding of findings) {
    if (allowlist.has(finding.codepoint)) {
      used.add(finding.codepoint);
      continue;
    }
    const bucket = unlisted.get(finding.codepoint) ?? [];
    bucket.push(finding);
    unlisted.set(finding.codepoint, bucket);
  }
  const stale = [...allowlist.keys()].filter(
    (codepoint) => !used.has(codepoint),
  );
  return { unlisted, stale, used };
}

/**
 * Fail if a file known to hold an uncovered codepoint has fallen out of the
 * scanned list. A pathspec that silently stops matching turns the gate into a
 * vacuous green, and a scope check that only asserts "the list is non-empty"
 * cannot see one entry disappear.
 */
export function assertScanScope(files, sentinels) {
  const missing = sentinels.filter((sentinel) => !files.includes(sentinel));
  if (missing.length > 0) {
    throw new Error(
      `ui-glyph-coverage scan scope is broken — sentinel file(s) not in the scanned list: ${missing.join(', ')}. Fix the pathspecs and the sentinels together; do not let the gate go vacuously green.`,
    );
  }
}
