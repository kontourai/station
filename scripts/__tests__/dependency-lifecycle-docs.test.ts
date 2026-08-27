import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8');

describe('dependency lifecycle bootstrap guidance', () => {
  test('keeps root-checkout commands on the inert install boundary', () => {
    const desktop = read('docs/guides/desktop-build.md');
    const quality = read('docs/guides/code-quality.md');
    const testing = read('docs/guides/testing.md');
    const development = read('docs/guides/development.md');

    expect(desktop).toContain('npm run dependencies:ci');
    expect(desktop).not.toContain(
      'npm ci\nnpm run verify:desktop-clean-checkout',
    );
    for (const guide of [quality, testing]) {
      expect(guide).toContain('npm run dependencies:ci');
      expect(guide).toContain('npm run dependencies:install');
    }
    expect(quality).toContain('npm run hooks:install');
    expect(quality).toContain('explicit patch step');
    expect(quality).not.toContain('`npm ci` arms them');
    expect(testing).toContain('does not trust a\nroot `postinstall` hook');
    for (const stale of [
      'after a fresh `npm ci`',
      'through `npm ci`',
      'Run\n`npm install` there after a pull',
      '`npm ci` does **not** provision Playwright browsers',
      'nothing beyond `npm ci`',
      'Fix: `npm ci`',
    ])
      expect(testing).not.toContain(stale);
    expect(development).toContain('cd my-plugin\nnpm install');
  });
});
