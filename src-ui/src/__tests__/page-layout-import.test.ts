import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'glob';
import { describe, expect, it } from 'vitest';

/**
 * archive#3306: page-layout.css reaches the bundle only through side-effect
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
  // Down from 18/2/1 in the station 's lane: the page root moved
  // out of the views into `components/page-frame`, which is loaded by the
  // shell and imports its own stylesheet, so almost nothing applies a page
  // ROOT class any more. Two are the surfaces that keep their own
  // full-viewport shell (a task workspace, the project editor); the third is
  // the connections hub's Computers section (archive#3733), which arrived
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
 * archive#4463: `components/Tabs.tsx` and
 * `components/SectionNav.tsx` now self-import `page-layout.css` (so every
 * ADOPTER is covered automatically, the structural fix for archive#3306's
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

/**
 * #1636: the same rule, for the project-surface FRAME.
 *
 * `views/project-page-frame.css` defines `.project-page`,
 * `.project-page__inner` and `.project-page__modal-description`. Before that
 * file existed they lived in `views/ProjectPage.css`, which only
 * `views/ProjectPage.tsx` imports — so Vite emitted them into the
 * project-page chunk and `workspace-panes/WorkspacePaneRouteView.tsx`, its
 * own lazily loaded route, rendered the frame without them on any load that
 * did not pass through the project page first. Measured live at 1440x900:
 * `.project-page__inner` padding `40px 32px 48px` / max-width `860px` /
 * x=410 w=860 arriving from the project page, against `0px` / `none` /
 * x=240 w=1200 on a direct load of the same URL.
 *
 * WHY THIS AND NOT ONLY THE BROWSER FIXTURE. `WorkspacePaneRouteView.frame
 * .test.tsx` measures the consequence in a real engine, but it measures ONE
 * module. This is the corpus rule: a THIRD route applying the frame's classes
 * without importing its stylesheet reds here, and it needs no browser.
 *
 * The scan adds `workspace-panes` to the three roots above — both routes that
 * render this frame's root are outside `views/` — and keeps its own counts so
 * a classifier that stops matching cannot pass vacuously.
 *
 * WHAT "IMPORTS IT" MEANS HERE: `source.includes(FRAME_STYLESHEET)`, the same
 * substring test the `page-layout.css` guard above uses. It is a MENTION, not
 * a parsed import — a comment naming the file satisfies it, and inside a
 * recorded entry's module a comment would produce a false red. Kept identical
 * to the precedent deliberately; the cost of a real import parse is not worth
 * the one shape it would catch, and every applier today has a real
 * side-effect import.
 */
