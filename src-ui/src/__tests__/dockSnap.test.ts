import { describe, expect, test } from 'vitest';
import {
  clampDockHeight,
  DEFAULT_DOCK_SNAP,
  DOCK_COLLAPSED_HEIGHT,
  dockFullHeight,
  dockSnapPixels,
  growDockSnap,
  MOBILE_DOCK_COLLAPSE_FLING_VELOCITY,
  MOBILE_DOCK_FLING_VELOCITY,
  nearestDockSnap,
  nextDockSnap,
  resolveMobileDockSnap,
  shouldRestoreDockOnNavigation,
  shrinkDockSnap,
  snapAfterNavigationRestore,
} from '../components/chat-dock/dockSnap';

const metrics = { viewportHeight: 1000, toolbarHeight: 50 };

describe('dockSnap', () => {
  test('cycle order is Collapsed → Half → Full → Collapsed', () => {
    expect(nextDockSnap('collapsed')).toBe('half');
    expect(nextDockSnap('half')).toBe('full');
    expect(nextDockSnap('full')).toBe('collapsed');
  });

  test('grow/shrink clamp at the ends', () => {
    expect(growDockSnap('full')).toBe('full');
    expect(growDockSnap('half')).toBe('full');
    expect(shrinkDockSnap('collapsed')).toBe('collapsed');
    expect(shrinkDockSnap('half')).toBe('collapsed');
  });

  test('default snap is Half', () => {
    expect(DEFAULT_DOCK_SNAP).toBe('half');
  });

  test('collapsed resolves to the header peek height', () => {
    expect(dockSnapPixels('collapsed', metrics)).toBe(DOCK_COLLAPSED_HEIGHT);
  });

  test('collapsed honors a CSS-driven collapsedHeight override (mobile bar)', () => {
    // On mobile --chat-dock-header-height is bumped (e.g. 52px); the snap math
    // must track the real bar height so the Collapsed snap lands on it.
    const mobile = { ...metrics, collapsedHeight: 52 };
    expect(dockSnapPixels('collapsed', mobile)).toBe(52);
    // A live drag near the bar snaps to Collapsed at the larger height.
    expect(nearestDockSnap(54, mobile)).toBe('collapsed');
    // Clamp floor follows the override too.
    expect(clampDockHeight(5, mobile)).toBe(52);
  });

  test('half resolves to ~45% of viewport', () => {
    expect(dockSnapPixels('half', metrics)).toBe(450);
  });

  test('full never exceeds viewport minus toolbar', () => {
    expect(dockSnapPixels('full', metrics)).toBe(950);
    expect(dockFullHeight(metrics)).toBe(950);
  });

  test('clamp keeps a live drag within [collapsed, full]', () => {
    expect(clampDockHeight(5, metrics)).toBe(DOCK_COLLAPSED_HEIGHT);
    expect(clampDockHeight(99999, metrics)).toBe(950);
    expect(clampDockHeight(450, metrics)).toBe(450);
  });

  test('nearestDockSnap picks the closest discrete state', () => {
    expect(nearestDockSnap(40, metrics)).toBe('collapsed');
    expect(nearestDockSnap(440, metrics)).toBe('half');
    expect(nearestDockSnap(900, metrics)).toBe('full');
  });

  test('a release clearly below the Half band collapses (#751: the gesture that opens the dock also puts it away)', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 80,
        deltaY: 120,
        velocityY: 0,
        metrics,
      }),
    ).toBe('collapsed');
    expect(
      resolveMobileDockSnap({
        pixels: 900,
        deltaY: -120,
        velocityY: 0,
        metrics,
      }),
    ).toBe('full');
  });

  // #795: this used to assert that direction wins for a slow drag too, which
  // is what made every upward nudge resolve to Full regardless of where the
  // pointer actually was. A deliberate, unhurried gesture now lands on the
  // snap nearest the release height; flings still own intent (below).
  test('a slow release lands on the nearest snap rather than on the drag direction', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 500, // barely above the Half height (450) — stays Half
        deltaY: -40,
        velocityY: 0,
        metrics,
      }),
    ).toBe('half');
    expect(
      resolveMobileDockSnap({
        pixels: 900, // released up near Full — becomes Full
        deltaY: -40,
        velocityY: 0,
        metrics,
      }),
    ).toBe('full');
    expect(
      resolveMobileDockSnap({
        pixels: 700,
        deltaY: 40,
        velocityY: 0,
        metrics,
      }),
    ).toBe('half');
  });

  test('mobile fling velocity wins even near the opposite snap', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 440,
        deltaY: -8,
        velocityY: -(MOBILE_DOCK_FLING_VELOCITY + 0.1),
        metrics,
      }),
    ).toBe('full');
    expect(
      resolveMobileDockSnap({
        pixels: 900,
        deltaY: 8,
        velocityY: MOBILE_DOCK_FLING_VELOCITY + 0.1,
        metrics,
      }),
    ).toBe('half');
  });

  test('a slow drag ending near Half stays Half — no accidental dismissal', () => {
    // At rest at release (no direction, no fling): the geometric-midpoint
    // fallback, not the Collapsed band, decides — and 460 sits well above the
    // Collapsed/Half midpoint (244) and below the Half/Full midpoint (700).
    expect(
      resolveMobileDockSnap({
        pixels: 460,
        deltaY: 0,
        velocityY: 0,
        metrics,
      }),
    ).toBe('half');
  });

  test('a slow drag ending near Full stays Full', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 800,
        deltaY: 0,
        velocityY: 0,
        metrics,
      }),
    ).toBe('full');
  });

  test('a fast downward flick collapses from Half, skipping the Half snap entirely', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 450, // sitting right at the Half pixel height
        deltaY: 40,
        velocityY: MOBILE_DOCK_COLLAPSE_FLING_VELOCITY + 0.1,
        metrics,
      }),
    ).toBe('collapsed');
  });

  test('a fast downward flick collapses from Full, skipping the Half snap entirely', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 900, // sitting right near the Full pixel height
        deltaY: 40,
        velocityY: MOBILE_DOCK_COLLAPSE_FLING_VELOCITY + 0.1,
        metrics,
      }),
    ).toBe('collapsed');
  });

  test('a moderate downward fling (below the collapse threshold) still only swaps to Half, not Collapsed', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 900,
        deltaY: 8,
        velocityY: MOBILE_DOCK_FLING_VELOCITY + 0.1,
        metrics,
      }),
    ).toBe('half');
    expect(MOBILE_DOCK_FLING_VELOCITY + 0.1).toBeLessThan(
      MOBILE_DOCK_COLLAPSE_FLING_VELOCITY,
    );
  });

  // Real mobile geometry from the adversarial-review repro: viewport 800,
  // collapsed bar 52px → Half ≈ 360px, Collapsed/Half midpoint ≈ 206px.
  // Reopening from Collapsed necessarily starts the drag near the Collapsed
  // pixel height, so the position-based collapse check must never fire for
  // an upward-opening gesture just because it hasn't traveled far yet.
  const reopenMetrics = { viewportHeight: 800, collapsedHeight: 52 };

  test('reopening from Collapsed: a modest upward drag opens the dock, never collapses it', () => {
    // A realistic thumb swipe up (deltaY=-100) that ends well below the
    // Collapsed/Half midpoint (~206px). Position alone would call this
    // Collapsed, which would make an opening gesture close the dock — so the
    // opening guard lifts it to Half. It no longer jumps all the way to Full
    // (#795): a modest drag gets a modest result.
    expect(
      resolveMobileDockSnap({
        pixels: 150,
        deltaY: -100,
        velocityY: 0,
        metrics: reopenMetrics,
      }),
    ).toBe('half');
  });

  test('reopening from Collapsed: a fast upward flick opens to Full even below the midpoint', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 150,
        deltaY: -50,
        velocityY: -1.0,
        metrics: reopenMetrics,
      }),
    ).toBe('full');
  });

  test('a downward release below the midpoint still collapses (unchanged by the direction gate)', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 150,
        deltaY: 100,
        velocityY: 0,
        metrics: reopenMetrics,
      }),
    ).toBe('collapsed');
  });

  // #795, as reported: phone 390x844, dock at Half (380px). Both a 60px and a
  // 200px upward drag used to land on Full (788px) — the chosen height was
  // ignored entirely.
  test('the reported phone geometry: a small drag holds Half, a large one reaches Full', () => {
    const phone = {
      viewportHeight: 844,
      toolbarHeight: 56,
      collapsedHeight: 52,
    };

    expect(
      resolveMobileDockSnap({
        pixels: 440, // Half (380) + 60
        deltaY: -60,
        velocityY: 0,
        metrics: phone,
      }),
    ).toBe('half');

    expect(
      resolveMobileDockSnap({
        pixels: 580, // Half + 200
        deltaY: -200,
        velocityY: 0,
        metrics: phone,
      }),
    ).toBe('half');

    expect(
      resolveMobileDockSnap({
        pixels: 700, // past the Half/Full midpoint (584)
        deltaY: -320,
        velocityY: 0,
        metrics: phone,
      }),
    ).toBe('full');
  });
});

