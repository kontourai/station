import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// Wrapping and prose wording do not change an executable command contract.
const read = (file: string) => readFileSync(file, 'utf8').replace(/\s+/g, ' ');

describe('dependency lifecycle bootstrap guidance', () => {
  test('keeps root-checkout commands on the inert install boundary', () => {
    const desktop = read('docs/guides/desktop-build.md');
    const quality = read('docs/guides/code-quality.md');
    const testing = read('docs/guides/testing.md');
    const development = read('docs/guides/development.md');

    expect(desktop).toContain('npm run dependencies:ci');
    expect(desktop).not.toContain(
      'npm ci npm run verify:desktop-clean-checkout',
    );
    for (const guide of [quality, testing]) {
      expect(guide).toContain('npm run dependencies:ci');
      expect(guide).toContain('npm run dependencies:install');
    }
    expect(quality).toContain('npm run hooks:install');
    expect(development).toContain('cd my-plugin npm install');
  });
});
