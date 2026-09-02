import { describe, expect, test } from 'vitest';
import {
  assertRegistryGitHeadMatchesSource,
  parseRegistryGitHead,
} from '../lib/npm-registry-provenance.mjs';

const SOURCE_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

describe('npm registry publish provenance', () => {
  test('accepts only an exact registry gitHead binding to the source', () => {
    const gitHead = parseRegistryGitHead(JSON.stringify(SOURCE_SHA));
    expect(assertRegistryGitHeadMatchesSource(gitHead, SOURCE_SHA)).toBe(
      SOURCE_SHA,
    );
  });

  test('fails closed when a published package reports a different gitHead', () => {
    const mismatched = parseRegistryGitHead(
      JSON.stringify('0123456789abcdef0123456789abcdef01234567'),
    );
    expect(() =>
      assertRegistryGitHeadMatchesSource(mismatched, SOURCE_SHA),
    ).toThrow(/does not match source SHA/);
  });

  test('fails closed when registry provenance is missing or malformed', () => {
    expect(() => parseRegistryGitHead('null')).toThrow(/must be a lowercase/);
    expect(() => parseRegistryGitHead('not json')).toThrow(/not valid JSON/);
  });
});
