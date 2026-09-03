import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { VISUAL_VIEWPORT_BOTTOM_INSET_VAR } from '../hooks/useMobileVisualViewport';

/**
 * archive#3902 — the chat dock is rendered by the shell (`App.tsx`), so how
 * much of the bottom of the viewport it owns is a SHELL fact, and every route
 * has to be able to clear it without knowing anything about the dock.
 *
 * The defect this pins: `.content-view` reserved `var(--dock-slot-size)`,
 * which is not the dock's footprint. The collapsed bar's element is
 * `calc(--chat-dock-header-height + --safe-bottom)` tall (`ChatDock.tsx`) and
 * the mobile dock anchors to the VISIBLE viewport, so on a 390x844 phone with
 * a home indicator the rendered dock started 34px above where the shell had
 * stopped reserving — and `--layer-dock` (9200) took every tap in that band.
 * Measured live on `/connections/models/new`: the last provider tile's centre
 * hit-tested to `hr.chat-dock__resize-handle`.
 */

const uiSrc = join(__dirname, '..');
const indexCss = readFileSync(join(uiSrc, 'index.css'), 'utf8');

/** Comments out, so a rule quoted in prose is not read as a declaration. */
function withoutComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

/** The FIRST declaration of a custom property, with its full `calc(...)`. */
function declaration(css: string, name: string): string {
  const source = withoutComments(css);
  const index = source.indexOf(`${name}:`);
  expect(index, `${name} not found`).toBeGreaterThan(-1);
  return source.slice(index, source.indexOf(';', index));
}

function ruleBodies(css: string, selector: string): string[] {
  const source = withoutComments(css);
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const index = source.indexOf(`${selector} {`, from);
    if (index === -1) return bodies;
    const end = source.indexOf('}', index);
    bodies.push(source.slice(index, end));
    from = end;
  }
}

function stylesheets(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '__tests__') return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return path.endsWith('.css') ? [path] : [];
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '__tests__') return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(path) ? [path] : [];
  });
}

describe('the dock clearance is one derivation (station#3902)', () => {
  test('it sums the published height, the safe area and the visible-viewport inset', () => {
    const value = declaration(indexCss, '--dock-bottom-clearance');
    expect(value).toContain('--dock-slot-size');
    expect(value).toContain('--safe-bottom');
    expect(value).toContain(VISUAL_VIEWPORT_BOTTOM_INSET_VAR);
  });

  test("the shell's route outlet reserves it, so every route clears the dock", () => {
    // The BASE rule. The compound `.app__main--dock-left/right/bottom > …`
    // rules deliberately zero it: in those modes the dock is a real grid row
    // beside the content rather than fixed over it.
    const bodies = ruleBodies(indexCss, '\n.content-view');
    expect(bodies.length, '.content-view base rule not found').toBe(1);
    expect(bodies[0]).toContain('padding-bottom: var(--dock-bottom-clearance)');
  });

  /**
   * The one-derivation guard, and the reason this file scans the tree rather
   * than naming the files it happened to find: a page that reserves its own
   * bottom space from `--dock-slot-size` is re-deriving the shell's fact
   * from a strictly smaller number, which is how five stylesheets ended up
   * with five different answers. Anchoring a FIXED element above the dock
   * (`bottom:`) is a different job and is deliberately not covered.
   */
  test('no stylesheet reserves body space from --dock-slot-size directly', () => {
    const offenders: string[] = [];
    for (const path of stylesheets(uiSrc)) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      for (const match of source.matchAll(
        /(padding-bottom|margin-bottom)\s*:[^;]*/g,
      )) {
        if (match[0].includes('--dock-slot-size')) {
          offenders.push(`${path.slice(uiSrc.length + 1)}: ${match[0].trim()}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  test('one shell class places every dock occupant — no second per-occupant wrapper', () => {
    const source = withoutComments(indexCss);
    // archive#4460: every occupant (Chat, Home, Activity) now renders
    // through the shared `DockShell`, whose root carries `.chat-dock`
    // regardless of which occupant is docked — there is exactly one wrapper
    // class, not the old `:is(.chat-dock, .dock-slot)` fork where a non-chat
    // occupant's OWN `.dock-slot` element carried a second copy of the same
    // placement geometry. `.dock-slot` no longer exists in any rendered
    // markup; this guards against it (or an equivalent second wrapper)
    // coming back with its own drifted position/grid-column/grid-row — the
    // exact class of bug #3902 fixed.
    expect(source).toContain('.chat-dock {');
    expect(source).not.toMatch(/\.dock-slot\s*\{/);
  });

  test('the ambient host is the sole --dock-slot-size writer', () => {
    const writers = sourceFiles(uiSrc).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [
        ...source.matchAll(/\.style\.setProperty\(\s*['"]--dock-slot-size/g),
      ].map(() => path.slice(uiSrc.length + 1));
    });

    // archive#3929: Chat supplies live geometry to the ambient slot, but the
    // host alone publishes the shell's clearance. A second writer races the
    // mount order and loses mobile safe-area and drag-frame correctness.
    expect(
      writers,
      `second dock-slot publisher(s): ${writers.join(', ')}`,
    ).toEqual(['regions/region-clearance.ts']);
  });
});
