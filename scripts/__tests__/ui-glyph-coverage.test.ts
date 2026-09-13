import { describe, expect, it } from 'vitest';
import {
  assertCoverageIntegrity,
  assertScanScope,
  collectUncovered,
  formatCodepoint,
  hasCandidateCodepoint,
  isCovered,
  loadAllowlist,
  parseUnicodeRanges,
  parseUnicodeRangeToken,
  reconcile,
  stripCssComments,
  stripTsComments,
} from '../lib/ui-glyph-coverage.mjs';

/**
 * Counting codepoints in a source tree is only a measurement of what the
 * product draws if the comment stripper is right. The filing that produced
 * #1649 got this wrong — it counted `// ── section ──` banner bytes as
 * rendered chrome and reported 3,929 box-drawing characters the UI draws zero
 * times. A stripper that is wrong in the other direction is worse: it makes
 * the gate authoritative and blind at the same time. These assert counts, not
 * that the function returns.
 */
describe('stripTsComments', () => {
  const uncoveredIn = (source: string, file = 'probe.tsx') =>
    [...stripTsComments(source, file)].filter(
      (character) => (character.codePointAt(0) ?? 0) >= 0x2000,
    );

  it('removes a line comment and its glyphs', () => {
    expect(uncoveredIn('// ── section ──\nconst a = 1;\n')).toEqual([]);
  });

  it('keeps a `//` inside a string literal', () => {
    expect(uncoveredIn("const a = 'a ⌘ // b ⌘ c';\n")).toEqual(['⌘', '⌘']);
  });

  it('keeps a `//` inside a URL, and everything after it on the line', () => {
    expect(
      uncoveredIn(
        "const url = 'https://example.test/x'; // ⌘\nconst b = '★';\n",
      ),
    ).toEqual(['★']);
  });

  it('removes a block comment spanning lines', () => {
    expect(uncoveredIn('/*\n ★ ⌘\n ⚙\n*/\nconst a = "●";\n')).toEqual(['●']);
  });

  it('keeps a template literal containing `//` and a block-comment opener', () => {
    expect(uncoveredIn('const t = `a // ★ /* ⌘ b`;\n')).toEqual(['★', '⌘']);
  });

  it('keeps JSX text, where `//` is two characters the user reads', () => {
    // A hand-rolled scanner run in expression mode reads `//` here as a
    // comment and silently deletes the rest of the line — including the ★.
    expect(uncoveredIn('const a = <p>see // here ★</p>;\n')).toEqual(['★']);
  });

  it('removes a JSX comment container, which is not token trivia', () => {
    // `{/* … */}`: the parser reports the close brace as starting at the open
    // brace's end, so this comment is not leading trivia of any token.
    // Missing this left 110 box-drawing characters looking like chrome.
    expect(uncoveredIn('const a = <p>{/* ── ⌘ ── */}x</p>;\n')).toEqual([]);
  });

  it('removes a same-line comment, which getLeadingCommentRanges drops', () => {
    // The helper only accumulates once it has crossed a newline, so both of
    // these survive it. This is the case that made the mechanism change.
    expect(uncoveredIn('const a = 1; // ★\nconst b = /* ⌘ */ 2;\n')).toEqual(
      [],
    );
  });

  it('keeps a regex literal containing comment punctuation', () => {
    expect(uncoveredIn('const r = /\\/\\/★/; const s = "⌘";\n')).toEqual([
      '★',
      '⌘',
    ]);
  });

  it('preserves line numbers so a finding points at the right line', () => {
    const stripped = stripTsComments('// ⌘\n// ⌘\nconst a = "★";\n');
    const [finding] = collectUncovered(stripped, [], 'probe.tsx');
    expect(finding).toMatchObject({ line: 3, character: '★' });
  });

  it('removes a trailing comment at end of file', () => {
    expect(uncoveredIn('const a = 1;\n// ★\n')).toEqual([]);
  });

  it('handles a .ts file, where `<` is not JSX', () => {
    expect(
      uncoveredIn('const a = 1 < 2; // ★\nconst b = "●";\n', 'probe.ts'),
    ).toEqual(['●']);
  });
});

