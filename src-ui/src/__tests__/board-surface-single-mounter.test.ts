import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Epic archive#4142: the Board surface lives in
 * `@kontourai/station-board-pane` and core imports it in exactly one place —
 * the pane renderer that supplies its shell bindings. A second importer is
 * how the extraction erodes: a host that mounts `ConsoleBoardPane` directly
 * bypasses the canonical-occurrence check, the identity resolution, and the
 * one supplier of the `ConsoleBoardPaneHost` bindings, and the copies then
 * drift (`docs/design/pane-or-shell.md`).
 *
 * A source sweep rather than a render assertion on purpose (same reasoning
 * as `home-surface-single-mounter.test.ts` and
 * `activity-surface-single-mounter.test.ts`): the mounters this guards
 * against are lazy route chunks whose render tests mock the surface away.
 * Anchored on IMPORTS and JSX MOUNT SITES, not tag spelling — a mounter
 * cannot use the component without importing its binding, and re-exports of
 * the module are counted as mounters deliberately (a re-export is a second
 * doorway).
 *
 * The package's React-free descriptor subpath
 * (`@kontourai/station-board-pane/workspace-board-pane`) is a contract
 * module, not a surface — but its importer set is pinned EXACTLY too, so a
 * new consumer of the Board's identity is a reviewed edit here rather than
 * a silent spread.
 */

const SRC = join(import.meta.dirname, '..');

/** The one legitimate mounter: the built-in Board Workspace Pane renderer. */
const BOARD_SURFACE_MOUNTER = 'views/board/BoardWorkspacePane.tsx';

/** The reviewed consumers of the descriptor/instance contract subpath. */
const BOARD_CONTRACT_IMPORTERS = [
  'views/ConsoleBoardView.tsx',
  'views/board/BoardWorkspacePane.tsx',
  'workspace-panes/builtinWorkspacePaneCanonical.ts',
  'workspace-panes/builtinWorkspacePaneRegistry.tsx',
];

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
 * A VALUE import from the package ROOT (the component module). `import type`
 * clauses are erased at build time and cannot mount anything, so they are
 * not counted; a mixed import that carries a value binding is.
 */
function importsBoardPaneRootValue(source: string): boolean {
  const importPattern =
    /import\s+([^'"]*?)from\s+['"]@kontourai\/station-board-pane['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const clause = match[1];
    if (clause.trimStart().startsWith('type ')) continue;
    const named = clause.match(/{([\s\S]*?)}/);
    const specifiers = named
      ? named[1]
          .split(',')
          .map((specifier) => specifier.trim())
          .filter(Boolean)
      : [clause.trim()].filter(Boolean);
    if (specifiers.some((specifier) => !specifier.startsWith('type '))) {
      return true;
    }
  }
  // A re-export is a second doorway to the same component.
  return /export\s+(?:{[^}]*}|\*)\s+from\s+['"]@kontourai\/station-board-pane['"]/.test(
    source,
  );
}

function importsBoardPaneContract(source: string): boolean {
  return /from\s+['"]@kontourai\/station-board-pane\/workspace-board-pane['"]/.test(
    source,
  );
}

describe('the Board surface has exactly one mounter reachable from the shell', () => {
  test('the only value importer of the package root and the only JSX mount site is BoardWorkspacePane', () => {
    const importers: string[] = [];
    const mountSites: string[] = [];
    const contractImporters: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const path = relative(SRC, file);
      const source = readFileSync(file, 'utf8');
      if (importsBoardPaneRootValue(source)) importers.push(path);
      if (/<ConsoleBoardPane[\s/>]/.test(source)) mountSites.push(path);
      if (importsBoardPaneContract(source)) contractImporters.push(path);
    }
    expect(
      importers.sort(),
      'a second file imports the @kontourai/station-board-pane component — the route/pane duplication is re-forming; mount BoardWorkspacePane with the canonical occurrence instead',
    ).toEqual([BOARD_SURFACE_MOUNTER]);
    expect(
      mountSites.sort(),
      'a second JSX mount site for ConsoleBoardPane exists — BoardWorkspacePane must remain its only mounter',
    ).toEqual([BOARD_SURFACE_MOUNTER]);
    expect(
      contractImporters.sort(),
      'a new consumer of the Board descriptor subpath appeared — add it here deliberately or route it through the existing placement host',
    ).toEqual([...BOARD_CONTRACT_IMPORTERS].sort());
  });
});
