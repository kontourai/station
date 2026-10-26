// Which source modules each gallery screen (`SCREENS` in
// tests/screenshots.spec.ts) loads, as ENTRY modules only: the route view or
// lazily loaded surface the screen exists to photograph. Coverage is the
// import closure of these entries, computed by scripts/lib/ui-module-graph.mjs
// (static and lazy imports), plus the shell every screen loads. Nothing here
// lists the files a change might touch, so the map cannot go stale as views
// grow; it goes stale only when a screen points at the wrong surface.
//
// The map itself is data, tests/gallery-screen-sources.json, so the PR
// workflow's allowlist ceiling can read a candidate's screen names without
// executing candidate code. `shell` lists the modules every screen loads: the
// HTML entry, `main.tsx` (boot's unconditional `import('./main')`), and the
// lazy chrome App mounts on every route; their STATIC closure is "every
// screen". `screens` maps each screen name to its entry modules.
//
// Pinned two ways: screenshots.spec.ts refuses to start when SCREENS and this
// map disagree on names, and scripts/__tests__/gallery-screen-coverage.test.ts
// requires every entry to exist and to be reachable from the app's HTML entry.

import { readFileSync } from 'node:fs';

const map = JSON.parse(
  readFileSync(
    new URL('./gallery-screen-sources.json', import.meta.url),
    'utf8',
  ),
);

export const GALLERY_SHELL_ENTRIES = Object.freeze([...map.shell]);

/** Screen name -> entry modules (repo-relative). */
export const GALLERY_SCREEN_ENTRIES = Object.freeze(
  Object.fromEntries(
    Object.entries(map.screens).map(([name, entries]) => [
      name,
      Object.freeze([...entries]),
    ]),
  ),
);

/**
 * Refuses a SCREENS list that this map does not describe exactly: a missing
 * screen would be invisible to gate:for routing, an extra one would route
 * changes to a screen that no longer exists.
 * @param {readonly string[]} screenNames
 */
export function assertGalleryScreenSourcesCover(screenNames) {
  const declared = new Set(Object.keys(GALLERY_SCREEN_ENTRIES));
  const missing = screenNames.filter((name) => !declared.has(name));
  const names = new Set(screenNames);
  const extra = [...declared].filter((name) => !names.has(name));
  if (missing.length > 0 || extra.length > 0)
    throw new Error(
      'tests/gallery-screen-sources.json must name every gallery screen exactly. ' +
        `Missing: ${missing.join(', ') || 'none'}. Unknown: ${extra.join(', ') || 'none'}.`,
    );
}
