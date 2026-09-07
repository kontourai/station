import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Epic archive#4142: a route is a PLACEMENT of a pane, not a second
 * identity. `?surface=activity` renders the sessions surface through the pane path —
 * `ActivityWorkspacePane` with the canonical occurrence — and the ambient
 * dock and the Developer archive embed render the SAME pane. That leaves
 * `SessionsView` with exactly one mounter reachable from the shell. A second
 * mounter is how the pre-pane split re-forms: a host that renders the
 * surface directly bypasses the occurrence, the canonical-instance check,
 * and the dock action, and the copies then drift
 * (`docs/design/pane-or-shell.md`).
 *
 * A source sweep rather than a render assertion on purpose (same reasoning
 * as `home-surface-single-mounter.test.ts`): the mounters this guards
 * against are lazy route chunks whose render tests mock the surface away.
 * Anchored on IMPORTS and JSX MOUNT SITES, not tag spelling — a mounter
 * cannot use the component without importing its binding, and re-exports of
 * the module are counted as mounters deliberately (a re-export is a second
 * doorway).
 */

const SRC = join(import.meta.dirname, '..');

/** The one legitimate mounter: the built-in Activity Workspace Pane renderer. */
const SESSIONS_SURFACE_MOUNTER = 'views/activity/ActivityWorkspacePane.tsx';

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
 * A VALUE import of the `SessionsView` binding from the SessionsView module.
 * `import type {... }` and `type X` specifiers are erased at build time and
 * cannot mount anything, so they are not counted; a mixed import that
 * carries the value binding (`{ SessionsView, type X }`) is. The path
 * pattern's trailing anchor keeps `./SessionsView.css` from matching.
 */
function importsSessionsViewValue(source: string): boolean {
  // The clause of an import statement can never contain a quote, which is
  // what stops this pattern spanning from one import statement into a later
  // one that happens to end in /SessionsView.
  const importPattern =
    /import\s+([^'"]*?)from\s+['"][^'"]*\/SessionsView(?:\.js)?['"]/g;
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
          /^SessionsView(\s+as\s+\w+)?$/.test(specifier),
      )
    ) {
      return true;
    }
  }
  // A re-export is a second doorway to the same component.
  return /export\s+(?:{[^}]*\bSessionsView\b[^}]*}|\*)\s+from\s+['"][^'"]*\/SessionsView(?:\.js)?['"]/.test(
    source,
  );
}

describe('SessionsView has exactly one mounter reachable from the shell', () => {
  test('the only value importer and the only JSX mount site is ActivityWorkspacePane', () => {
    const importers: string[] = [];
    const mountSites: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const path = relative(SRC, file);
      // The module's own definition is not a mounter of itself.
      if (path === 'views/SessionsView.tsx') continue;
      const source = readFileSync(file, 'utf8');
      if (importsSessionsViewValue(source)) importers.push(path);
      if (/<SessionsView[\s/>]/.test(source)) mountSites.push(path);
    }
    expect(
      importers.sort(),
      'a second file imports the SessionsView value binding — the route/pane duplication is re-forming; mount ActivityWorkspacePane with the canonical occurrence instead',
    ).toEqual([SESSIONS_SURFACE_MOUNTER]);
    expect(
      mountSites.sort(),
      'a second JSX mount site for SessionsView exists — ActivityWorkspacePane must remain its only mounter',
    ).toEqual([SESSIONS_SURFACE_MOUNTER]);
  });
});
