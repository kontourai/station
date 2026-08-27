import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BESPOKE_HEADER_EXCEPTIONS,
  countStackedHeadings,
  findBespokeHeaderSignals,
  findPageHeaderBlocks,
  HEADER_PINNED_SCOPE_INVENTORY,
  HEADER_SCAN_EXTENSIONS,
  HEADER_SCAN_ROOTS,
  HEADING_PINNED_SCOPE_INVENTORY,
  HEADING_SCAN_EXTENSIONS,
  HEADING_SCAN_ROOTS,
  isHeadingSurface,
  listTrackedHeaderScanFiles,
  scanBespokeHeaders,
  scanStackedHeadings,
} from '../shell-conformance-ratchet.mjs';

function readFileFromMap(files: Record<string, string>) {
  return (file: string) => {
    if (!(file in files)) {
      throw new Error(`unexpected read: ${file}`);
    }
    return files[file];
  };
}

describe('shell-conformance-ratchet', () => {
  // SHELL-11/SHELL-17 — the first counted signal. A view may not write the
  // page header; `components/page-frame` renders it and
  // `app-shell/page-frame-registry.ts` decides which routes get one.
  describe('bespoke page headers', () => {
    it('reads a view that renders no header of its own as conformant', () => {
      const content = `
        export function FixtureView() {
          return <SplitPaneLayout items={items}>{detail}</SplitPaneLayout>;
        }
      `;
      expect(findBespokeHeaderSignals(content)).toEqual([]);
    });

    it('flags hand-written canonical page-header markup', () => {
      const content = `
        export function FixtureView() {
          return (
            <div className="page__header">
              <div className="page__label">schedule</div>
              <h2 className="page__title">Schedule</h2>
            </div>
          );
        }
      `;
      expect(findBespokeHeaderSignals(content)).toEqual([
        'canonical page-header class written by hand',
        'header block with a page-level heading',
      ]);
    });

    it('flags a page-level <h1>', () => {
      expect(findBespokeHeaderSignals('<h1 id="x">Logs</h1>')).toEqual([
        'page-level <h1>',
      ]);
      expect(findBespokeHeaderSignals('<h1>Logs</h1>')).toEqual([
        'page-level <h1>',
      ]);
    });

    it('does not flag a longer tag that merely starts with h1', () => {
      expect(findBespokeHeaderSignals('<h1x>no</h1x>')).toEqual([]);
    });

    it('does not flag a different header family that ends in page__header', () => {
      // `project-page__header` is the project workspace's own class, and the
      // boundary guard is the only thing separating it from a rule about
      // `page__header`. Without it this file — a documented, deliberate
      // exception surface — would be counted as a bespoke page header.
      expect(
        findBespokeHeaderSignals('<div className="project-page__header">'),
      ).toEqual([]);
      expect(findBespokeHeaderSignals('.page-section__header {}')).toEqual([]);
    });

    it('does not flag a heading level the shell contract prescribes', () => {
      expect(findBespokeHeaderSignals('<h2>Section</h2><h3>Item</h3>')).toEqual(
        [],
      );
    });

    // The reviewer's example, verbatim (REVIEW-C1-findings M2): ordinary
    // markup in a vocabulary of its own, which passed this gate at ceiling
    // zero while it was looking only for canonical class tokens and <h1>.
    it('flags a header block titled at page level, in any vocabulary', () => {
      const content = `
        export function ToolsView() {
          return (
            <header className="tools-view__header">
              <h2>Tools</h2>
            </header>
          );
        }
      `;
      expect(findPageHeaderBlocks(content)).toEqual(['tools-view__header']);
      expect(findBespokeHeaderSignals(content)).toEqual([
        'header block with a page-level heading',
      ]);
    });

    it('flags a bare <header> element titled at page level', () => {
      expect(findPageHeaderBlocks('<header><h1>Home</h1></header>')).toEqual([
        '<header>',
      ]);
    });

    it('does not flag a header block titled at the level the rule prescribes', () => {
      // A card header, a detail-pane item title, a section heading: <h3> is
      // what `docs/design/shell-skeletons.md` §2.1 asks for, and counting it
      // would make the gate teach the opposite of the rule.
      const content = `
        <div className="plugins__card-header"><h3>{plugin.name}</h3></div>
        <header className="review-queue-detail__header"><h3>{change.path}</h3></header>
      `;
      expect(findPageHeaderBlocks(content)).toEqual([]);
      expect(findBespokeHeaderSignals(content)).toEqual([]);
    });

    it('does not flag a page-level heading that is not inside a header block', () => {
      // The narrowed claim, stated as a test rather than only in prose: a
      // section's own <h2> with no header element or header class around it
      // is out of this signal's scope (the stacked-heading signal below
      // covers it wherever the file also renders a canonical header).
      expect(
        findPageHeaderBlocks(
          '<section className="card"><h2>Restart history</h2></section>',
        ),
      ).toEqual([]);
    });

    it('reads a header block whose class expression contains a > character', () => {
      // `[^>]*` would end the opening tag inside the template literal and
      // then read the rest of the expression as markup, so the heading
      // inside the real element would never be reached.
      const content = [
        '<div',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS source text containing a template placeholder
        "  className={`editor__tools-server-header${n > 0 ? ' is-open' : ''}`}",
        '>',
        '  <h2>Servers</h2>',
        '</div>',
      ].join('\n');
      expect(findPageHeaderBlocks(content)).toEqual([
        'editor__tools-server-header',
      ]);
    });

    it('closes a header block at its own close tag, not a nested one', () => {
      const content =
        '<div className="x__header"><div><span /></div></div><h2>after</h2>';
      expect(findPageHeaderBlocks(content)).toEqual([]);
    });

    it('exempts the project workspace family, and only that one', () => {
      // The guard used to exempt EVERY `*-page__header`, so a brand-new
      // `tools-page__header` — the same bespoke header under a different
      // word — passed a rule about `page__header`.
      expect(
        findBespokeHeaderSignals('<div className="project-page__header">'),
      ).toEqual([]);
      expect(
        findBespokeHeaderSignals('<div className="tools-page__header">'),
      ).toEqual(['canonical page-header class written by hand']);
    });

    it('separates bespoke files from excepted ones', () => {
      const files = {
        'a.tsx': '<h1>Bespoke</h1>',
        'b.tsx': '<div className="page__title" />',
        'c.tsx': '<SplitPaneLayout />',
      };
      const result = scanBespokeHeaders(
        Object.keys(files),
        readFileFromMap(files),
        new Map([['b.tsx', 'reason']]),
      );
      expect(result.bespoke).toEqual([
        { file: 'a.tsx', signals: ['page-level <h1>'] },
      ]);
      expect(result.excepted).toEqual([
        {
          file: 'b.tsx',
          signals: ['canonical page-header class written by hand'],
        },
      ]);
      expect(result.staleExceptions).toEqual([]);
      expect(result.missingExceptions).toEqual([]);
    });

    it('reports an exception whose file no longer has a bespoke header', () => {
      const files = { 'b.tsx': '<SplitPaneLayout />' };
      const result = scanBespokeHeaders(
        Object.keys(files),
        readFileFromMap(files),
        new Map([['b.tsx', 'reason']]),
      );
      expect(result.staleExceptions).toEqual(['b.tsx']);
    });

    it('reports an exception naming a file that is no longer in scope', () => {
      const files = { 'a.tsx': '<SplitPaneLayout />' };
      const result = scanBespokeHeaders(
        Object.keys(files),
        readFileFromMap(files),
        new Map([['gone.tsx', 'reason']]),
      );
      expect(result.missingExceptions).toEqual(['gone.tsx']);
    });
  });

  describe('bespoke page headers (repo-source integration)', () => {
    it('scans both route directories, recursively, and pins four files inside them', () => {
      expect(HEADER_SCAN_ROOTS).toEqual([
        'src-ui/src/views',
        'src-ui/src/pages',
      ]);
      expect(HEADER_SCAN_EXTENSIONS).toEqual(['.tsx']);
      expect(HEADER_PINNED_SCOPE_INVENTORY).toEqual([
        'src-ui/src/views/AgentsView.tsx',
        'src-ui/src/views/ScheduleView.tsx',
        'src-ui/src/pages/NotificationsPage.tsx',
        'src-ui/src/views/home/HomeSurface.tsx',
      ]);
      const files = listTrackedHeaderScanFiles();
      for (const pinned of HEADER_PINNED_SCOPE_INVENTORY) {
        expect(files).toContain(pinned);
      }
    });

    it('holds the repo at zero un-excepted bespoke headers', () => {
      const files = listTrackedHeaderScanFiles();
      const result = scanBespokeHeaders(
        files,
        (file: string) => readFileSync(file, 'utf8'),
        BESPOKE_HEADER_EXCEPTIONS,
      );
      expect(result.bespoke).toEqual([]);
      expect(result.staleExceptions).toEqual([]);
      expect(result.missingExceptions).toEqual([]);
    });

    it('every exception states a reason and still carries a header', () => {
      const files = listTrackedHeaderScanFiles();
      const result = scanBespokeHeaders(
        files,
        (file: string) => readFileSync(file, 'utf8'),
        BESPOKE_HEADER_EXCEPTIONS,
      );
      expect(result.excepted.map((entry) => entry.file).sort()).toEqual(
        [...BESPOKE_HEADER_EXCEPTIONS.keys()].sort(),
      );
      for (const reason of BESPOKE_HEADER_EXCEPTIONS.values()) {
        expect(reason.length).toBeGreaterThan(40);
      }
    });
  });

  // station#2931 — the second counted signal. See the script's file header for
  // what "stacked" means: a page-level heading a file writes ITSELF, in a file
  // where <DetailHeader>/<SplitPaneLayout> already owns the page-level title.
  describe('stacked page-level headings', () => {
    it('ignores a file that renders no canonical header', () => {
      const content = `
        export function Section() {
          return <section><h2>Recent work</h2></section>;
        }
      `;
      expect(isHeadingSurface(content)).toBe(false);
      expect(countStackedHeadings(content)).toBe(0);
    });

    it('counts a page-level heading written beside a DetailHeader', () => {
      const content = `
        export function View() {
          return (
            <div className="page">
              <DetailHeader title={task.title} />
              <h2>Task experiences</h2>
            </div>
          );
        }
      `;
      expect(isHeadingSurface(content)).toBe(true);
      expect(countStackedHeadings(content)).toBe(1);
    });

    it('counts a page-level heading written inside a SplitPaneLayout detail slot', () => {
      const content = `
        export function View() {
          return (
            <SplitPaneLayout title="Review Queue">
              <header><h2>{change.path}</h2></header>
            </SplitPaneLayout>
          );
        }
      `;
      expect(countStackedHeadings(content)).toBe(1);
    });

    it('counts h1 as well as h2, and counts every occurrence', () => {
      const content = `
        <DetailHeader title="x" />
        <h1>One</h1>
        <h2>Two</h2>
        <h2>Three</h2>
      `;
      expect(countStackedHeadings(content)).toBe(3);
    });

    it('does not count item-level headings — the level the rule prescribes', () => {
      const content = `
        export function View() {
          return (
            <SplitPaneLayout title="Review Queue">
              <header><h3>{change.path}</h3></header>
              <h3>Reviewer execution</h3>
            </SplitPaneLayout>
          );
        }
      `;
      expect(countStackedHeadings(content)).toBe(0);
    });

    it('does not match a longer tag that merely starts with h1/h2', () => {
      expect(countStackedHeadings('<DetailHeader /><h2x>no</h2x>')).toBe(0);
    });

    it('aggregates per file and reports a total, worst file first', () => {
      const files = {
        'a.tsx': '<DetailHeader /><h2>one</h2>',
        'b.tsx': '<SplitPaneLayout><h2>a</h2><h2>b</h2></SplitPaneLayout>',
        'c.tsx': '<section><h2>not a heading surface</h2></section>',
      };
      const result = scanStackedHeadings(
        Object.keys(files),
        readFileFromMap(files),
      );
      expect(result.total).toBe(3);
      expect(result.findings).toEqual([
        { file: 'b.tsx', count: 2 },
        { file: 'a.tsx', count: 1 },
      ]);
    });

    it('reports zero findings for a clean set', () => {
      const files = { 'a.tsx': '<DetailHeader title="x" />' };
      const result = scanStackedHeadings(
        Object.keys(files),
        readFileFromMap(files),
      );
      expect(result).toEqual({ findings: [], total: 0 });
    });
  });

  describe('stacked headings (repo-source integration)', () => {
    it('pins the two files the signal was built from, inside the declared roots', () => {
      expect(HEADING_SCAN_ROOTS).toEqual(['src-ui/src']);
      expect(HEADING_SCAN_EXTENSIONS).toEqual(['.tsx']);
      // The pinned inventory is what stops the roots being narrowed to hide a
      // known instance; assert the exact paths, not just that it is non-empty.
      expect(HEADING_PINNED_SCOPE_INVENTORY).toEqual([
        'src-ui/src/views/ReviewQueueView.tsx',
        'src-ui/src/views/TaskWorkspaceView.tsx',
      ]);
      for (const file of HEADING_PINNED_SCOPE_INVENTORY) {
        expect(file.startsWith(`${HEADING_SCAN_ROOTS[0]}/`)).toBe(true);
      }
    });

    it('reads both pinned files as heading surfaces carrying no stacked heading', () => {
      for (const file of HEADING_PINNED_SCOPE_INVENTORY) {
        const content = readFileSync(file, 'utf8');
        // Both still render a canonical header — a file that stopped doing so
        // would drop out of the count silently, which is the gap this asserts.
        expect(isHeadingSurface(content)).toBe(true);
        expect(countStackedHeadings(content)).toBe(0);
      }
    });
  });
});