describe('stripCssComments', () => {
  const uncoveredIn = (source: string) =>
    [...stripCssComments(source)].filter(
      (character) => (character.codePointAt(0) ?? 0) >= 0x2000,
    );

  it('removes a block comment', () => {
    expect(uncoveredIn('/* ── ★ ── */\n.a { color: red; }\n')).toEqual([]);
  });

  it('keeps a `content` value, which the browser renders', () => {
    expect(uncoveredIn('.a::after { content: "★"; }\n')).toEqual(['★']);
  });

  it('does not treat `//` as a comment — CSS has no line comments', () => {
    expect(
      uncoveredIn('.a { background: url(https://example.test/★.png); }\n'),
    ).toEqual(['★']);
  });

  it('does not start a comment inside a string', () => {
    expect(uncoveredIn('.a::after { content: "/* ★ */"; }\n')).toEqual(['★']);
  });

  it('survives an unterminated comment without swallowing nothing', () => {
    expect(uncoveredIn('.a {}\n/* ★ and no close\n')).toEqual([]);
  });
});

describe('parseUnicodeRanges', () => {
  const fontFace = (range: string) =>
    `@font-face { font-family: "X"; unicode-range: ${range}; }`;

  it('parses single codepoints, intervals and wildcards', () => {
    const { ranges } = parseUnicodeRanges(
      fontFace('U+2014, U+0100-02BA, U+25??'),
    );
    expect(isCovered(ranges, 0x2014)).toBe(true);
    expect(isCovered(ranges, 0x0150)).toBe(true);
    expect(isCovered(ranges, 0x25cf)).toBe(true);
    expect(isCovered(ranges, 0x2318)).toBe(false);
  });

  it('counts one declaration per @font-face', () => {
    const css = [fontFace('U+2014'), fontFace('U+2015')].join('\n');
    expect(parseUnicodeRanges(css).declarationCount).toBe(2);
  });

  it('ignores a commented-out declaration', () => {
    const css = `/* ${fontFace('U+0000-FFFF')} */\n${fontFace('U+2014')}`;
    const { ranges, declarationCount } = parseUnicodeRanges(css);
    expect(declarationCount).toBe(1);
    expect(isCovered(ranges, 0x2318)).toBe(false);
  });

  it('rejects a malformed token rather than guessing a range', () => {
    expect(parseUnicodeRangeToken('U+ZZZZ')).toBeNull();
    expect(parseUnicodeRangeToken('2014')).toBeNull();
  });

  it('matches the real fonts.css against a known-covered and known-uncovered pair', () => {
    // Both come from the corrected #1649 inventory: `—` is in the bundled
    // latin subset, `⌘` is in no bundled subset and no DM Sans subset exists
    // that carries it.
    const { ranges } = parseUnicodeRanges(
      [
        '@font-face { unicode-range: U+0000-00FF, U+2000-206F, U+2212; }',
        '@font-face { unicode-range: U+0100-02BA, U+2113; }',
      ].join('\n'),
    );
    expect(isCovered(ranges, 0x2014)).toBe(true);
    expect(isCovered(ranges, 0x2318)).toBe(false);
  });
});

describe('assertCoverageIntegrity', () => {
  const wide = [{ start: 0x0000, end: 0xffff }];
  const good = [
    { start: 0x0000, end: 0x00ff },
    { start: 0x2000, end: 0x206f },
  ];

  it('accepts a plausible parse', () => {
    expect(() =>
      assertCoverageIntegrity({ ranges: good, declarationCount: 4 }),
    ).not.toThrow();
  });

  it('fails when the parse found fewer declarations than fonts.css has', () => {
    expect(() =>
      assertCoverageIntegrity({ ranges: good, declarationCount: 1 }),
    ).toThrow(/stopped tracking the file it exists to track/);
  });

  it('fails when the parse lost a codepoint the bundled subset declares', () => {
    expect(() =>
      assertCoverageIntegrity({
        ranges: [{ start: 0x0000, end: 0x00ff }],
        declarationCount: 4,
      }),
    ).toThrow(/U\+2014/);
  });

  it('fails when a wildcard widened the covered set into a vacuous green', () => {
    expect(() =>
      assertCoverageIntegrity({ ranges: wide, declarationCount: 4 }),
    ).toThrow(/vacuous green/);
  });
});

describe('collectUncovered', () => {
  const ranges = [{ start: 0x2000, end: 0x206f }];

  it('reports line, column, codepoint and character', () => {
    expect(collectUncovered('ab\nx★y\n', ranges, 'a.tsx')).toEqual([
      {
        file: 'a.tsx',
        line: 2,
        column: 2,
        codepoint: 0x2605,
        character: '★',
      },
    ]);
  });

  it('ignores codepoints below the inventory floor', () => {
    expect(collectUncovered('é ß ÿ', ranges, 'a.tsx')).toEqual([]);
  });

  it('ignores covered codepoints', () => {
    expect(collectUncovered('—…', ranges, 'a.tsx')).toEqual([]);
  });

  it('counts an astral character once, not as two surrogates', () => {
    const findings = collectUncovered('🚀', ranges, 'a.tsx');
    expect(findings).toHaveLength(1);
    expect(findings[0].codepoint).toBe(0x1f680);
  });
});

