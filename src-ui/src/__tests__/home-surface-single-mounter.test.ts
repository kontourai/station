import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Epic station#4142 (M2): a route is a PLACEMENT of a pane, not a second
 * identity. `/` renders Home through the pane path — `HomeWorkspacePane`
 * with the canonical occurrence — and the ambient dock renders the SAME
 * pane. That leaves `HomeSurface` with exactly one mounter reachable from
 * the shell. A second mounter is how the pre-M2 split re-forms: a route
 * body that renders the surface directly bypasses the occurrence, the
 * canonical-instance check, and the dock action, and the two copies then
 * drift (`docs/design/pane-or-shell.md`).
 *
 * A source sweep rather than a render assertion on purpose (same reasoning
 * as `single-main-landmark.test.ts`): the mounters this guards against are
 * lazy route chunks whose render tests mock the surface away. Anchored on
 * IMPORTS and JSX MOUNT SITES, not tag spelling — a mounter cannot use the
 * component without importing its binding, and re-exports of the module are
 * counted as mounters deliberately (a re-export is a second doorway).
 */

const SRC = join(import.meta.dirname, '..');

/** The one legitimate mounter: the built-in Home Workspace Pane renderer. */
const HOME_SURFACE_MOUNTER = 'views/home/HomeWorkspacePane.tsx';

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (entry.endsWith('.tsx') || entry.endsWith('.ts')) yield full;
  }
}

/**
 * A VALUE import of the `HomeSurface` binding from the HomeSurface module.
 * `import type { ... }` and `type HomeViewModel` specifiers are erased at
 * build time and cannot mount anything, so they are not counted; a mixed
 * import that carries the value binding (`{ HomeSurface, type X }`) is.
 */
function importsHomeSurfaceValue(source: string): boolean {
  // The clause of an import statement can never contain a quote, which is
  // what stops this pattern spanning from one import statement into a later
  // one that happens to end in /HomeSurface.
  const importPattern =
    /import\s+([^'"]*?)from\s+['"][^'"]*\/HomeSurface(?:\.js)?['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const clause = match[1];
    if (clause.trimStart().startsWith('type ')) continue;
    const named = clause.match(/{([\s\S]*?)}/);
    if (!named) continue;
    const specifiers = named[1]
      .split(',')
      .map((specifier) => specifier.trim())
      .filter(Boolean);
    if (
      specifiers.some(
        (specifier) =>
          !specifier.startsWith('type ') &&
          /^HomeSurface(\s+as\s+\w+)?$/.test(specifier),
      )
    ) {
      return true;
    }
  }
  // A re-export is a second doorway to the same component.
  return /export\s+(?:{[^}]*\bHomeSurface\b[^}]*}|\*)\s+from\s+['"][^'"]*\/HomeSurface(?:\.js)?['"]/.test(
    source,
  );
}

describe('HomeSurface has exactly one mounter reachable from the shell', () => {
  test('the only value importer and the only JSX mount site is HomeWorkspacePane', () => {
    const importers: string[] = [];
    const mountSites: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const path = relative(SRC, file);
      // The module's own definition is not a mounter of itself.
      if (path === 'views/home/HomeSurface.tsx') continue;
      const source = readFileSync(file, 'utf8');
      if (importsHomeSurfaceValue(source)) importers.push(path);
      if (/<HomeSurface[\s/>]/.test(source)) mountSites.push(path);
    }
    expect(
      importers.sort(),
      'a second file imports the HomeSurface value binding — the route/pane duplication is re-forming; mount HomeWorkspacePane with the canonical occurrence instead',
    ).toEqual([HOME_SURFACE_MOUNTER]);
    expect(
      mountSites.sort(),
      'a second JSX mount site for HomeSurface exists — HomeWorkspacePane must remain its only mounter',
    ).toEqual([HOME_SURFACE_MOUNTER]);
  });
});
