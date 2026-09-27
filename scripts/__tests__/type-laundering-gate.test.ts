import { describe, expect, it } from 'vitest';
import {
  evaluate,
  fingerprintFor,
  scanSource,
} from '../type-laundering-gate.mjs';

describe('scanSource', () => {
  it.each([
    ['as-unknown', 'const row = value as unknown as Row;', 'as-unknown'],
    ['as-any', 'const meta = payload as any;', 'as-any'],
    ['as-any spaced', 'return input as  any;', 'as-any'],
  ])('catches %s', (_name, source, rule) => {
    expect(scanSource(source).map((finding) => finding.rule)).toContain(rule);
  });

  it('is a false-positive control for legitimate code', () => {
    expect(
      scanSource(
        [
          'const value: unknown = load();',
          'if (typeof value === "string") use(value);',
          'const row = parseRow(value);',
          'type Maybe<T> = T | unknown;',
          'import type { any } from "./util";',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('skips comment lines', () => {
    expect(
      scanSource('// uses `as any` here on purpose\n/* as unknown as T */'),
    ).toEqual([]);
  });

  it('is stable under line moves (fingerprint covers rule + trimmed text)', () => {
    const first = fingerprintFor('as-any', 'const meta = payload as any;');
    const second = fingerprintFor('as-any', '  const meta = payload as any;  ');
    expect(first).toBe(second);
  });
});

describe('evaluate', () => {
  const root = process.cwd();

  it('reports the real tree without new-cast errors (baseline covers origin/main)', () => {
    const result = evaluate({ root });
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });
});
