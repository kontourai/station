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
    ).toEqual({ hardCoded: [], transitionAll: [], unresolvedToken: [] });
    expect(
      inspectMotionCss(
        '.spinner { animation: spin var(--motion-status-spin) var(--ease-linear) infinite; }',
        REAL_TOKENS,
      ),
    ).toEqual({ hardCoded: [], transitionAll: [], unresolvedToken: [] });
  });

  it('keeps representative migrated surfaces at zero hard-coded declarations', () => {
    const migrated = [
      'src-ui/src/index.css',
      'src-ui/src/views/page-layout.css',
      'src-ui/src/views/ScheduleView.css',
      'src-ui/src/components/notifications/NotificationContainer.css',
      'src-ui/src/components/chat/chat.css',
      // station#3166: these use Console Kit's --k-dur/--k-ease, which ARE
      // declared (in @kontourai/ui/tokens, imported by index.css) — the
      // issue's premise that they were undefined was wrong.
      'src-ui/src/components/trust/TrustPanel.css',
      'src-ui/src/components/readiness/ReadinessPanel.css',
      'src-ui/src/components/flow/flow-events.css',
      'src-ui/src/components/flow/FlowRunConsole.css',
    ];

    for (const file of migrated) {
      expect(
        inspectMotionCss(
          readFileSync(join(process.cwd(), file), 'utf8'),
          REAL_TOKENS,
        ),
        file,
      ).toEqual({ hardCoded: [], transitionAll: [], unresolvedToken: [] });
    }

    const baseline = JSON.parse(
      readFileSync(
        join(process.cwd(), 'scripts/motion-contract-baseline.json'),
        'utf8',
      ),
    ) as { hardCodedDeclarationCeiling: number };
    // station#753 item 6 migrated the last 25 legacy-ceiling files (99 of the
    // 100 declarations) to tokens; the one remaining declaration
    // (NotificationHistory.css's `notification-dismiss-collapse`, `4s`) is
    // load-bearing — it encodes `UNDO_WINDOW_MS` from NotificationHistory.tsx,
    // not a motion-grammar duration a token could express without breaking
    // that correspondence.
    expect(baseline.hardCodedDeclarationCeiling).toBe(1);
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