describe('hasCandidateCodepoint', () => {
  const ranges = [{ start: 0x2000, end: 0x206f }];

  it('is false for a file the scan can skip without parsing', () => {
    expect(hasCandidateCodepoint('const a = "— plain …";', ranges)).toBe(false);
  });

  it('is true even when the only occurrence is inside a comment', () => {
    // The prefilter must be conservative: skipping is only sound when there
    // is nothing to find, and stripping can only remove characters.
    expect(hasCandidateCodepoint('// ★\n', ranges)).toBe(true);
  });
});

describe('loadAllowlist', () => {
  const base = {
    categories: { icon: { reason: 'because' } },
    codepoints: [{ codepoint: 'U+2605', character: '★', category: 'icon' }],
  };

  it('accepts a well-formed document', () => {
    expect([...loadAllowlist(base).keys()]).toEqual([0x2605]);
  });

  it('rejects a category with no reason', () => {
    expect(() => loadAllowlist({ ...base, categories: { icon: {} } })).toThrow(
      /has no reason/,
    );
  });

  it('rejects an entry whose character is not its codepoint', () => {
    // The reader checks the reason against the character; an entry that
    // shows one glyph and permits another is a label nothing computes.
    expect(() =>
      loadAllowlist({
        ...base,
        codepoints: [{ codepoint: 'U+2605', character: '●', category: 'icon' }],
      }),
    ).toThrow(/is not that codepoint/);
  });

  it('rejects an unknown category', () => {
    expect(() =>
      loadAllowlist({
        ...base,
        codepoints: [{ codepoint: 'U+2605', character: '★', category: 'nope' }],
      }),
    ).toThrow(/unknown category/);
  });

  it('rejects a range where a single codepoint belongs', () => {
    expect(() =>
      loadAllowlist({
        ...base,
        codepoints: [
          { codepoint: 'U+2600-26FF', character: '★', category: 'icon' },
        ],
      }),
    ).toThrow(/malformed codepoint/);
  });

  it('rejects a duplicate codepoint', () => {
    expect(() =>
      loadAllowlist({
        ...base,
        codepoints: [base.codepoints[0], base.codepoints[0]],
      }),
    ).toThrow(/twice/);
  });
});

describe('reconcile', () => {
  const allowlist = new Map([
    [0x2605, { codepoint: 'U+2605', character: '★', category: 'icon' }],
  ]);
  const finding = (codepoint: number) => ({
    file: 'a.tsx',
    line: 1,
    column: 1,
    codepoint,
    character: String.fromCodePoint(codepoint),
  });

  it('reports an uncovered codepoint nothing declared', () => {
    const { unlisted } = reconcile([finding(0x25cf)], allowlist);
    expect([...unlisted.keys()]).toEqual([0x25cf]);
  });

  it('reports an allowlist entry no occurrence justifies any more', () => {
    // #1704 shrinks the icon category; the shrink has to be visible, or the
    // allowlist stops describing the product.
    expect(reconcile([], allowlist).stale).toEqual([0x2605]);
  });

  it('is silent when the inventory and the allowlist agree', () => {
    const { unlisted, stale } = reconcile([finding(0x2605)], allowlist);
    expect(unlisted.size).toBe(0);
    expect(stale).toEqual([]);
  });
});

describe('assertScanScope', () => {
  it('accepts a list containing every sentinel', () => {
    expect(() => assertScanScope(['a', 'b'], ['a', 'b'])).not.toThrow();
  });

  it('fails when one sentinel falls out of a still-non-empty list', () => {
    // A scope check that only asserted "the list is non-empty" cannot see a
    // single entry disappear, which is the shape that makes a gate vacuous.
    expect(() => assertScanScope(['a'], ['a', 'b'])).toThrow(
      /sentinel file\(s\) not in the scanned list: b/,
    );
  });
});

describe('formatCodepoint', () => {
  it('pads to at least four hex digits and does not truncate astral', () => {
    expect(formatCodepoint(0x2605)).toBe('U+2605');
    expect(formatCodepoint(0x1f680)).toBe('U+1F680');
  });
});
