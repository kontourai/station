import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import {
  isReleaseTag,
  MAX_RELEASE_CANDIDATE,
  parseReleaseTag,
} from '../lib/release-tag.mjs';

const CLI = resolve(import.meta.dirname, '../lib/release-tag.mjs');

describe('the shared release tag parser (#4929)', () => {
  it('parses a final tag and a candidate to the same base version', () => {
    expect(parseReleaseTag('v0.2.0')).toEqual({
      tag: 'v0.2.0',
      baseVersion: '0.2.0',
      kind: 'final',
      rc: null,
    });
    expect(parseReleaseTag('v0.2.0-rc.1')).toEqual({
      tag: 'v0.2.0-rc.1',
      baseVersion: '0.2.0',
      kind: 'rc',
      rc: 1,
    });
    expect(parseReleaseTag('v10.20.30-rc.98')).toMatchObject({
      baseVersion: '10.20.30',
      rc: 98,
    });
  });

  it('keeps store slot 99 for the final tag', () => {
    // Pinned beside the constant: native-release-config reserves slot 99.
    expect(MAX_RELEASE_CANDIDATE).toBe(98);
    expect(() => parseReleaseTag('v0.2.0-rc.99')).toThrow(
      'a release candidate is numbered 1-98',
    );
  });

  it.each([
    'v0.2.0-preview.1',
    'v0.2.0-rc.0',
    'v0.2.0-rc.01',
    'v0.2.0-rc',
    'v0.2.0-beta.1',
    'v0.2.0-nightly.1',
    'v01.2.0',
    '0.2.0',
    'v0.2',
    'v0.2.0-rc.1 ',
    '',
    undefined,
  ])('refuses %j', (tag) => {
    expect(isReleaseTag(tag)).toBe(false);
    expect(() => parseReleaseTag(tag)).toThrow();
  });

  it('answers on the command line with exit status and JSON', () => {
    const run = (args: string[]) =>
      spawnSyncBounded(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        windowsHide: true,
      });
    const accepted = run(['v0.2.0-rc.3']);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(String(accepted.stdout))).toEqual({
      tag: 'v0.2.0-rc.3',
      baseVersion: '0.2.0',
      kind: 'rc',
      rc: 3,
    });
    for (const args of [['v0.2.0-preview.1'], [], ['v0.2.0', 'v0.2.1']]) {
      const refused = run(args);
      expect(refused.status, JSON.stringify(args)).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toMatch(/^error: /);
    }
  });
});
