import { describe, expect, it } from 'vitest';
import {
  foldSplitWithin,
  geometryFromNativeSnapshot,
  geometryFromViewportSegments,
  type NativeFoldSnapshot,
  parseNativeFoldSnapshot,
} from '../foldGeometry';
import {
  bookSnapshot,
  flatSnapshot,
  laptopSnapshot,
  launchSnapshot,
  tentCoverSnapshot,
} from './nativeFoldFixtures';

describe('parseNativeFoldSnapshot (the station-fold `state` reply)', () => {
  it('accepts every reply shape StationFoldPlugin.swift was captured encoding', () => {
    for (const snapshot of [
      bookSnapshot,
      flatSnapshot,
      laptopSnapshot,
      tentCoverSnapshot,
    ])
      expect(parseNativeFoldSnapshot(snapshot)).toEqual(snapshot);
  });

  it.each([
    ['a missing revision', { ...bookSnapshot, revision: undefined }],
    ['revision 0', { ...bookSnapshot, revision: 0 }],
    [
      'an unknown hinge status',
      {
        ...bookSnapshot,
        hinge: { status: 'ajar', angle: 90 },
      },
    ],
    [
      'a non-finite region',
      {
        ...bookSnapshot,
        regions: [{ x: Number.NaN, y: 0, width: 0, height: 669 }],
      },
    ],
    [
      'a negative region size',
      {
        ...bookSnapshot,
        regions: [{ x: 475, y: 0, width: -1, height: 669 }],
      },
    ],
    [
      'too many regions',
      {
        ...bookSnapshot,
        regions: Array.from({ length: 5 }, () => bookSnapshot.regions[0]),
      },
    ],
    ['no viewport', { ...bookSnapshot, viewport: undefined }],
  ])('refuses %s as a whole', (_label, value) => {
    expect(parseNativeFoldSnapshot(value)).toBeNull();
  });
});

describe('geometryFromNativeSnapshot', () => {
  it('reads Book (partially open, vertical crease) as folded', () => {
    const region = bookSnapshot.regions[0];
    expect(geometryFromNativeSnapshot(bookSnapshot, 951)).toEqual({
      source: 'native',
      posture: 'folded',
      axis: 'vertical',
      hinge: region,
    });
  });

  it('reads a fully open hinge as flat, keeping the crease', () => {
    expect(geometryFromNativeSnapshot(flatSnapshot, 951)?.posture).toBe('flat');
  });

  it('scales native points to CSS pixels when the page is zoomed', () => {
    const geometry = geometryFromNativeSnapshot(bookSnapshot, 951 * 2);
    expect(geometry?.hinge.x).toBe(bookSnapshot.regions[0].x * 2);
  });

  it('reads Laptop (horizontal crease) as a horizontal axis', () => {
    expect(geometryFromNativeSnapshot(laptopSnapshot, 669)).toMatchObject({
      posture: 'folded',
      axis: 'horizontal',
      hinge: laptopSnapshot.regions[0],
    });
  });

  it('reads the launch reply (hinge key absent) and the Tent cover as no crease', () => {
    const launch = parseNativeFoldSnapshot(launchSnapshot);
    expect(launch?.hinge).toBeNull();
    expect(geometryFromNativeSnapshot(launch!, 951)).toBeNull();
    expect(geometryFromNativeSnapshot(tentCoverSnapshot, 678)).toBeNull();
  });

  it.each<[string, NativeFoldSnapshot]>([
    ['an unsupported OS', { ...bookSnapshot, supported: false }],
    [
      'no division region (the cover display)',
      { ...bookSnapshot, regions: [] },
    ],
    [
      'two regions',
      {
        ...bookSnapshot,
        regions: [...bookSnapshot.regions, ...bookSnapshot.regions],
      },
    ],
    [
      'a closed hinge',
      { ...bookSnapshot, hinge: { status: 'closed', angle: 0 } },
    ],
    [
      'a region that does not cross the viewport (a cut-out)',
      {
        ...bookSnapshot,
        regions: [{ x: 400, y: 0, width: 80, height: 40 }],
      },
    ],
  ])('reports no crease for %s', (_label, snapshot) => {
    expect(geometryFromNativeSnapshot(snapshot, 951)).toBeNull();
  });
});

describe('geometryFromViewportSegments (the CSS fallback)', () => {
  it('derives a vertical crease from two side-by-side segments', () => {
    expect(
      geometryFromViewportSegments(
        [
          { x: 0, y: 0, width: 470, height: 669 },
          { x: 480, y: 0, width: 471, height: 669 },
        ],
        'folded',
      ),
    ).toEqual({
      source: 'viewport-segments',
      posture: 'folded',
      axis: 'vertical',
      hinge: { x: 470, y: 0, width: 10, height: 669 },
    });
  });

  it('takes a continuous posture as flat', () => {
    expect(
      geometryFromViewportSegments(
        [
          { x: 0, y: 0, width: 475, height: 669 },
          { x: 475, y: 0, width: 476, height: 669 },
        ],
        'continuous',
      )?.posture,
    ).toBe('flat');
  });

  it('reports nothing for one segment or none', () => {
    expect(
      geometryFromViewportSegments(
        [{ x: 0, y: 0, width: 951, height: 669 }],
        'folded',
      ),
    ).toBeNull();
    expect(geometryFromViewportSegments(null, undefined)).toBeNull();
  });
});

describe('foldSplitWithin', () => {
  const book = geometryFromNativeSnapshot(bookSnapshot, 951)!;
  const crease = bookSnapshot.regions[0];

  it('measures the crease from the element’s own edges', () => {
    // The Book shell's main column: right of a 216px sidebar.
    expect(
      foldSplitWithin({ left: 216, top: 0, width: 735, height: 669 }, book),
    ).toEqual({
      axis: 'vertical',
      start: Math.round(crease.x - 216),
      gap: Math.round(crease.width),
      end: Math.round(951 - (crease.x + crease.width)),
      larger: 'end',
    });
  });

  it('is null when the element sits wholly on one side', () => {
    expect(
      foldSplitWithin({ left: 0, top: 0, width: 216, height: 669 }, book),
    ).toBeNull();
  });

  it('is null when the display is flat', () => {
    const flat = geometryFromNativeSnapshot(flatSnapshot, 951);
    expect(
      foldSplitWithin({ left: 0, top: 0, width: 951, height: 669 }, flat),
    ).toBeNull();
  });
});
