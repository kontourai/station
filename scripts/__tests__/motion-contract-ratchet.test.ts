import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectDeclaredTokens,
  evaluateMotionContract,
  extractDeclaredCustomProperties,
  findUnresolvedTokenReferences,
  inspectMotionCss,
  isHardCodedLayer,
  motionLayers,
} from '../motion-contract-ratchet.mjs';

// Built with the gate's OWN collector, so the imported Console Kit sheets are
// always included — that half had already drifted once, and the test called
// real, shipping tokens undefined (station#3166).
//
// Stated precisely, because the earlier wording overclaimed: this passes a
// NARROWER file list than `main()`, which scans every CSS file under
// CSS_ROOT. A motion token declared in a component stylesheet rather than
// tokens.css would therefore pass the gate and red this test. Zero files
// disagree today, and it fails closed (test red, gate green) — but it is a
// narrower inventory, not the same one.
const REAL_TOKENS = collectDeclaredTokens(
  ['src-ui/src/tokens.css'],
  (file: string) => readFileSync(join(process.cwd(), file), 'utf8'),
);

describe('per-layer detection (#3223)', () => {
  /**
   * The gap this closes: detection tested the whole declaration value, so a
   * literal in one comma-separated layer was excused by a token in a sibling
   * layer. That mixed form is the LIKELY shape of a regression — a maintenance
   * edit adding a property to an already-tokenized declaration — while the
   * wholly-literal form is the beginner case.
   */
  it('catches a literal hiding beside tokenized siblings', () => {
    const mixed = `.pill {
      transition:
        border-color 0.15s,
        background var(--motion-fast) var(--ease-standard),
        color var(--motion-fast) var(--ease-standard);
    }`;
    expect(inspectMotionCss(mixed).hardCoded).toHaveLength(1);
  });

  it('still accepts a fully tokenized multi-layer declaration', () => {
    const clean = `.pill {
      transition:
        border-color var(--motion-fast) var(--ease-standard),
        background var(--motion-fast) var(--ease-standard);
    }`;
    expect(inspectMotionCss(clean)).toEqual({
      hardCoded: [],
      transitionAll: [],
      unresolvedToken: [],
      easeIn: [],
    });
  });

  /**
   * `cubic-bezier(0.4, 0, 0.2, 1)` contains three commas. Splitting naively
   * would read it as four layers and mis-attribute its numbers.
   */
  it('does not split inside a parenthesised easing function', () => {
    expect(
      motionLayers('opacity var(--motion-fast) cubic-bezier(0.4, 0, 0.2, 1)'),
    ).toHaveLength(1);
  });

  it('splits top-level layers', () => {
    expect(motionLayers('a 1s, b 2s, c 3s')).toHaveLength(3);
  });

  it('does not split inside a quoted name or an escaped comma', () => {
    expect(
      motionLayers('"x,y" var(--motion-fast) var(--ease-out)'),
    ).toHaveLength(1);
    expect(
      motionLayers('a\\2c b var(--motion-fast) var(--ease-out)'),
    ).toHaveLength(1);
    expect(motionLayers('"x,\\"y", ease-in')).toHaveLength(2);
  });

  it('judges a layer on its own duration and easing', () => {
    expect(isHardCodedLayer('border-color 0.15s')).toBe(true);
    expect(isHardCodedLayer('border-color var(--motion-fast)')).toBe(false);
    expect(isHardCodedLayer('opacity var(--motion-fast) ease-in')).toBe(true);
  });
});

