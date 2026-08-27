import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'glob';
import { describe, expect, it } from 'vitest';

/**
 * station#3306: page-layout.css reaches the bundle only through side-effect
 * imports, so a module that applies the `page` shell classes without importing
 * the stylesheet itself renders styled or unstyled depending on which module
 * happened to load first (FeaturePreviewsView and DeveloperView both shipped
 * that way — a cold direct navigation rendered them unstyled).
 *
 * The rule this pins: any module whose JSX applies a page ROOT class
 * (`page`, `page--narrow`, `page--full` as a space-delimited className token)
 * must import `page-layout.css` in that same module, so its styles can never
 * be load-order-dependent. Nested `page__*`/`page-section*` usage inside a
 * child component is deliberately out of scope — the root-classed owner is
 * the module that owns the import.
 *
 * The scan covers `views/`, `pages/` and `components/`, not just `views/`:
 * the defect class lives wherever the root classes are applied, and
 * `components/registry/RegistryCatalog.tsx` was a live instance one directory
 * outside the original glob.
 */

const UI_SRC = join(__dirname, '..');

const CLASSNAME_ATTR = /className\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\})/g;
const PAGE_ROOT_TOKENS = new Set(['page', 'page--narrow', 'page--full']);

function appliesPageRootClass(source: string): boolean {
  for (const match of source.matchAll(CLASSNAME_ATTR)) {
    const value = match[1] ?? match[2] ?? '';
    const tokens = value.split(/\s+|\$\{[^}]*\}/);
    if (tokens.some((token) => PAGE_ROOT_TOKENS.has(token))) return true;
  }
  return false;
}

/**
 * Scanned roots, with the exact number of files each currently classifies as
 * page-rooted. The counts are the point: a corpus assertion alone passes
 * happily when `appliesPageRootClass` stops classifying ANYTHING, which is
 * the state in which the import rule below can no longer fail. Update a
 * number here in the same change that adds or removes a page-rooted module.
 */
const SCAN_ROOTS = [
  // Down from 18/2/1 in the station UX audit's C1 lane: the page root moved
  // out of the views into `components/page-frame`, which is loaded by the
  // shell and imports its own stylesheet, so almost nothing applies a page
  // ROOT class any more. Two are the surfaces that keep their own
  // full-viewport shell (a task workspace, the project editor); the third is
  // the connections hub's Computers section (#3733), which arrived
  // page-rooted without updating this count — the import RULE this guard
  // exists for is satisfied there (it imports `page-layout.css` itself), so
  // this is the bookkeeping that change skipped, not a relaxed rule. Whether
  // a hub SECTION should own a page root at all is a question for that lane.
  { dir: 'views', pageRootedCount: 3 },
  { dir: 'pages', pageRootedCount: 0 },
  { dir: 'components', pageRootedCount: 0 },
] as const;

/** Known page-rooted modules — every one that is left. */
const PAGE_ROOTED_FIXTURES = [
  'views/TaskWorkspaceView.tsx',
  'views/ProjectSettingsView.tsx',
  'views/connections-hub/ComputersSection.tsx',
];

/**
 * Known NOT page-rooted. Without this the guard also passes when the
 * classifier returns true for everything — which reads as "all covered" while
 * the tokens it is supposed to recognize have stopped mattering.
 */
const NOT_PAGE_ROOTED_FIXTURES = [
  'components/PageRow.tsx',
  'views/settings/FeaturePreviewsSection.tsx',
  // All three applied a page root class before the frame took the page root
  // over. Keeping them here is what proves the classifier reads the CURRENT
  // markup rather than a remembered answer.
  'views/SettingsView.tsx',
  'pages/ProfilePage.tsx',
  'components/registry/RegistryCatalog.tsx',
];

function scan(dir: string): string[] {
  return glob.sync('**/*.tsx', {
    cwd: join(UI_SRC, dir),
    nodir: true,
    ignore: ['**/__tests__/**'],
  });
}

function read(relativePath: string): string {
  return readFileSync(join(UI_SRC, relativePath), 'utf8');
}