describe('project-page-frame.css import guard (#1636)', () => {
  const FRAME_STYLESHEET = 'project-page-frame.css';
  const FRAME_STYLESHEET_PATH = join(UI_SRC, 'views', FRAME_STYLESHEET);

  /**
   * The tokens this guard governs are READ OUT OF the stylesheet, not listed
   * here. A hand-kept list is inert in both directions: a class added to that
   * sheet later would go unguarded, and — measured on the first draft of this
   * file — two of its three entries could be deleted with every assertion
   * still green, because every module applying one of them applies another.
   * Deriving them makes the set a fact about the file it protects.
   */
  function frameStylesheetClasses(): Set<string> {
    const css = readFileSync(FRAME_STYLESHEET_PATH, 'utf8');
    // Top-level rule heads only: a leading `.name` at column zero. Nested
    // (media-query) rules are indented and would only repeat a class the base
    // rule already declares.
    return new Set(
      [...css.matchAll(/^\.([A-Za-z0-9_-]+)\s*(?:,|\{)/gm)].map(
        (match) => match[1],
      ),
    );
  }

  const FRAME_TOKENS = frameStylesheetClasses();

  /**
   * Every root the frame's classes appear in. `workspace-panes` is the one
   * `SCAN_ROOTS` above does not cover, and it is where BOTH of the modules
   * this issue is about live — the route that lost the frame and the picker
   * that still applies one of its classes.
   */
  const FRAME_SCAN_ROOTS = [
    { dir: 'views', frameClassedCount: 2 },
    { dir: 'pages', frameClassedCount: 0 },
    { dir: 'components', frameClassedCount: 0 },
    { dir: 'workspace-panes', frameClassedCount: 2 },
  ] as const;

  /**
   * Modules that apply a frame class and do NOT import the stylesheet, with
   * why — recorded rather than silently allowed, and self-invalidating: an
   * entry whose module has stopped applying a frame class, or has started
   * importing the sheet, FAILS with an instruction to delete it. Neither is
   * an exemption from the rule; the first is a descendant of an owner that
   * satisfies it, the second is a live defect owned by another change.
   */
  const RECORDED_NON_IMPORTERS: Array<{
    file: string;
    reason: string;
    /**
     * The component this module exports, when its entry rests on having ONE
     * host that satisfies the rule. Present means that claim is DERIVED
     * below — the host set is scanned and the single host's import checked —
     * rather than asserted in the reason text.
     */
    singleHostOf?: string;
  }> = [
    {
      file: 'views/project-page/ProjectLayoutsSection.tsx',
      singleHostOf: 'ProjectLayoutsSection',
      reason:
        'Applies `project-page__modal-description` only. It has one host — ' +
        '`views/ProjectPage.tsx`, which imports the frame stylesheet and ' +
        'renders the frame ROOT it sits inside — so it cannot reach a chunk ' +
        "the sheet has not. This is archive#3306's own scope line: the " +
        'root-classed owner owns the import. Both halves of that claim are ' +
        'computed by the test below, because a SECOND host mounting it from a ' +
        'chunk with neither sheet is exactly what already happened to the ' +
        'picker in the next entry.',
    },
    {
      file: 'workspace-panes/ProjectWorkspacePaneCatalog.tsx',
      reason:
        'Applies `project-page__modal-description` and imports no stylesheet ' +
        'at all. Unlike the entry above this is NOT safe: ' +
        '`app-shell/ProjectLayoutRenderer.tsx` mounts this picker on the ' +
        'layout route, which renders no frame root and loads neither ' +
        'ProjectPage.css nor the frame sheet, so that paragraph is unstyled ' +
        'there today — a live instance of exactly the shape #1636 fixed, ' +
        'pre-existing and unchanged by it. The #1616 picker lane deletes this ' +
        'usage; this entry retires with it.',
    },
  ];

  function appliesFrameClass(source: string): boolean {
    for (const match of source.matchAll(CLASSNAME_ATTR)) {
      const value = match[1] ?? match[2] ?? '';
      const tokens = value.split(/\s+|\$\{[^}]*\}/);
      if (tokens.some((token) => FRAME_TOKENS.has(token))) return true;
    }
    return false;
  }

  const scanned = FRAME_SCAN_ROOTS.map((root) => ({
    ...root,
    files: scan(root.dir).map((file) => `${root.dir}/${file}`),
  }));
  const allFiles = scanned.flatMap((root) => root.files);

  /** Every module that applies a frame class today. */
  const FRAME_CLASSED_FIXTURES = [
    'views/ProjectPage.tsx',
    'views/project-page/ProjectLayoutsSection.tsx',
    'workspace-panes/WorkspacePaneRouteView.tsx',
    'workspace-panes/ProjectWorkspacePaneCatalog.tsx',
  ];

  /**
   * Known NOT frame-classed. Without these the guard also passes when
   * `appliesFrameClass` returns true for everything, which reads as "all
   * covered" while the tokens have stopped meaning anything. `ProjectPage.css`
   * is not scanned (this is a `.tsx` scan), so the negatives are modules that
   * sit right beside the appliers and legitimately apply nothing.
   */
  const NOT_FRAME_CLASSED_FIXTURES = [
    'views/project-page/ProjectPageHeader.tsx',
    'views/project-page/ProjectTasksSection.tsx',
    'workspace-panes/WorkspacePaneFrame.tsx',
    'workspace-panes/WorkspacePaneAvailabilityList.tsx',
  ];

  it('scans a real corpus (scope honesty)', () => {
    for (const fixture of [
      ...FRAME_CLASSED_FIXTURES,
      ...NOT_FRAME_CLASSED_FIXTURES,
      ...RECORDED_NON_IMPORTERS.map((entry) => entry.file),
    ]) {
      expect(allFiles, `${fixture} must be inside a scanned root`).toContain(
        fixture,
      );
    }
    expect(allFiles.length).toBeGreaterThan(300);
  });

  it('classifies the frame-classed modules, and only those', () => {
    for (const fixture of FRAME_CLASSED_FIXTURES) {
      expect(
        appliesFrameClass(read(fixture)),
        `${fixture} applies a frame class and must classify as frame-classed`,
      ).toBe(true);
    }
    for (const fixture of NOT_FRAME_CLASSED_FIXTURES) {
      expect(
        appliesFrameClass(read(fixture)),
        `${fixture} applies no frame class and must not classify as frame-classed`,
      ).toBe(false);
    }
  });

  it('classifies the expected number of modules in each scanned root', () => {
    for (const root of scanned) {
      const frameClassed = root.files.filter((file) =>
        appliesFrameClass(read(file)),
      );
      expect(
        frameClassed.length,
        `src-ui/src/${root.dir} now has ${frameClassed.length} frame-classed module(s), not ` +
          `${root.frameClassedCount}. If that is intended, update FRAME_SCAN_ROOTS in this file ` +
          `(frame-classed: ${frameClassed.join(', ')}).`,
      ).toBe(root.frameClassedCount);
    }
  });

  it('every module applying a frame class imports project-page-frame.css, except the recorded ones', () => {
    const recorded = new Set(RECORDED_NON_IMPORTERS.map((entry) => entry.file));
    const missing: string[] = [];
    for (const file of allFiles) {
      const source = read(file);
      if (!appliesFrameClass(source)) continue;
      if (source.includes(FRAME_STYLESHEET)) continue;
      if (recorded.has(file)) continue;
      missing.push(file);
    }
    expect(
      missing,
      `module(s) applying a project-page frame class without a side-effect ` +
        `import of views/${FRAME_STYLESHEET}. The frame must travel into the ` +
        `chunk that renders it — see #1636 and archive#3306: ` +
        missing.join(', '),
    ).toEqual([]);
  });

  it('the guarded tokens are the classes the stylesheet declares', () => {
    // The derivation itself, asserted rather than trusted: a regex that stops
    // matching yields an empty set, and every check in this describe would
    // then pass over nothing.
    expect([...FRAME_TOKENS].sort()).toEqual([
      'project-page',
      'project-page__inner',
      'project-page__modal-description',
    ]);
  });

  it('no module outside the scanned roots applies a frame class', () => {
    // Scope honesty for the SCAN, not the classifier. The four roots above
    // are where these classes live today; `app-shell/`, `layouts/`, `core/`
    // and the rest of `src-ui/src` are not scanned, so without this the
    // guard's promise ("a third route applying the class reds here") would
    // hold only inside a boundary nothing checked.
    const everyModule = glob.sync('**/*.tsx', {
      cwd: UI_SRC,
      nodir: true,
      ignore: ['**/__tests__/**'],
    });
    const scannedRoots = FRAME_SCAN_ROOTS.map((root) => `${root.dir}/`);
    const outside = everyModule.filter(
      (file) =>
        !scannedRoots.some((root) => file.startsWith(root)) &&
        appliesFrameClass(readFileSync(join(UI_SRC, file), 'utf8')),
    );
    expect(
      outside,
      `module(s) applying a project-page frame class from outside the scanned ` +
        `roots (${scannedRoots.join(', ')}), where this guard cannot see them. ` +
        `Add the owning directory to FRAME_SCAN_ROOTS: ` +
        outside.join(', '),
    ).toEqual([]);
    expect(
      everyModule.length,
      'the whole-tree glob matched almost nothing, so the check above passed vacuously',
    ).toBeGreaterThan(allFiles.length);
  });

  it('a single-host record really has one host, and that host imports the sheet', () => {
    // F2: the entry's safety argument is the claim "one host, and it imports
    // the sheet". Left as prose it is a label nothing computes — and a second
    // host arriving from a chunk with neither stylesheet is not hypothetical,
    // it is what the next entry records as a live defect.
    const singleHosted = RECORDED_NON_IMPORTERS.filter(
      (entry) => entry.singleHostOf,
    );
    expect(
      singleHosted.length,
      'no recorded entry claims a single host, so this derivation checks nothing',
    ).toBeGreaterThan(0);
    for (const entry of singleHosted) {
      const component = entry.singleHostOf!;
      const hosts = allFiles.filter((file) => {
        if (file === entry.file) return false;
        const source = read(file);
        return (
          new RegExp(`\\b${component}\\b`).test(source) &&
          /from ['"][^'"]*ProjectLayoutsSection['"]/.test(source)
        );
      });
      expect(
        hosts,
        `${entry.file}'s entry rests on having exactly one host. Hosts found: ` +
          `${hosts.join(', ') || 'none'}. A second host can mount it from a ` +
          `chunk that loads neither stylesheet — delete the entry and make the ` +
          `module import views/${FRAME_STYLESHEET} itself.`,
      ).toHaveLength(1);
      expect(
        read(hosts[0]).includes(FRAME_STYLESHEET),
        `${hosts[0]} is ${entry.file}'s only host but does not name ` +
          `${FRAME_STYLESHEET}, so the recorded entry certifies a frame the ` +
          `host cannot supply.`,
      ).toBe(true);
    }
  });

  it('every recorded non-importer is still one (the record cannot rot)', () => {
    for (const entry of RECORDED_NON_IMPORTERS) {
      const source = read(entry.file);
      expect(
        appliesFrameClass(source),
        `${entry.file} no longer applies a frame class, so its RECORDED_NON_IMPORTERS ` +
          `entry is stale — delete it.`,
      ).toBe(true);
      expect(
        source.includes(FRAME_STYLESHEET),
        `${entry.file} now imports ${FRAME_STYLESHEET}, so it satisfies the rule ` +
          `outright — delete its RECORDED_NON_IMPORTERS entry.`,
      ).toBe(false);
      expect(
        entry.reason.length,
        `${entry.file}'s entry needs a reason that says why it does not import the sheet`,
      ).toBeGreaterThan(80);
    }
  });
});
