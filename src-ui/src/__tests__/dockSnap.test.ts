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
  shouldCollapseDockOnMobileNavigation,
  shouldRestoreDockOnNavigation,
  shrinkDockSnap,
  snapAfterNavigationRestore,
} from '../components/chat-dock/dockSnap';

const metrics = { viewportHeight: 1000, toolbarHeight: 50 };

describe('dockSnap', () => {
  test('cycle order is Collapsed → Half → Tall → Full → Collapsed', () => {
    expect(nextDockSnap('collapsed')).toBe('half');
    expect(nextDockSnap('half')).toBe('tall');
    expect(nextDockSnap('tall')).toBe('full');
    expect(nextDockSnap('full')).toBe('collapsed');
  });

  test('grow/shrink clamp at the ends', () => {
    expect(growDockSnap('full')).toBe('full');
    expect(shrinkDockSnap('collapsed')).toBe('collapsed');
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

  // A desktop dock is dragged freely; Half is only the size it opens at, so
  // it keeps a plain 45% however short the window is.
  test('half resolves to ~45% of viewport', () => {
    expect(dockSnapPixels('half', metrics)).toBe(450);
    expect(dockSnapPixels('half', { ...metrics, viewportHeight: 667 })).toBe(
      300,
    );
  });

  // At 300px on a 667px-tall phone the bar and a three-line composer left
  // about 105px of transcript, less than one message, so a phone's Half is
  // never shorter than a 390x844 phone's.
  test.each([
    [667, 380],
    [740, 380],
    [780, 380],
    [812, 380],
    [844, 380],
    [915, 412],
  ] as const)('on a phone %ipx tall, Half is %ipx', (viewportHeight, half) => {
    expect(dockSnapPixels('half', { viewportHeight, phone: true })).toBe(half);
  });

  // The floor stops a level's gap short of Tall, so it tapers away on a short
  // viewport instead of putting Half on or above Tall. Landscape phones are
  // the short case; a window that short shows an open dock at full height
  // anyway (index.css, max-height 540px).
  test.each([
    [600, 350],
    [500, 275],
    [412, 209],
    [375, 200],
  ] as const)(
    'on a phone %ipx tall, the floor leaves Half at %ipx, below Tall',
    (viewportHeight, half) => {
      const phone = { viewportHeight, phone: true };
      expect(dockSnapPixels('half', phone)).toBe(half);
      expect(dockSnapPixels('tall', phone)).toBeGreaterThan(half);
    },
  );

  test('tall resolves to ~75% of viewport, between Half and Full', () => {
    expect(dockSnapPixels('tall', metrics)).toBe(750);
  });

  // A level is only reachable by drag while its band is wide enough to land
  // in. On every portrait phone height the three open levels stay at least
  // 100px apart, so Half's 380px floor never folds Tall onto Half and the
  // toolbar never folds Full onto Tall.
  test.each([640, 667, 780, 812, 915])(
    'keeps the open levels at least 100px apart on a %ipx-tall phone',
    (viewportHeight) => {
      const phone = {
        viewportHeight,
        toolbarHeight: 52,
        collapsedHeight: 53,
        phone: true,
      };
      const [half, tall, full] = (['half', 'tall', 'full'] as const).map(
        (snap) => dockSnapPixels(snap, phone),
      );
      expect(tall - half).toBeGreaterThanOrEqual(100);
      expect(full - tall).toBeGreaterThanOrEqual(100);
    },
  );

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
    expect(nearestDockSnap(700, metrics)).toBe('tall');
    expect(nearestDockSnap(900, metrics)).toBe('full');
  });

  test('a release clearly below the Half band collapses (#751: the gesture that opens the dock also puts it away)', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 80,
        deltaY: 120,
        velocityY: 0,
        start: 'half',
        metrics,
      }),
    ).toBe('collapsed');
    expect(
      resolveMobileDockSnap({
        pixels: 900,
        deltaY: -120,
        velocityY: 0,
        start: 'collapsed',
        metrics,
      }),
    ).toBe('full');
  });

  // archive#795: this used to assert that direction wins for a slow drag too, which
  // is what made every upward nudge resolve to Full regardless of where the
  // pointer actually was. A deliberate, unhurried gesture now lands on the
  // snap nearest the release height; flings still own intent (below).
  test('a slow release lands on the nearest snap rather than on the drag direction', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 500, // barely above the Half height (450) — stays Half
        deltaY: -40,
        velocityY: 0,
        start: 'half',
        metrics,
      }),
    ).toBe('half');
    expect(
      resolveMobileDockSnap({
        pixels: 900, // released up near Full — becomes Full
        deltaY: -40,
        velocityY: 0,
        start: 'tall',
        metrics,
      }),
    ).toBe('full');
    // Dragged down from Full but released 250px above Half and 50px below
    // Tall: it lands where the finger is, not back on Half.
    expect(
      resolveMobileDockSnap({
        pixels: 700,
        deltaY: 40,
        velocityY: 0,
        start: 'full',
        metrics,
      }),
    ).toBe('tall');
  });

  test('mobile fling velocity wins even near the opposite snap', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 440,
        deltaY: -8,
        velocityY: -(MOBILE_DOCK_FLING_VELOCITY + 0.1),
        start: 'half',
        metrics,
      }),
    ).toBe('full');
    // Released next to Full, but a downward fling leaves it — one level.
    expect(
      resolveMobileDockSnap({
        pixels: 900,
        deltaY: 8,
        velocityY: MOBILE_DOCK_FLING_VELOCITY + 0.1,
        start: 'full',
        metrics,
      }),
    ).toBe('tall');
  });

  test('a slow drag ending near Half stays Half — no accidental dismissal', () => {
    // At rest at release (no direction, no fling): the nearest level, not a
    // direction, decides — and 460 sits well above the Collapsed/Half
    // midpoint (244) and below the Half/Tall midpoint (600).
    expect(
      resolveMobileDockSnap({
        pixels: 460,
        deltaY: 0,
        velocityY: 0,
        start: 'half',
        metrics,
      }),
    ).toBe('half');
  });

  test('a slow drag ending near Full stays Full', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 900,
        deltaY: 0,
        velocityY: 0,
        start: 'full',
        metrics,
      }),
    ).toBe('full');
    // 800 is nearer Tall (750) than Full (950).
    expect(
      resolveMobileDockSnap({
        pixels: 800,
        deltaY: 0,
        velocityY: 0,
        start: 'full',
        metrics,
      }),
    ).toBe('tall');
  });

  test('a fast downward flick collapses from Half, skipping the Half snap entirely', () => {
    expect(
      resolveMobileDockSnap({
        pixels: 450, // sitting right at the Half pixel height
        deltaY: 40,
        velocityY: MOBILE_DOCK_COLLAPSE_FLING_VELOCITY + 0.1,
        start: 'half',
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
        start: 'full',
        metrics,
      }),
    ).toBe('collapsed');
  });

  test('a moderate downward fling steps down one level and never collapses', () => {
    const fling = MOBILE_DOCK_FLING_VELOCITY + 0.1;
    expect(fling).toBeLessThan(MOBILE_DOCK_COLLAPSE_FLING_VELOCITY);

    // Full → Tall: the level a conversation can still be read at.
    expect(
      resolveMobileDockSnap({
        pixels: 900,
        deltaY: 8,
        velocityY: fling,
        start: 'full',
        metrics,
      }),
    ).toBe('tall');
    expect(
      resolveMobileDockSnap({
        pixels: 700,
        deltaY: 8,
        velocityY: fling,
        start: 'tall',
        metrics,
      }),
    ).toBe('half');
    // Half stays open, and the collapsed bar stays put: putting the dock
    // away takes the decisive flick above.
    expect(
      resolveMobileDockSnap({
        pixels: 400,
        deltaY: 8,
        velocityY: fling,
        start: 'half',
        metrics,
      }),
    ).toBe('half');
    expect(
      resolveMobileDockSnap({
        pixels: 40,
        deltaY: 20,
        velocityY: fling,
        start: 'collapsed',
        metrics,
      }),
    ).toBe('collapsed');
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
    // (archive#795): a modest drag gets a modest result.
    expect(
      resolveMobileDockSnap({
        pixels: 150,
        deltaY: -100,
        velocityY: 0,
        start: 'collapsed',
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
        start: 'collapsed',
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
        start: 'collapsed',
        metrics: reopenMetrics,
      }),
    ).toBe('collapsed');
  });

  // archive#795, as reported: phone 390x844, dock at Half (380px). Both a 60px and a
  // 200px upward drag used to land on Full (788px) — the chosen height was
  // ignored entirely.
  test('the reported phone geometry: a small drag holds Half, a large one reaches Tall, a full swipe Full', () => {
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
        start: 'half',
        metrics: phone,
      }),
    ).toBe('half');

    // Half + 200 sits 53px from Tall (633) and 200px from Half.
    expect(
      resolveMobileDockSnap({
        pixels: 580, // Half + 200
        deltaY: -200,
        velocityY: 0,
        start: 'half',
        metrics: phone,
      }),
    ).toBe('tall');

    expect(
      resolveMobileDockSnap({
        pixels: 740, // past the Tall/Full midpoint (710)
        deltaY: -360,
        velocityY: 0,
        start: 'half',
        metrics: phone,
      }),
    ).toBe('full');
  });
});

