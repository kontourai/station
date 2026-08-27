import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * station#3227 A1 — the structural half of the fix.
 *
 * `session-state-word-consistency.test.ts` proves the shared fold and its
 * refinement table cannot produce a contradiction. It cannot prove that a
 * FUTURE render site goes through them: a fifth surface reaching for
 * `sessionLifecycleLabel(session.lifecycleState)` reintroduces #1069 and
 * #1783 at a place no lane-walk test looks. Four surfaces did exactly that
 * (`SessionsView`, `ProjectLiveWorkSection`, `SessionDetailHeader`,
 * `DelegatedTaskCoordinator`), and the last of them was written the day the
 * audit was filed, by copying one of the others.
 *
 * So the rule is enforced at the import: `sessionLifecycleLabel` is the raw
 * lifecycle VOCABULARY and belongs only to `utils/session-state.ts`, which
 * folds it into `sessionStatusWord`. Rendering code calls `sessionStatusWord`.
 *
 * Deliberately a source scan and not a lint rule: it needs no new tooling,
 * and the failure message can say what to call instead.
 */

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The module that owns the fold, and is therefore allowed to consult it. */
const OWNER = join('utils', 'session-state.ts');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      sourceFiles(full, found);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    // Tests may name the helper: `sessionDisplay.test.ts` pins its exhaustive
    // switch, and this file names it in prose.
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    found.push(full);
  }
  return found;
}

/**
 * Comments are stripped and the whole remaining source is searched, rather
 * than matching an import line's shape. The first version of this scan tested
 * `/^\s*sessionLifecycleLabel,?\s*$/m` — a name on its own line, which is how
 * Biome formats a MULTI-specifier import. A single-specifier import fits on
 * one line, so the most likely shape a new offender would actually write
 * (`import { sessionLifecycleLabel } from '../utils/session-state';`) slipped
 * straight through. Found by injecting it.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('sessionLifecycleLabel has exactly one caller', () => {
  test('no module outside session-state.ts consults the raw lifecycle word', () => {
    const offenders = sourceFiles(SRC_ROOT)
      .filter((file) => !file.endsWith(OWNER))
      // A comment mentioning the name is fine; referencing it is not.
      .filter((file) =>
        /\bsessionLifecycleLabel\b/.test(
          withoutComments(readFileSync(file, 'utf8')),
        ),
      )
      .map((file) => file.slice(SRC_ROOT.length));

    expect(
      offenders,
      `${offenders.join(', ')} imports sessionLifecycleLabel. That is the RAW ` +
        "wire state in words, with none of the fold's overrides — a row built " +
        'from it says "Running" under "Recently finished" (station#3227 A1). ' +
        'Call sessionStatusWord(session) instead.',
    ).toEqual([]);
  });

  test('the scan actually reaches the rendering surfaces it is guarding', () => {
    // The "unreachable fixture" failure mode: a walk that finds no files
    // passes for the wrong reason. These four are the sites A1 named.
    const scanned = sourceFiles(SRC_ROOT).map((file) =>
      file.slice(SRC_ROOT.length),
    );
    for (const guarded of [
      join('views', 'SessionsView.tsx'),
      join('views', 'project-page', 'ProjectLiveWorkSection.tsx'),
      join('components', 'session-detail', 'SessionDetailHeader.tsx'),
      join('components', 'session-detail', 'DelegatedTaskCoordinator.tsx'),
    ]) {
      expect(scanned).toContain(guarded);
    }
    expect(scanned.length).toBeGreaterThan(300);
  });

  test('every guarded site does call the shared fold', () => {
    for (const guarded of [
      join('views', 'SessionsView.tsx'),
      join('views', 'project-page', 'ProjectLiveWorkSection.tsx'),
      join('components', 'session-detail', 'SessionDetailHeader.tsx'),
      join('components', 'session-detail', 'DelegatedTaskCoordinator.tsx'),
    ]) {
      const source = readFileSync(join(SRC_ROOT, guarded), 'utf8');
      expect(
        source,
        `${guarded} no longer renders a session state word`,
      ).toMatch(/sessionStatusWord\(/);
    }
  });
});
