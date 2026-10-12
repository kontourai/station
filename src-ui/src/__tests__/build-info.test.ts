// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { readBuildInfo, readClientReleaseVersion } from '../build-info';

function documentWith(head: string): Document {
  return new DOMParser().parseFromString(
    `<html><head>${head}</head><body></body></html>`,
    'text/html',
  );
}

describe('build info metadata', () => {
  it('reads the exact version and commit pair', () => {
    const page = documentWith(`
      <meta name="station-build-version" content="1.2.3">
      <meta name="station-build-commit" content="abcdef01">
    `);

    expect(readBuildInfo(page)).toEqual({
      version: '1.2.3',
      commit: 'abcdef01',
    });
  });

  it.each([
    ['', 'missing metadata'],
    [
      '<meta name="station-build-version" content="1.2.3">',
      'incomplete metadata',
    ],
    [
      '<meta name="station-build-version" content="1.2.3"><meta name="station-build-version" content="2.0.0"><meta name="station-build-commit" content="abcdef01">',
      'duplicate metadata',
    ],
    [
      '<meta name="station-build-version" content=""><meta name="station-build-commit" content="abcdef01">',
      'empty metadata',
    ],
  ])('uses the development fallback for %s (%s)', (head) => {
    expect(readBuildInfo(documentWith(head))).toEqual({
      version: '0.0.0',
      commit: 'dev',
    });
  });

  it('uses the development fallback without a DOM', () => {
    expect(readBuildInfo(undefined)).toEqual({
      version: '0.0.0',
      commit: 'dev',
    });
  });

  describe('client release version', () => {
    const identity =
      '<meta name="station-build-version" content="0.1.11-nightly.2465"><meta name="station-build-commit" content="abcdef01">';

    it('is the version only when a release pipeline stamped the build', () => {
      expect(
        readClientReleaseVersion(
          documentWith(
            `${identity}<meta name="station-build-release" content="true">`,
          ),
        ),
      ).toBe('0.1.11-nightly.2465');
    });

    it.each([
      ['an unstamped (local or dev) build', identity],
      [
        'a stamp that is not true',
        `${identity}<meta name="station-build-release" content="false">`,
      ],
      [
        'a duplicated stamp',
        `${identity}<meta name="station-build-release" content="true"><meta name="station-build-release" content="true">`,
      ],
      [
        'a stamp without an identity',
        '<meta name="station-build-release" content="true">',
      ],
    ])('is null for %s', (_label, head) => {
      expect(readClientReleaseVersion(documentWith(head))).toBeNull();
    });

    it('is null without a DOM', () => {
      expect(readClientReleaseVersion(undefined)).toBeNull();
    });
  });
});