describe('page-layout.css import guard (station#3306)', () => {
  const scanned = SCAN_ROOTS.map((root) => ({
    ...root,
    files: scan(root.dir).map((file) => `${root.dir}/${file}`),
  }));
  const allFiles = scanned.flatMap((root) => root.files);

  it('scans a real corpus (scope honesty)', () => {
    // If a glob root ever drifts, every assertion below would pass over an
    // empty list.
    for (const fixture of [
      ...PAGE_ROOTED_FIXTURES,
      ...NOT_PAGE_ROOTED_FIXTURES,
    ]) {
      expect(allFiles, `${fixture} must be inside a scanned root`).toContain(
        fixture,
      );
    }
    expect(allFiles.length).toBeGreaterThan(300);
  });

  it('classifies the page-rooted modules, and only those', () => {
    // The import rule below is vacuous unless this classification works, and
    // a broken classifier is silent: it just stops finding anything to check.
    for (const fixture of PAGE_ROOTED_FIXTURES) {
      expect(
        appliesPageRootClass(read(fixture)),
        `${fixture} applies a page root class and must classify as page-rooted`,
      ).toBe(true);
    }
    for (const fixture of NOT_PAGE_ROOTED_FIXTURES) {
      expect(
        appliesPageRootClass(read(fixture)),
        `${fixture} applies no page root class and must not classify as page-rooted`,
      ).toBe(false);
    }
  });

  it('classifies the expected number of modules in each scanned root', () => {
    for (const root of scanned) {
      const pageRooted = root.files.filter((file) =>
        appliesPageRootClass(read(file)),
      );
      expect(
        pageRooted.length,
        `src-ui/src/${root.dir} now has ${pageRooted.length} page-rooted module(s), not ` +
          `${root.pageRootedCount}. If that is intended, update SCAN_ROOTS in this file ` +
          `(page-rooted: ${pageRooted.join(', ')}).`,
      ).toBe(root.pageRootedCount);
    }
  });

  it('every module applying a page root class imports page-layout.css itself', () => {
    const missing: string[] = [];
    for (const file of allFiles) {
      const source = read(file);
      if (!appliesPageRootClass(source)) continue;
      if (!source.includes('page-layout.css')) missing.push(file);
    }
    expect(
      missing,
      `page-rooted module(s) missing a side-effect import of page-layout.css ` +
        `(add the side-effect import — see station#3306): ` +
        missing.join(', '),
    ).toEqual([]);
  });
});

/**
 * station#4463 slice 2 review LOW: `components/Tabs.tsx` and
 * `components/SectionNav.tsx` now self-import `page-layout.css` (so every
 * ADOPTER is covered automatically, the structural fix for station#3306's
 * failure mode), but a module rendering the raw `page__tab`/`section-nav`
 * class TOKENS directly — bypassing the shared components — could still
 * regress into exactly the load-order bug those components exist to
 * prevent. This is the narrower, cheaper guard the "restore five per-host
 * imports" alternative would have re-introduced: any `.tsx` file whose
 * source contains one of these class tokens must be able to reach
 * `page-layout.css`, either directly or by importing `Tabs`/`SectionNav`.
 */
describe('tab/section-nav class-token import guard (station#4463 slice 2)', () => {
  const TAB_TOKENS = ['page__tabs', 'page__tab', 'section-nav'];
  const OWNING_COMPONENTS = [
    'components/Tabs.tsx',
    'components/SectionNav.tsx',
  ];

  function usesTabToken(source: string): boolean {
    return TAB_TOKENS.some((token) => source.includes(token));
  }

  function reachesPageLayoutCss(file: string, source: string): boolean {
    if (OWNING_COMPONENTS.includes(file)) {
      return source.includes('page-layout.css');
    }
    if (source.includes('page-layout.css')) return true;
    return (
      /from ['"][^'"]*\/Tabs['"]/.test(source) ||
      /from ['"][^'"]*\/SectionNav['"]/.test(source)
    );
  }

  it('scans a real corpus and finds the two owning components (scope honesty)', () => {
    const scanned = SCAN_ROOTS.map((root) => ({
      dir: root.dir,
      files: scan(root.dir).map((file) => `${root.dir}/${file}`),
    }));
    const allTsxFiles = scanned.flatMap((root) => root.files);
    for (const owner of OWNING_COMPONENTS) {
      expect(allTsxFiles, `${owner} must be inside a scanned root`).toContain(
        owner,
      );
    }
  });

  it('every module rendering a tab/section-nav class token can reach page-layout.css', () => {
    const scanned = SCAN_ROOTS.map((root) => ({
      dir: root.dir,
      files: scan(root.dir).map((file) => `${root.dir}/${file}`),
    }));
    const allTsxFiles = scanned.flatMap((root) => root.files);
    const missing: string[] = [];
    let classified = 0;
    for (const file of allTsxFiles) {
      const source = read(file);
      if (!usesTabToken(source)) continue;
      classified += 1;
      if (!reachesPageLayoutCss(file, source)) missing.push(file);
    }
    // Scope honesty for the classifier itself: the corpus assertion alone
    // passes happily when usesTabToken stops classifying ANYTHING (the same
    // vacuity the pageRootedCount guard above exists to prevent). Five files
    // carry the literal class tokens today (the two owning components plus
    // the hosts that render raw token strings — most hosts reach the CSS by
    // importing Tabs/SectionNav instead). The floor reds if a rename strips
    // the tokens from source and CSS together without updating this guard's
    // vocabulary.
    expect(classified).toBeGreaterThanOrEqual(5);
    expect(
      missing,
      `module(s) rendering a page__tab(s)/section-nav class token that cannot ` +
        `reach page-layout.css (import it directly, or import Tabs/SectionNav ` +
        `which self-import it — see station#3306 and station#4463 slice 2): ` +
        missing.join(', '),
    ).toEqual([]);
  });
});
