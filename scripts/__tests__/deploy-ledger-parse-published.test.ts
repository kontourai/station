import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePublishedPackages } from '../lib/parse-published-packages.mjs';

const scriptRoot = resolve(import.meta.dirname, '..');

/**
 * The changesets action's `published-packages` output contract (HIGH-2 of
 * this branch's review): a COMPACT SINGLE-LINE JSON ARRAY. The fixture below
 * is the exact 2-package value the reviewer ran; the parse is exercised
 * against it rather than against a hand-imagined shape, because the defect
 * this replaces (text-splitting) looked fine against every shape its author
 * imagined.
 */
const REAL_TWO_PACKAGE_OUTPUT =
  '[{"name":"@kontourai/station-contracts","version":"0.2.1"},{"name":"@kontourai/station-cli","version":"0.4.1"}]';

describe('parsePublishedPackages', () => {
  it('parses the real changesets output into name/version pairs', () => {
    expect(parsePublishedPackages(REAL_TWO_PACKAGE_OUTPUT)).toEqual([
      { name: '@kontourai/station-contracts', version: '0.2.1' },
      { name: '@kontourai/station-cli', version: '0.4.1' },
    ]);
    expect(
      parsePublishedPackages('[{"name":"station","version":"1.0.0"}]'),
    ).toEqual([{ name: 'station', version: '1.0.0' }]);
  });

  it('refuses unparseable input with a teaching message', () => {
    // What the old shell loop was handed and text-split: the same JSON
    // wearing a newline, and the newline name@version shape the workflow
    // wrongly assumed.
    for (const bad of [
      '@kontourai/station-contracts@0.2.1\n@kontourai/station-cli@0.4.1',
      'not json at all',
      '{',
    ]) {
      expect(() => parsePublishedPackages(bad)).toThrow(/not valid JSON/);
      expect(() => parsePublishedPackages(bad)).toThrow(/JSON array/);
    }
  });

  it('refuses empty, non-array, and structurally wrong values', () => {
    expect(() => parsePublishedPackages('')).toThrow(/empty/);
    expect(() => parsePublishedPackages('   ')).toThrow(/empty/);
    expect(() =>
      parsePublishedPackages('{"name":"x","version":"1.0.0"}'),
    ).toThrow(/JSON array/);
    expect(() => parsePublishedPackages('[]')).toThrow(/empty array/);
    expect(() =>
      parsePublishedPackages(
        '[{"name":"@scope/pkg","version":"1.0.0"},{"name":"bad"}]',
      ),
    ).toThrow(/element 1 .* no valid version/);
    expect(() =>
      parsePublishedPackages('[{"name":"has space","version":"1.0.0"}]'),
    ).toThrow(/no valid package name/);
    expect(() => parsePublishedPackages('["station@1.0.0"]')).toThrow(
      /element 0 must be an object/,
    );
    // A parse-artifact version (quotes/braces) must not survive here either.
    expect(() =>
      parsePublishedPackages('[{"name":"station","version":"0.4.1}"}]'),
    ).toThrow(/no valid version/);
  });

  it('emits name<TAB>version lines on stdout and exits 1 on bad input', () => {
    // The workflow's contract: the loop consumes TSV lines. Bad input must
    // redden the step (exit 1), never emit a partial list.
    const run = (arg: string) =>
      execFileSync(
        process.execPath,
        [resolve(scriptRoot, 'lib/parse-published-packages.mjs'), arg],
        {
          encoding: 'utf8',
          windowsHide: true,
        },
      );
    expect(run(REAL_TWO_PACKAGE_OUTPUT)).toBe(
      '@kontourai/station-contracts\t0.2.1\n@kontourai/station-cli\t0.4.1\n',
    );
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [
          resolve(scriptRoot, 'lib/parse-published-packages.mjs'),
          'definitely not json',
        ],
        { encoding: 'utf8', windowsHide: true, stdio: 'pipe' },
      );
    } catch (error) {
      failed = true;
      expect((error as { status: number }).status).toBe(1);
      expect(String((error as { stderr: string }).stderr)).toMatch(
        /not valid JSON/,
      );
    }
    expect(failed).toBe(true);
  });
});
