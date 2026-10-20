import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('dependency security guide', () => {
  test('distinguishes local SARIF enforcement from unverified hosted ingestion and Rust coverage', () => {
    const guide = readFileSync('docs/guides/dependency-security.md', 'utf8');
    // The disclosures are the contract; emphasis, wording, and wrapping are
    // editorial, so match on plain, single-spaced text.
    const plain = guide.replace(/[*`]/g, '').replace(/\s+/g, ' ');
    expect(plain).toMatch(/GitHub ingestion[^.]*NOT_VERIFIED/);
    expect(plain).toMatch(/Rust analysis[^.]*NOT_VERIFIED/);
    expect(plain).toMatch(/dependency-review capability[^.]*NOT_VERIFIED/);
  });
});
