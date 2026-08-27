import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  countPageLocalResponsiveQueries,
  evaluateMobileCss,
  PRIMITIVE_ALLOWLIST,
  PRIMITIVE_REASONS,
} from '../mobile-css-ratchet.mjs';

const BASELINE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../mobile-css-baseline.json', import.meta.url)),
    'utf8',
  ),
);

const REASON = 'a reason long enough to be an actual reason';

type Entry = { count: number; reason: string };

function baselineOf(pageLocal: Record<string, Entry>, ceiling?: number) {
  return {
    pageLocalMediaQueryCeiling:
      ceiling ??
      Object.values(pageLocal).reduce(
        (total: number, entry: Entry) => total + entry.count,
        0,
      ),
    pageLocal,
  };
}

describe('mobile-css page-local detection', () => {
  it('counts @media and @container outside the primitive allowlist', () => {
    const findings = countPageLocalResponsiveQueries(
      ['a.css', 'b.css'],
      (file: string) =>
        file === 'a.css'
          ? '@media (max-width: 768px) { .x { color: red } }\n@container (min-width: 10px) { .y { color: red } }'
          : '.z { color: red }',
    );
    expect(findings.map((finding: { file: string }) => finding.file)).toEqual([
      'a.css',
      'a.css',
    ]);
    expect(findings[0]?.line).toBe(1);
    expect(findings[1]?.line).toBe(2);
  });

  it('does not count an at-rule that only appears inside a comment', () => {
    // The gate blanks comments before matching. Without that, a docblock
    // explaining why a rule was REMOVED counts as the rule still being there.
    expect(
      countPageLocalResponsiveQueries(
        ['a.css'],
        () => '/* retired: @media (max-width: 768px) used to live here */',
      ),
    ).toEqual([]);
  });

  it('exempts the primitives, and every primitive carries a reason', () => {
    expect(
      countPageLocalResponsiveQueries(
        ['src-ui/src/views/page-layout.css'],
        () => '@media (max-width: 768px) { .page { padding: 0 } }',
      ),
    ).toEqual([]);
    const reasons = PRIMITIVE_REASONS as Record<string, string>;
    for (const file of PRIMITIVE_ALLOWLIST as Set<string>) {
      expect(String(reasons[file]).length, file).toBeGreaterThan(20);
    }
  });
});

describe('mobile-css gate verdicts', () => {
  // Each of these is a rejection path. A guardrail whose refusal has never
  // executed is unproven, and the whole point of the named baseline is that it
  // refuses on the FILE that changed rather than on whoever gates next.
  it('passes when every file matches what it recorded', () => {
    const findings = [{ file: 'a.css', line: 1 }];
    const result = evaluateMobileCss(
      findings,
      baselineOf({ 'a.css': { count: 1, reason: REASON } }),
    );
    expect(result.failures).toEqual([]);
  });

  it('names the unrecorded file that introduced a query', () => {
    const findings = [
      { file: 'a.css', line: 1 },
      { file: 'new-page.css', line: 42 },
    ];
    const result = evaluateMobileCss(
      findings,
      baselineOf({ 'a.css': { count: 1, reason: REASON } }, 2),
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('new-page.css');
    // And it does NOT indict the file that was already recorded.
    expect(result.failures[0]).not.toContain('a.css');
  });

  it('names a recorded file that grew, and repeats its reason', () => {
    const findings = [
      { file: 'a.css', line: 1 },
      { file: 'a.css', line: 9 },
    ];
    const result = evaluateMobileCss(
      findings,
      baselineOf({ 'a.css': { count: 1, reason: REASON } }, 2),
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('a.css: 2');
    expect(result.failures[0]).toContain(REASON);
  });

  it('refuses an entry that outlived its reason', () => {
    const result = evaluateMobileCss(
      [],
      baselineOf({ 'gone.css': { count: 1, reason: REASON } }),
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('now has none');
  });

  it('refuses an entry whose reason is a placeholder', () => {
    const result = evaluateMobileCss(
      [{ file: 'a.css', line: 1 }],
      baselineOf({ 'a.css': { count: 1, reason: 'todo' } }),
    );
    expect(
      result.failures.some((f: string) => f.includes('no usable reason')),
    ).toBe(true);
  });

  it('still refuses a total above the ceiling even when no file grew', () => {
    // The per-file check passes here (both files are at or under their
    // recorded counts); only the aggregate catches it.
    const result = evaluateMobileCss(
      [
        { file: 'a.css', line: 1 },
        { file: 'b.css', line: 1 },
      ],
      {
        pageLocalMediaQueryCeiling: 1,
        pageLocal: {
          'a.css': { count: 1, reason: REASON },
          'b.css': { count: 1, reason: REASON },
        },
      },
    );
    expect(result.failures.some((f: string) => f.startsWith('total'))).toBe(
      true,
    );
  });
});

describe('the checked-in baseline', () => {
  it('records a real reason for every page-local file', () => {
    for (const [file, entry] of Object.entries(
      BASELINE.pageLocal as Record<string, { count: number; reason: string }>,
    )) {
      expect(entry.count, file).toBeGreaterThan(0);
      expect(entry.reason.trim().length, file).toBeGreaterThan(23);
    }
  });

  it('keeps the ceiling equal to the sum of what it records', () => {
    // A ceiling above the sum is unattributed headroom: the next lane inherits
    // room to add a query without naming it.
    const sum = Object.values(
      BASELINE.pageLocal as Record<string, { count: number }>,
    ).reduce((total, entry) => total + entry.count, 0);
    expect(BASELINE.pageLocalMediaQueryCeiling).toBe(sum);
  });

  it('names no file twice and no primitive as page-local', () => {
    for (const file of Object.keys(BASELINE.pageLocal)) {
      expect(PRIMITIVE_ALLOWLIST.has(file), file).toBe(false);
    }
  });
});
