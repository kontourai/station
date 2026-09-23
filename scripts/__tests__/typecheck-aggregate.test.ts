import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TYPECHECK_LANES } from '../typecheck-aggregate.mjs';

const root = resolve(import.meta.dirname, '../..');

type Tsconfig = {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
};

function tsconfig(name: string): Tsconfig {
  return JSON.parse(readFileSync(resolve(root, name), 'utf8')) as Tsconfig;
}

/**
 * `typecheck:server` (`tsc -p tsconfig.json`) was dropped from the aggregate
 * because `typecheck:server-tests` compiles a strict superset of the same
 * program under the same options. That is only true while the two configs
 * keep this shape, so the shape is what these tests pin. If one fails, the
 * production program is no longer contained in the tests program: restore
 * the `typecheck:server` lane (and its package.json script) rather than
 * adjusting the assertion.
 */
describe('the server tests program contains the production server program', () => {
  const production = tsconfig('tsconfig.json');
  const tests = tsconfig('tsconfig.tests.json');

  it('inherits every compiler option and overrides none', () => {
    expect(tests.extends).toBe('./tsconfig.json');
    expect(tests.compilerOptions).toBeUndefined();
  });

  it('includes every production root and excludes nothing production keeps', () => {
    expect(production.include?.length).toBeGreaterThan(0);
    for (const pattern of production.include ?? [])
      expect(tests.include).toContain(pattern);
    // Anything the tests program excludes must already be excluded from the
    // production program, or a production file could drop out of both.
    for (const pattern of tests.exclude ?? [])
      expect(production.exclude).toContain(pattern);
  });

  it('runs the tests program and not the redundant production lane', () => {
    const scripts = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ).scripts as Record<string, string>;
    const ids = TYPECHECK_LANES.map((lane) => lane.id);
    expect(ids).toContain('typecheck:server-tests');
    expect(scripts['typecheck:server-tests']).toBe(
      'tsc -p tsconfig.tests.json --noEmit',
    );
    expect(ids).not.toContain('typecheck:server');
  });
});
