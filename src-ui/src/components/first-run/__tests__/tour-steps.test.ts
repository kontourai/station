import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolvePageFrame } from '../../../app-shell/page-frame-registry';
import {
  getLegacyPathRedirect,
  getPathForView,
  resolveViewFromPath,
} from '../../../app-shell/routing';
import { APP_SURFACE_REGISTRY } from '../../../app-shell/surface-registry';
import { REGION_SURFACE_REGISTRY } from '../../../regions/region-model';
import {
  FIRST_RUN_ANCHOR_ATTRIBUTE,
  FIRST_RUN_TOUR_STEPS,
  tourStepIndexForId,
  tourStepPath,
} from '../tour-steps';

/**
 * Post-archive#2678 the repo has one canonical spelling per surface plus a central
 * retirement table. A tour anchored on a retired spelling would still *work*
 * (the redirect catches it) and would quietly put the retired name back into
 * the product — which is the exact failure the one-name-per-concept work
 * existed to end.
 *
 * Every assertion below derives its expectation from the routing module. No
 * path literal appears in this file, so a route rename cannot leave the tour
 * pointing at a stale string while the test keeps passing on a copy of it.
 */
describe('first-run tour anchors resolve to canonical routes', () => {
  test('every declared region surface is registered', () => {
    for (const step of FIRST_RUN_TOUR_STEPS) {
      if ('surface' in step && step.surface)
        expect(REGION_SURFACE_REGISTRY.has(step.surface)).toBe(true);
    }
    for (const surface of APP_SURFACE_REGISTRY.getPalette()) {
      if (surface.regionSurface)
        expect(REGION_SURFACE_REGISTRY.has(surface.regionSurface)).toBe(true);
    }
  });
  test.each(FIRST_RUN_TOUR_STEPS)(
    'step $id derives a serializable canonical path',
    (step) => {
      // A shell-owned surface step is revealed, not navigated to, and #928
      // left Activity with no `NavigationView` to name at all — so a null
      // path there is the contract, and a non-null one would mean the step
      // had gone back to spelling a route.
      if ('view' in step) {
        expect('surface' in step).toBe(false);
        expect(tourStepPath(step)).toBe(getPathForView(step.view));
        expect(tourStepPath(step)).not.toBeNull();
      } else {
        expect('surface' in step && step.surface).toBeTruthy();
        expect(tourStepPath(step)).toBeNull();
      }
    },
  );

  test.each(FIRST_RUN_TOUR_STEPS)(
    'step $id does not point at a retired spelling',
    (step) => {
      const path = tourStepPath(step);
      // Non-null here means `getLegacyPathRedirect` recognised the path as a
      // retired name it must rewrite — i.e. the tour is spelling a legacy
      // route.
      if (path) expect(getLegacyPathRedirect(path)).toBeNull();
    },
  );

  test.each(FIRST_RUN_TOUR_STEPS)(
    'step $id round-trips back to the view it declared',
    (step) => {
      const path = tourStepPath(step);
      if (path && 'view' in step)
        expect(resolveViewFromPath(path)).toEqual(step.view);
    },
  );

  test('every step is distinct and the tour is 3-4 steps', () => {
    const ids = FIRST_RUN_TOUR_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(FIRST_RUN_TOUR_STEPS.length).toBeGreaterThanOrEqual(3);
    expect(FIRST_RUN_TOUR_STEPS.length).toBeLessThanOrEqual(4);
  });

  test('every anchor exists in shipped UI source', () => {
    // An anchor naming an element nobody renders is a coachmark that always
    // falls back to unanchored — it looks fine and teaches nothing about the
    // surface it claims to point at.
    //
    // accepting the `nav-${type}` template alone was partly vacuous
    // it proved the sidebar CAN emit `nav-*` anchors, not that the specific
    // group a step names is still in the list. So a `nav-` anchor is checked
    // against the actual nav registry, which is what decides whether that
    // element renders at all.
    const sources = [
      'views/ReviewQueueView.tsx',
      'views/ScheduleView.tsx',
      'views/SessionsView.tsx',
      'components/project-sidebar/ProjectSidebarStatus.tsx',
    ]
      .map((relative) =>
        readFileSync(join(__dirname, '../../..', relative), 'utf8'),
      )
      .join('\n');
    const navGroups = new Set(
      APP_SURFACE_REGISTRY.getSidebar().flatMap((surface) =>
        surface.managementGroup ? [surface.managementGroup] : [],
      ),
    );

    for (const step of FIRST_RUN_TOUR_STEPS) {
      if (step.anchor.startsWith('nav-')) {
        // The group this step names must still be registered. The sidebar's
        // rendered anchor is covered by ProjectSidebarNav's DOM contract.
        expect(
          navGroups,
          `sidebar nav registry no longer contains "${step.anchor.slice(4)}"`,
        ).toContain(step.anchor.slice('nav-'.length));
        continue;
      }
      // Three ways an anchor reaches the DOM, all of them proof that some
      // element carries it:
      //   - the attribute spelled directly on an element;
      //   - `SplitPaneLayout`'s `firstRunAnchor` prop, which renders the same
      //     attribute on the layout root (the rendered result is pinned by
      //     `SessionsView.test.tsx`'s DOM assertion, so this literal check is
      //     the source-of-the-anchor half, not the whole proof);
      //   - the route's frame spec, since SHELL-11 moved the page shell out of
      //     the views: `page-frame-registry.ts` declares the anchor and
      //     `PageFrame` renders it on the frame root (pinned by
      //     `PageFrame.test.tsx`). This one is READ, not grepped — the route
      //     table is a value, so the test asks it rather than its source text.
      const literal = `${FIRST_RUN_ANCHOR_ATTRIBUTE}="${step.anchor}"`;
      const propLiteral = `firstRunAnchor="${step.anchor}"`;
      // A shell-owned surface step has no route, so no frame can declare its
      // anchor — only the two source-literal channels above are open to it.
      const framedAnchor =
        'view' in step
          ? resolvePageFrame(step.view)?.firstRunAnchor
          : undefined;
      expect(
        sources.includes(literal) ||
          sources.includes(propLiteral) ||
          framedAnchor === step.anchor,
        `no shipped element carries ${literal}: the route's frame declares ` +
          `${framedAnchor ?? 'no anchor'}`,
      ).toBe(true);
    }
  });
});

describe('tourStepIndexForId', () => {
  test('finds a live step', () => {
    expect(tourStepIndexForId(FIRST_RUN_TOUR_STEPS[2].id)).toBe(2);
  });

  test('restarts rather than guessing for an absent or retired id', () => {
    expect(tourStepIndexForId(undefined)).toBe(0);
    expect(tourStepIndexForId('a-step-that-was-removed')).toBe(0);
  });

  // archive#3280: tourStepId is durable resume state; the sessions->activity
  // step rename must keep previously persisted ids resolving to the renamed
  // step, not silently restarting the tour.
  test("resolves the persisted pre-rename 'sessions' id to the activity step", () => {
    const activityIndex = FIRST_RUN_TOUR_STEPS.findIndex(
      (step) => step.id === 'activity',
    );
    expect(activityIndex).toBeGreaterThanOrEqual(0);
    expect(tourStepIndexForId('sessions')).toBe(activityIndex);
  });
});
