import type { NativeFoldSnapshot } from '../foldGeometry';

/*
 * Exact `state` replies from StationFoldPlugin.swift, captured from its DEBUG
 * log on the iOS 27.1 iPhone Duo simulator (2026-11-04), one per posture.
 * The plugin encodes with JSONEncoder, so a missing hinge is an ABSENT key,
 * not null (`launchSnapshot`). The division region's 40pt width includes the
 * system's interactive margins around the crease.
 */

/** First reading at launch, before UIHingeInteraction's first update. */
export const launchSnapshot = {
  revision: 1,
  supported: true,
  regions: [],
  viewport: { width: 951, height: 669 },
} as unknown as NativeFoldSnapshot;

/** Book: inner display landscape, hinge at 90 degrees, vertical crease. */
export const bookSnapshot: NativeFoldSnapshot = {
  viewport: { height: 669, width: 951 },
  regions: [{ x: 455.5, y: 0, height: 669, width: 40 }],
  supported: true,
  revision: 5,
  hinge: { status: 'partially-open', angle: 90 },
};

/** Open flat: the crease is still reported, the hinge fully open. */
export const flatSnapshot: NativeFoldSnapshot = {
  hinge: { status: 'fully-open', angle: 180 },
  revision: 6,
  supported: true,
  regions: [{ width: 40, y: 0, x: 455.5, height: 669 }],
  viewport: { width: 951, height: 669 },
};

/** Laptop: inner display portrait, horizontal crease. */
export const laptopSnapshot: NativeFoldSnapshot = {
  hinge: { status: 'partially-open', angle: 90 },
  supported: true,
  regions: [{ height: 40, width: 669, x: 0, y: 455.5 }],
  revision: 9,
  viewport: { width: 669, height: 951 },
};

/** Tent: the app is on the cover display, which has no division. */
export const tentCoverSnapshot: NativeFoldSnapshot = {
  supported: true,
  viewport: { height: 466, width: 678 },
  revision: 12,
  hinge: { status: 'partially-open', angle: 80.6 },
  regions: [],
};

/*
 * A cold launch on a device already in Book (2026-11-05, same simulator):
 * the plugin's first reading has no hinge and no region, the second, about
 * half a second later, has both. No posture change happens in between.
 */
export const coldLaunchFirstSnapshot = {
  viewport: { height: 669, width: 951 },
  supported: true,
  regions: [],
  revision: 1,
} as unknown as NativeFoldSnapshot;

export const coldLaunchBookSnapshot: NativeFoldSnapshot = {
  hinge: { status: 'partially-open', angle: 90 },
  viewport: { width: 951, height: 669 },
  supported: true,
  revision: 2,
  regions: [{ height: 669, x: 455.5, width: 40, y: 0 }],
};