// #869: a maximized dock is opaque and full-height, so a route change moved the
// view underneath it while nothing visibly happened. Dock state lives in the
// query string and `navigate()` preserves it, so `maximize=true` survived.
describe('shouldRestoreDockOnNavigation (#869)', () => {
  test('restores a maximized dock when the pathname actually changes', () => {
    expect(
      shouldRestoreDockOnNavigation({
        previousPathname: '/',
        pathname: '/connections/providers',
        isDockMaximized: true,
      }),
    ).toBe(true);
  });

  test('leaves a dock that is not maximized alone', () => {
    expect(
      shouldRestoreDockOnNavigation({
        previousPathname: '/',
        pathname: '/connections/providers',
        isDockMaximized: false,
      }),
    ).toBe(false);
  });

  // The dock writes its own `dock`/`maximize` params, so a query-only update
  // must not collapse a dock the user just maximized.
  test('ignores a re-render or query-only update on the same pathname', () => {
    expect(
      shouldRestoreDockOnNavigation({
        previousPathname: '/projects/alpha',
        pathname: '/projects/alpha',
        isDockMaximized: true,
      }),
    ).toBe(false);
  });
});

// #869 review: restoring only `isDockMaximized` is not enough. The mobile
// snap-sync effect computes `isDockMaximized ? 'full' : dockSnap`, so clearing
// the flag while the snap still says Full makes it re-expand and undo the
// restore — and the persisted snap doubles as "previous size", so it would
// reopen full-height later while the flag disagreed.
describe('snapAfterNavigationRestore (#869)', () => {
  test('steps a Full snap back to the default open size', () => {
    expect(snapAfterNavigationRestore('full')).toBe(DEFAULT_DOCK_SNAP);
    expect(DEFAULT_DOCK_SNAP).not.toBe('full');
  });

  test('leaves an already-coherent snap alone', () => {
    expect(snapAfterNavigationRestore('half')).toBeNull();
    expect(snapAfterNavigationRestore('collapsed')).toBeNull();
  });
});
