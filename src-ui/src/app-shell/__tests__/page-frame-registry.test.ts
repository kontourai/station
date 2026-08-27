import { describe, expect, it } from 'vitest';
import type { NavigationView } from '../../types';
import { resolvePageFrame } from '../page-frame-registry';
import { APP_SURFACE_REGISTRY } from '../surface-registry';

/**
 * Every route in the app, once. `resolvePageFrame` is typed as a `Record` over
 * `NavigationView['type']`, so a route added to the union without a decision
 * is a compile error; this list is the runtime half — it makes the DECISION
 * visible, so changing one shows up as a test change rather than a silent
 * difference in what a page looks like.
 */
const ROUTES: NavigationView[] = [
  { type: 'home' },
  { type: 'agents' },
  { type: 'agent-new' },
  { type: 'agent-edit', slug: 'a' },
  { type: 'guidance' },
  { type: 'connections' },
  { type: 'connections-providers' },
  { type: 'connections-provider-edit', id: 'p' },
  { type: 'connections-engines' },
  { type: 'connections-runtime-edit', id: 'r' },
  { type: 'connections-acp' },
  { type: 'connections-acp-new', providerId: 'p' },
  { type: 'connections-tools' },
  { type: 'connections-tool-edit', id: 't' },
  { type: 'connections-knowledge' },
  { type: 'plugins' },
  { type: 'registry' },
  { type: 'review-queue' },
  { type: 'activity' },
  { type: 'developer' },
  { type: 'schedule' },
  { type: 'settings' },
  { type: 'profile' },
  { type: 'notifications' },
  { type: 'task', taskId: 't' },
  { type: 'project', slug: 's' },
  { type: 'project-session-board', slug: 's' },
  { type: 'project-flow-console', slug: 's' },
  {
    type: 'workspace-pane',
    projectSlug: 's',
    descriptorId: 'd',
    instanceId: 'i',
  },
  { type: 'project-new' },
  { type: 'project-edit', slug: 's' },
  { type: 'layout', projectSlug: 's', layoutSlug: 'l' },
  { type: 'not-found', path: '/x' },
];

/**
 * The surfaces that deliberately render without a page header, and why. A
 * route reaching this list is a design decision; the ratchet in
 * `scripts/shell-conformance-ratchet.mjs` holds the other half (a view may
 * not write a header of its own instead).
 */
const UNFRAMED = new Set([
  'home', // hero prompt, not a page name
  'task', // task workspace owns its viewport
  'project', // project identity header is the content
  'layout', // a layout renders edge to edge
  'workspace-pane', // a pane renderer is handed the whole area
  'project-new', // a route-level dialog
  'project-edit', // editor chrome: unsaved badge + Save/Back
  'not-found', // ErrorState is the whole page
]);

