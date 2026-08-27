import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * What this proves, exactly: the two shell files contain none of the three
 * literal markup forms below. That is the shape both retired surfaces took —
 * chrome markup written inline in the shell — so it catches the regression
 * that actually happened (station#2214).
 *
 * What it does NOT prove: that every future chrome notice uses `bannerStore`.
 * A new component file rendering `<aside role="alert">`, or `role={'alert'}`
 * written as an expression, passes. Enforcing the general claim needs a lint
 * rule with an allowlist, which is more ceremony than this earns today —
 * inline status content elsewhere is legitimate and a lexical scan cannot
 * tell it from chrome. Do not cite this test as repo-wide enforcement.
 */
const SHELL_FILES = ['App.tsx', 'main.tsx'] as const;

const FORBIDDEN_CHROME_MARKUP = [
  { label: 'role="alert"', pattern: /role\s*=\s*["']alert["']/ },
  { label: 'role="status"', pattern: /role\s*=\s*["']status["']/ },
  {
    label: 'className="global-error"',
    pattern: /className\s*=\s*["']global-error["']/,
  },
] as const;

function findHandRolledChromeMarkup(source: string): string[] {
  return FORBIDDEN_CHROME_MARKUP.flatMap(({ label, pattern }) =>
    pattern.test(source) ? [label] : [],
  );
}

describe('shell chrome notice primitive', () => {
  test.each(SHELL_FILES)(
    '%s routes chrome alerts through bannerStore',
    (relativePath) => {
      const source = readFileSync(join(__dirname, '..', relativePath), 'utf8');
      expect(
        findHandRolledChromeMarkup(source),
        `${relativePath} contains hand-rolled chrome alert markup. Present the condition through bannerStore instead.`,
      ).toEqual([]);
    },
  );

  test('detects a re-added role="alert" before it can bypass bannerStore', () => {
    expect(
      findHandRolledChromeMarkup('<div role="alert">Failure</div>'),
    ).toEqual(['role="alert"']);
  });
});
