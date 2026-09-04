import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * SHELL-14: the shell gained a `main` landmark (`App.tsx`'s `#station-main`)
 * because a landmark scan of the running app returned only the sidebar's
 * `nav` and the toolbar's `header` — there was no way for a screen reader to
 * jump to the route, and no target for a skip control.
 *
 * That makes a second `main` INSIDE the shell a regression rather than an
 * improvement: two `main` elements on one page is an ambiguous landmark list,
 * and adding the outer one turned two pre-existing route-level `main`s
 * (HomeView, FlowRunConsole) into exactly that. Both are `section` now.
 *
 * This is a source sweep rather than a render assertion on purpose: the views
 * that would reintroduce it are lazy route chunks with heavy dependency
 * graphs, and every existing render test for them mocks the view away — the
 * element under test would be the mock's.
 */

const SRC = join(import.meta.dirname, '..');

/**
 * Files that render a `main` OUTSIDE the shell, and are therefore the page's
 * one landmark rather than a second one. Each replaces the whole shell.
 */
const PRE_SHELL_MAIN_OWNERS = new Set([
  // The whole-window access gate, rendered instead of `<App>`.
  'components/LocalUiSessionGate.tsx',
  // Rendered by that gate, in place of the shell.
  'components/first-run/UnpairedSampleWorkspace.tsx',
  // Standalone public share routes; they mount their own document shell.
  'views/share/SharedAnswerView.tsx',
  'views/share/SharedAnswerBoundary.tsx',
  // The shell's own landmark.
  'App.tsx',
  // Unreferenced by any route or component (kept out of the sweep's scope
  // rather than silently blessed: if it is ever mounted, this entry is the
  // thing to re-check).
  'components/TasksLayout.tsx',
]);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (entry.endsWith('.tsx')) yield full;
  }
}

/**
 * A `main` element and `role="main"` are the same landmark to a screen
 * reader, so a guard that only sees the tag catches half the ways back in.
 * Neither pattern sees indirect construction (`createElement(tag)`, a `Tag`
 * variable); that is a disclosed limit of a source sweep, not a claim.
 */
const MAIN_LANDMARK = /<main[\s>/]|role=["'{]?["']?main["']/;

function hasMainLandmark(source: string): boolean {
  // This test deliberately sweeps source rather than mounting every lazy
  // route, but commentary about the shell's landmark is not rendered markup.
  const executableSource = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  return MAIN_LANDMARK.test(executableSource);
}

describe('single main landmark', () => {
  test('nothing rendered inside the shell declares its own main landmark', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const relative = file.slice(SRC.length + 1);
      if (PRE_SHELL_MAIN_OWNERS.has(relative)) continue;
      if (hasMainLandmark(readFileSync(file, 'utf8'))) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  test('the guard sees role="main", not only the element', () => {
    // Fault-injection in permanent form: the pattern itself is asserted
    // against both spellings, so a future "simplification" of the regex that
    // drops the role branch fails here rather than silently going blind.
    expect(MAIN_LANDMARK.test('<main className="x">')).toBe(true);
    expect(MAIN_LANDMARK.test('<main>')).toBe(true);
    expect(MAIN_LANDMARK.test('<div role="main">')).toBe(true);
    expect(MAIN_LANDMARK.test("<div role='main'>")).toBe(true);
    expect(MAIN_LANDMARK.test('<div role={"main"}>')).toBe(true);
    expect(MAIN_LANDMARK.test('<mainNav>')).toBe(false);
    expect(MAIN_LANDMARK.test('role="maintenance"')).toBe(false);
    expect(hasMainLandmark('// <main>\nconst shell = true;')).toBe(false);
    expect(hasMainLandmark('/* role="main" */\n<div role="dialog" />')).toBe(
      false,
    );
    expect(hasMainLandmark('// a comment\n<main />')).toBe(true);
  });

  test('the exception list still describes files that exist', () => {
    for (const relative of PRE_SHELL_MAIN_OWNERS) {
      expect(() => statSync(join(SRC, relative))).not.toThrow();
    }
  });
});
