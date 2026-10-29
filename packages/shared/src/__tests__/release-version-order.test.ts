import { describe, expect, test } from 'vitest';
import {
  clientVersionInHostOrder,
  compareStationReleaseVersions,
  hostNightlyAllocation,
} from '../release-version-order.js';

// The two writers whose shapes this module bridges. Plain ESM scripts with no
// types, loaded by path, so the bridge is pinned to the real allocators rather
// than to a copy of their arithmetic.
const NIGHTLY_IDENTITY = '../../../../scripts/lib/nightly-build-identity.mjs';
const PORTABLE_NIGHTLY = '../../../../scripts/portable-nightly-publication.mjs';
const { nightlyVersion, nightlyVersionCode } = (await import(
  NIGHTLY_IDENTITY
)) as {
  nightlyVersion: (pkg: string, date: Date, build?: number) => string;
  nightlyVersionCode: (date: Date, build?: number) => number;
};
const { portableNightlyVersion } = (await import(PORTABLE_NIGHTLY)) as {
  portableNightlyVersion: (pkg: string, code: number | string) => string;
};

describe('clientVersionInHostOrder', () => {
  test.each([
    [0, '2026-10-01T00:00:00Z'],
    [2, '2026-10-01T00:00:00Z'],
    [99, '2027-03-15T00:00:00Z'],
  ])(
    'a native Nightly (build %s, %s) names the portable Nightly of the same allocation',
    (build, iso) => {
      const date = new Date(iso);
      const client = nightlyVersion('0.1.11', date, build);
      const host = portableNightlyVersion(
        '0.1.11',
        nightlyVersionCode(date, build),
      );
      expect(clientVersionInHostOrder(client)).toBe(host);
      expect(
        compareStationReleaseVersions(clientVersionInHostOrder(client)!, host),
      ).toBe(0);
    },
  );

  test('literal shapes, independent of the allocators above', () => {
    // Day 2463, build 2 is version code 246302 (the issue's observed pair).
    expect(clientVersionInHostOrder('0.1.11-nightly.2463.2')).toBe(
      '0.1.11-nightly.246302',
    );
    expect(clientVersionInHostOrder('0.1.11-nightly.2463')).toBe(
      '0.1.11-nightly.246300',
    );
    expect(clientVersionInHostOrder('0.2.0')).toBe('0.2.0');
    expect(clientVersionInHostOrder('0.2.0-preview.3')).toBe('0.2.0-preview.3');
  });

  test('a later night outranks an earlier one once both are in host order', () => {
    const client = clientVersionInHostOrder('0.1.11-nightly.2465')!;
    expect(compareStationReleaseVersions(client, '0.1.11-nightly.246303')).toBe(
      1,
    );
    // Without the bridge, the raw day number reads as far older.
    expect(
      compareStationReleaseVersions(
        '0.1.11-nightly.2465',
        '0.1.11-nightly.246303',
      ),
    ).toBe(-1);
  });

  test.each([
    '0.0.0-dev',
    'v0.2.0',
    '0.2',
    '0.1.11-nightly.2463.100',
    '0.1.11-nightly.0',
    '0.1.11-nightly.2463.0',
    '',
  ])('refuses %j', (version) => {
    expect(clientVersionInHostOrder(version)).toBeNull();
  });
});

describe('hostNightlyAllocation', () => {
  test.each([
    [0, '2026-09-29T00:00:00Z'],
    [3, '2026-09-29T00:00:00Z'],
    [99, '2027-03-15T00:00:00Z'],
  ])(
    'reads back the day and build the allocator encoded (build %s, %s)',
    (build, iso) => {
      const date = new Date(iso);
      const version = portableNightlyVersion(
        '0.1.11',
        nightlyVersionCode(date, build),
      );
      expect(hostNightlyAllocation(version)).toEqual({ date, build });
    },
  );

  test('reads the dated shape #2962 introduces', () => {
    expect(hostNightlyAllocation('0.1.11-nightly.20261011.2')).toEqual({
      date: new Date('2026-10-11T00:00:00Z'),
      build: 2,
    });
  });

  test.each([
    '0.1.11',
    '0.1.11-preview.3',
    '0.1.11-nightly.20260230.1',
    // A dated Nightly missing its build is not a version code (year 2574).
    '0.1.11-nightly.20261001',
    'x',
  ])('is null for %j', (version) => {
    expect(hostNightlyAllocation(version)).toBeNull();
  });
});

describe('compareStationReleaseVersions', () => {
  // The browser-safe export must order exactly as the installers and the
  // server do; it delegates to accepted-release.mjs rather than copying it.
  test.each<[string, string, -1 | 0 | 1 | null]>([
    ['1.2.3', '1.2.3', 0],
    ['1.2.4', '1.2.3', 1],
    ['1.2.3', '1.2.3-preview.9', 1],
    ['1.2.3-nightly.1', '1.2.3', -1],
    ['1.2.3-preview.10', '1.2.3-preview.9', 1],
    ['1.2.3-preview.1', '1.2.3-nightly.1', null],
    ['v1.2.3', '1.2.3', null],
  ])('%s against %s is %s', (left, right, order) => {
    expect(compareStationReleaseVersions(left, right)).toBe(order);
  });
});
