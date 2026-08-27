import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { a11yEnabled, countViolations, evaluate } from '../a11y-ratchet.mjs';

describe('a11yEnabled', () => {
  it('is true only when the family is explicitly switched on', () => {
    expect(
      a11yEnabled('{"linter":{"rules":{"a11y":{"recommended":true}}}}'),
    ).toBe(true);
    expect(
      a11yEnabled('{"linter":{"rules":{"a11y":{"recommended":false}}}}'),
    ).toBe(false);
    expect(a11yEnabled('{"linter":{"rules":{}}}')).toBe(false);
    expect(a11yEnabled('not json at all')).toBe(false);
  });
});

describe('countViolations', () => {
  it('counts diagnostics per a11y rule', () => {
    const output = [
      'src-ui/src/A.tsx:1:1 lint/a11y/useButtonType ━━━',
      'src-ui/src/B.tsx:2:1 lint/a11y/useButtonType ━━━',
      'src-ui/src/C.tsx:3:1 lint/a11y/noSvgWithoutTitle ━━━',
      'src-ui/src/D.tsx:4:1 lint/correctness/noUnusedImports ━━━',
    ].join('\n');

    expect(countViolations(output)).toEqual({
      useButtonType: 2,
      noSvgWithoutTitle: 1,
    });
  });

  it('reports nothing for clean output', () => {
    expect(countViolations('Checked 100 files. No fixes applied.')).toEqual({});
  });
});

describe('evaluate', () => {
  const baseline = { ceilings: { useButtonType: 10, noSvgWithoutTitle: 5 } };

  it('passes when every rule is at or below its ceiling', () => {
    const { regressions } = evaluate(
      { useButtonType: 10, noSvgWithoutTitle: 4 },
      baseline,
    );
    expect(regressions).toEqual([]);
  });

  it('flags a rule that regressed above its ceiling', () => {
    const { regressions } = evaluate({ useButtonType: 11 }, baseline);
    expect(regressions).toEqual([
      { rule: 'useButtonType', actual: 11, ceiling: 10 },
    ]);
  });

  it('treats a newly-violating rule with no ceiling as a regression', () => {
    const { regressions } = evaluate({ noAutofocus: 1 }, baseline);
    expect(regressions).toContainEqual({
      rule: 'noAutofocus',
      actual: 1,
      ceiling: 0,
    });
  });

  it('treats an absent rule as zero rather than unmeasured', () => {
    // Reaching zero is the goal; a missing key must read as an improvement,
    // never as "not measured, assume fine".
    const { regressions, improvements } = evaluate({}, baseline);
    expect(regressions).toEqual([]);
    expect(improvements).toEqual([
      { rule: 'useButtonType', actual: 0, ceiling: 10 },
      { rule: 'noSvgWithoutTitle', actual: 0, ceiling: 5 },
    ]);
  });

  it('reports improvements so ceilings can be lowered', () => {
    const { improvements } = evaluate({ useButtonType: 3 }, baseline);
    expect(improvements).toContainEqual({
      rule: 'useButtonType',
      actual: 3,
      ceiling: 10,
    });
  });
});

describe('lint scope', () => {
  it('keeps the ratchet source roots in step with the lint:check script', () => {
    // The ratchet must measure exactly what the gate lints. If lint:check is
    // rescoped and SOURCE_ROOTS is not, the ratchet silently measures a
    // different tree than the one being enforced.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lintRoots = pkg.scripts['lint:check']
      .replace('biome check ', '')
      .trim()
      .split(/\s+/);
    const ratchetSource = readFileSync('scripts/a11y-ratchet.mjs', 'utf8');
    const declared = ratchetSource
      .slice(ratchetSource.indexOf('const SOURCE_ROOTS = ['))
      .slice(
        0,
        ratchetSource
          .slice(ratchetSource.indexOf('const SOURCE_ROOTS = ['))
          .indexOf('];'),
      );
    const ratchetRoots = [...declared.matchAll(/'([^']+)'/g)].map((m) => m[1]);

    expect(ratchetRoots).toEqual(lintRoots);
  });

  it('never lints generated output, signed attestations or Protected Standards', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const scoped = pkg.scripts['lint:check'];
    // Formatting these rewrites generated files, invalidates in-toto
    // signatures, and mutates files that require a Veritas policy-change
    // attestation. It happened once; this keeps it from happening again.
    for (const forbidden of [
      '.veritas',
      'delivery/',
      'src-desktop/gen',
      'veritas.claims.json',
    ]) {
      expect(scoped).not.toContain(forbidden);
    }
    expect(scoped.trim()).not.toBe('biome check .');
  });
});