describe('motion contract ratchet', () => {
  it('accepts semantic motion tokens', () => {
    expect(
      inspectMotionCss(
        '.item { transition: opacity var(--motion-fast) var(--ease-standard); }',
        REAL_TOKENS,
      ),
    ).toEqual({
      hardCoded: [],
      transitionAll: [],
      unresolvedToken: [],
      easeIn: [],
    });
    expect(
      inspectMotionCss(
        '.spinner { animation: spin var(--motion-status-spin) var(--ease-linear) infinite; }',
        REAL_TOKENS,
      ),
    ).toEqual({
      hardCoded: [],
      transitionAll: [],
      unresolvedToken: [],
      easeIn: [],
    });
  });

  it('rejects hard-coded motion and transition all', () => {
    const findings = [
      ...inspectMotionCss(
        '.a { animation: pulse 1.2s ease-in-out infinite; }',
      ).hardCoded.map((declaration) => ({
        file: 'a.css',
        kind: 'hard-coded',
        declaration,
      })),
      ...inspectMotionCss(
        '.b { transition: all 200ms ease; }',
      ).transitionAll.map((declaration) => ({
        file: 'b.css',
        kind: 'transition-all',
        declaration,
      })),
    ];
    expect(evaluateMotionContract(findings, 0).passed).toBe(false);
  });

  it('rejects ease-in even when a token of that name is declared', () => {
    const declared = new Set([...REAL_TOKENS, '--ease-in']);
    const eased = inspectMotionCss(
      '.out { animation: leave var(--motion-fast) var(--ease-in) both; }',
      declared,
    );
    expect(eased.unresolvedToken).toEqual([]);
    expect(eased.easeIn).toHaveLength(1);
    const findings = eased.easeIn.map((declaration) => ({
      file: 'out.css',
      kind: 'ease-in',
      declaration,
    }));
    expect(evaluateMotionContract(findings, 10, { 'out.css': 10 }).passed).toBe(
      false,
    );
  });

  it('rejects an ease-in fallback and an uppercase keyword with no ceiling', () => {
    const declared = new Set([...REAL_TOKENS, '--ease-in']);
    const fallback = inspectMotionCss(
      '.out { animation: leave var(--motion-fast) var(--ease-in, var(--ease-out)) both; }',
      declared,
    );
    expect(fallback.unresolvedToken).toEqual([]);
    expect(fallback.hardCoded).toEqual([]);
    expect(fallback.easeIn).toHaveLength(1);
    expect(
      evaluateMotionContract(
        fallback.easeIn.map((declaration) => ({
          file: 'out.css',
          kind: 'ease-in' as const,
          declaration,
        })),
        0,
      ).passed,
    ).toBe(false);
    const upper = inspectMotionCss(
      '.out { animation: leave var(--motion-fast) EASE-IN both; } .fn { transition: opacity var(--motion-fast) VAR(--ease-in); }',
      declared,
    );
    expect(upper.easeIn).toHaveLength(2);
    const findings = [
      ...upper.hardCoded.map((declaration) => ({
        file: 'out.css',
        kind: 'hard-coded' as const,
        declaration,
      })),
      ...upper.easeIn.map((declaration) => ({
        file: 'out.css',
        kind: 'ease-in' as const,
        declaration,
      })),
    ];
    expect(evaluateMotionContract(findings, 10, { 'out.css': 10 }).passed).toBe(
      false,
    );
    const withoutEaseIn = findings.filter(
      (finding) => finding.kind !== 'ease-in',
    );
    expect(
      evaluateMotionContract(withoutEaseIn, 10, { 'out.css': 10 }).passed,
    ).toBe(true);
  });

  it('rejects an adjacent or escaped ease-in and keeps a longer ident', () => {
    const rejected = [
      '.a { transition: opacity var(--motion-fast)ease-in; }',
      '.b { transition: opacity var(--motion-fast)EASE-IN; }',
      '.c { transition: opacity var(--motion-fast) \\65 ase-in; }',
      '.d { transition: opacity var(--motion-fast) v\\61r(--ease-in); }',
      '.e { transition: opacity var(--motion-fast) var(--\\65 ase-in); }',
    ];
    for (const css of rejected) {
      const found = inspectMotionCss(css, REAL_TOKENS);
      expect(found.easeIn, css).toHaveLength(1);
      expect(
        evaluateMotionContract(
          found.easeIn.map((declaration) => ({
            file: 'a.css',
            kind: 'ease-in' as const,
            declaration,
          })),
          0,
        ).passed,
        css,
      ).toBe(false);
    }
    const named = inspectMotionCss(
      '.a { animation: ease-iné var(--motion-slow) var(--ease-out); }',
      REAL_TOKENS,
    );
    expect(named.easeIn).toEqual([]);
    const escapedOut = inspectMotionCss(
      '.b { animation: pulse 1.2s ease-in\\2d out infinite; }',
      REAL_TOKENS,
    );
    expect(escapedOut.easeIn).toEqual([]);
  });

  it('rejects ease-in after a non-ASCII ident and ignores a quoted name', () => {
    const rejected = [
      '.u { animation: I var(--motion-fast) var(--ease-custom, ease-in); }',
      '.u { animation: \u0130 var(--motion-fast) var(--ease-custom, ease-in); }',
    ];
    for (const css of rejected) {
      const found = inspectMotionCss(css, REAL_TOKENS);
      expect(found.hardCoded, css).toEqual([]);
      expect(found.unresolvedToken, css).toEqual([]);
      expect(found.easeIn, css).toHaveLength(1);
      expect(
        evaluateMotionContract(
          found.easeIn.map((declaration) => ({
            file: 'a.css',
            kind: 'ease-in' as const,
            declaration,
          })),
          0,
        ).passed,
        css,
      ).toBe(false);
    }
    const allowed = [
      '.a { animation: "ease-in" var(--motion-fast) var(--ease-out); }',
      '.b { animation: x var(--motion-fast) var(--ease-out, url("ease-in")); }',
      '.c { animation: "slide ease-in" var(--motion-fast) var(--ease-out); }',
      '.d { animation: "var(--ease-in)" var(--motion-fast) var(--ease-out); }',
    ];
    for (const css of allowed) {
      const found = inspectMotionCss(css, REAL_TOKENS);
      expect(found.easeIn, css).toEqual([]);
      expect(found.hardCoded, css).toEqual([]);
    }
  });

  it('rejects ease-in after a comma inside a quoted name', () => {
    const hidden =
      '.x { animation: "x,y" var(--motion-fast) var(--ease-custom, ease-in); }';
    const found = inspectMotionCss(hidden, REAL_TOKENS);
    expect(found.hardCoded, hidden).toEqual([]);
    expect(found.unresolvedToken, hidden).toEqual([]);
    expect(found.easeIn, hidden).toHaveLength(1);
    expect(
      evaluateMotionContract(
        found.easeIn.map((declaration) => ({
          file: 'a.css',
          kind: 'ease-in' as const,
          declaration,
        })),
        0,
      ).passed,
    ).toBe(false);
    const clean = '.x { animation: "x,y" var(--motion-fast) var(--ease-out); }';
    const allowed = inspectMotionCss(clean, REAL_TOKENS);
    expect(allowed.easeIn, clean).toEqual([]);
    expect(allowed.hardCoded, clean).toEqual([]);
  });

  it('does not treat ease-in-out or ease-out as ease-in', () => {
    const declared = new Set([...REAL_TOKENS, '--EASE-IN']);
    const mixed = inspectMotionCss(
      '.a { animation: pulse 1.2s ease-in-out infinite; } .b { transition: opacity var(--motion-fast) var(--ease-out); } .c { animation: pulse 1.2s EASE-IN-OUT infinite; } .d { animation: leave var(--motion-fast) var(--EASE-IN) both; }',
      declared,
    );
    expect(mixed.easeIn).toEqual([]);
    expect(mixed.unresolvedToken).toEqual([]);
    expect(mixed.hardCoded).toHaveLength(2);
  });

  it('binds ease-out to the kit curve and declares no ease-in token', () => {
    expect(REAL_TOKENS.has('--ease-in')).toBe(false);
    expect(REAL_TOKENS.has('--ease-out')).toBe(true);
    expect(REAL_TOKENS.has('--k-ease')).toBe(true);
    const tokens = readFileSync(
      join(process.cwd(), 'src-ui/src/tokens.css'),
      'utf8',
    );
    expect(tokens).toMatch(/--ease-out:\s*var\(--k-ease\)/);
  });

  it('extracts declared custom properties, not var() references', () => {
    const declared = extractDeclaredCustomProperties(
      ':root {\n' +
        '  --motion-fast: 0.15s;\n' +
        '  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);\n' +
        '}\n' +
        '.item { transition: opacity var(--motion-fast) var(--ease-standard); }\n',
    );
    expect(declared.has('--motion-fast')).toBe(true);
    expect(declared.has('--ease-standard')).toBe(true);
    // A var() reference must never be mistaken for a declaration.
    expect(declared.has('--motion-fast) var')).toBe(false);
    expect(declared.size).toBe(2);
  });

  it('flags a var() reference whose token is declared nowhere', () => {
    const declared = new Set(['--motion-fast', '--ease-standard']);
    expect(
      findUnresolvedTokenReferences(
        'border-color var(--k-dur) var(--k-ease)',
        declared,
      ),
    ).toEqual(['--k-dur', '--k-ease']);
  });

  it('resolves a var() reference through a token fallback', () => {
    const declared = new Set(['--motion-base', '--ease-standard']);
    // `--dock-transition` is never declared, but its fallback resolves to a
    // real token — this must NOT be flagged as unresolved.
    expect(
      findUnresolvedTokenReferences(
        'height var(--dock-transition, var(--motion-base)) var(--ease-standard)',
        declared,
      ),
    ).toEqual([]);
  });

  it('does not flag a var() reference whose fallback is a literal', () => {
    const declared = new Set(['--ease-standard']);
    expect(
      findUnresolvedTokenReferences(
        'opacity var(--custom-fade, 0.2s)',
        declared,
      ),
    ).toEqual([]);
  });

  it('the motion-contract gate itself fails on an undefined token reference', () => {
    const declared = new Set(['--motion-fast', '--ease-standard']);
    const result = inspectMotionCss(
      '.toggle { transition: border-color var(--k-dur) var(--k-ease); }',
      declared,
    );
    expect(result.unresolvedToken).toHaveLength(1);
    expect(result.unresolvedToken[0].tokens).toEqual(['--k-dur', '--k-ease']);

    const findings = result.unresolvedToken.map(({ declaration, tokens }) => ({
      file: 'toggle.css',
      kind: 'unresolved-token',
      declaration,
      tokens,
    }));
    expect(evaluateMotionContract(findings, 0).passed).toBe(false);
  });

  it('allows a measured legacy ceiling but never transition all', () => {
    const legacy = [
      {
        file: 'legacy.css',
        kind: 'hard-coded',
        declaration: 'transition: opacity 0.2s ease',
      },
    ];
    expect(evaluateMotionContract(legacy, 1, { 'legacy.css': 1 }).passed).toBe(
      true,
    );
    expect(evaluateMotionContract(legacy, 1, {}).passed).toBe(false);
    expect(
      evaluateMotionContract(
        [
          ...legacy,
          {
            file: 'bad.css',
            kind: 'transition-all',
            declaration: 'transition: all 1s',
          },
        ],
        2,
        { 'legacy.css': 1, 'bad.css': 1 },
      ).passed,
    ).toBe(false);
  });
});
