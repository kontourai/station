import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('dependency security guide', () => {
  test('distinguishes local SARIF enforcement from unverified hosted ingestion and Rust coverage', () => {
    const guide = readFileSync('docs/guides/dependency-security.md', 'utf8');
    expect(guide).toContain('npm run codeql:sarif:check -- --input=');
    expect(guide).toContain('GitHub ingestion is **NOT_VERIFIED**.');
    expect(guide).toContain('Rust analysis is also **NOT_VERIFIED**');
    expect(guide).toContain('upload: never');
    expect(guide).toContain('actions/dependency-review-action');
    expect(guide).toContain(
      'the dependency-review capability is **NOT_VERIFIED**',
    );
  });
});