describe('page-frame registry', () => {
  it('decides for every route type exactly once', () => {
    const types = ROUTES.map((route) => route.type);
    expect(new Set(types).size).toBe(types.length);
    for (const route of ROUTES) {
      // `undefined` would mean an unlisted route silently rendering unframed.
      expect(resolvePageFrame(route)).not.toBeUndefined();
    }
  });

  it('frames every route except the recorded exceptions', () => {
    const unframed = ROUTES.filter(
      (route) => resolvePageFrame(route) === null,
    ).map((route) => route.type);
    expect(new Set(unframed)).toEqual(UNFRAMED);
  });

  it('resolves a title for every framed route, so no header can paint empty', () => {
    // The frame renders above Suspense, so the window between a route being
    // requested and its chunk arriving is a window in which nothing has
    // published a title. A route reaching that window without one renders an
    // `<h1>` with nothing in it. This is the derivation that closes it: no
    // route type is exempt, so a new route cannot be added with a header and
    // no name for it.
    for (const route of ROUTES) {
      const spec = resolvePageFrame(route);
      if (!spec) continue;
      expect(spec.title, `${route.type} needs a title`).toBeTruthy();
    }
  });

  it('takes each fallback title from the surface the sidebar highlights', () => {
    // One source for the word: the header a route paints while it loads is
    // the label of the surface row the user just clicked, not a second copy
    // maintained in the frame table. A route whose title the VIEW publishes
    // (a remembered tab, the active Developer tab) still overrides it once
    // the view mounts — this is only what shows before that.
    for (const route of ROUTES) {
      const spec = resolvePageFrame(route);
      const surface = APP_SURFACE_REGISTRY.getSurfaceForView(route);
      if (!spec || !surface) continue;
      // Routes that state their own title in the table keep it (Connections'
      // hub is 'Connections'; the ACP sub-routes are 'Provider setup').
      const stated = new Set([
        'connections',
        'connections-acp',
        'connections-acp-new',
        'connections-knowledge',
        'registry',
        'schedule',
        'settings',
        'profile',
        'notifications',
      ]);
      if (stated.has(route.type)) continue;
      expect(spec.title, `${route.type} fallback title`).toBe(surface.label());
    }
  });

  it('names the two framed routes the sidebar has no surface for', () => {
    // Reached from inside a project, not from a sidebar row, so there is no
    // surface label to derive from — and no view has run yet to publish one.
    expect(
      resolvePageFrame({ type: 'project-session-board', slug: 's' })?.title,
    ).toBe('Board');
    expect(
      resolvePageFrame({ type: 'project-flow-console', slug: 's' })?.title,
    ).toBe('Flow console');
  });

  it('gives every split-pane route the same frame shape', () => {
    for (const type of [
      'agents',
      'connections-providers',
      'connections-engines',
      'connections-tools',
      'plugins',
      'review-queue',
      'activity',
      'guidance',
    ] as const) {
      const spec = resolvePageFrame({ type } as NavigationView);
      expect({ type, ...spec }).toMatchObject({
        width: 'full',
        body: 'fill',
        flush: true,
      });
    }
  });

  it('uses the same origin for narrow routes as full ones', () => {
    // `narrow` may only change the measure. Anything else here (a margin, a
    // centring rule) is how Notifications ended up at x=665 with a 400px
    // gutter beside every other page's x=264.
    for (const route of ROUTES) {
      const spec = resolvePageFrame(route);
      if (!spec) continue;
      expect(['full', 'narrow', undefined]).toContain(spec.width);
    }
  });

  // station#4463 slice 1 (2026-08-26 shell audit): a top-level nav page gets
  // NO eyebrow. Every one of these routes IS the surface the sidebar links
  // to (not reached under a parent), so a static eyebrow here could only ever
  // restate the route's own title — the retired `GUIDANCE`-over-**Guidance**
  // pattern.
  it('gives every top-level nav route no static eyebrow', () => {
    for (const type of [
      'agents',
      'guidance',
      'connections',
      'registry',
      'plugins',
      'review-queue',
      'activity',
      'schedule',
      'settings',
      'profile',
      'notifications',
    ] as const) {
      const spec = resolvePageFrame({ type } as NavigationView);
      expect(
        spec?.eyebrow,
        `${type} must not have a static eyebrow`,
      ).toBeUndefined();
    }
  });

  // Developer's eyebrow is a real parent (the title is the active tab's
  // name, never 'Developer' itself), so it is kept — but a subpage's static
  // eyebrow must be the parent ONLY, never the retired
  // 'Connections / <section>' breadcrumb-as-eyebrow that restated the title.
  it('gives every subpage with a static eyebrow just its parent, not a breadcrumb trail', () => {
    expect(resolvePageFrame({ type: 'developer' })?.eyebrow).toBe('Developer');
    for (const route of [
      { type: 'connections-acp' },
      { type: 'connections-acp-new', providerId: 'p' },
      { type: 'connections-knowledge' },
    ] as const) {
      const spec = resolvePageFrame(route as NavigationView);
      expect(spec?.eyebrow, `${route.type} eyebrow`).toBe('Connections');
    }
  });
});