// archive#869: a maximized dock is opaque and full-height, so a route change moved the
// view underneath it while nothing visibly happened. Dock state lives in the
// query string and `navigate` preserves it, so `maximize=true` survived.
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

describe('shouldCollapseDockOnMobileNavigation', () => {
  test('collapses an open phone dock when the pathname changes', () => {
    expect(
      shouldCollapseDockOnMobileNavigation({
        previousPathname: '/',
        pathname: '/settings',
        isMobile: true,
        isDockOpen: true,
      }),
    ).toBe(true);
  });

  test('leaves a desktop dock alone', () => {
    expect(
      shouldCollapseDockOnMobileNavigation({
        previousPathname: '/',
        pathname: '/settings',
        isMobile: false,
        isDockOpen: true,
      }),
    ).toBe(false);
  });

  test('ignores query-only updates on the same pathname', () => {
    expect(
      shouldCollapseDockOnMobileNavigation({
        previousPathname: '/',
        pathname: '/',
        isMobile: true,
        isDockOpen: true,
      }),
    ).toBe(false);
  });
});

// archive#869: restoring only `isDockMaximized` is not enough. The mobile
// snap-sync effect computes `isDockMaximized ? 'full' : dockSnap`, so clearing
// the flag while the snap still says Full makes it re-expand and undo the
// restore — and the persisted snap doubles as "previous size", so it would
// reopen full-height later while the flag disagreed.
describe('snapAfterNavigationRestore (#869)', () => {
  test('steps a Full snap back to the default open size', () => {
    expect(snapAfterNavigationRestore('full')).toBe(DEFAULT_DOCK_SNAP);
    expect(DEFAULT_DOCK_SNAP).not.toBe('full');
  });

  // A Tall dock whose maximize ends from outside the shell must come back to
  // Tall: the mobile snap-sync re-derives the height from this value, so
  // defaulting to Half would shrink a dock the person had set to Tall.
  test('steps a Full snap back to the level the dock was maximized from', () => {
    expect(snapAfterNavigationRestore('full', 'tall')).toBe('tall');
    expect(snapAfterNavigationRestore('full', 'half')).toBe('half');
  });

  test('returns a dock maximized from its bar to the default, never to closed', () => {
    expect(snapAfterNavigationRestore('full', 'collapsed')).toBe(
      DEFAULT_DOCK_SNAP,
    );
    expect(DEFAULT_DOCK_SNAP).not.toBe('collapsed');
  });

  test('leaves an already-coherent snap alone', () => {
    expect(snapAfterNavigationRestore('half')).toBeNull();
    expect(snapAfterNavigationRestore('tall')).toBeNull();
    expect(snapAfterNavigationRestore('collapsed')).toBeNull();
  });
});
