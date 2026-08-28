/**
 * @vitest-environment jsdom
 *
 * archive#3315 — sidebar project reorder: the drag handle's pointer path, the
 * keyboard move path, and the invariant that reordering never reassigns the
 * slug-derived accent colors.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ProjectMetadata } from '../contexts/ProjectsContext';

const layoutsQueryMock = vi.fn(() => ({ data: [] }));

vi.mock('@kontourai/station-sdk', () => ({
  useProjectLayoutsQuery: () => layoutsQueryMock(),
  useBoardAvailabilityQuery: () => ({ data: undefined }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    setProject: vi.fn(),
    setLayout: vi.fn(),
  }),
}));

import { ProjectSidebarRow } from '../components/project-sidebar/ProjectSidebarRow';
import { projectAccents } from '../components/project-sidebar/projectAccent';
import {
  dropEdgeFor,
  reorderedSlugs,
  useProjectListReorder,
} from '../components/project-sidebar/useProjectListReorder';

// jsdom has no pointer-capture implementation.
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
}

function projectFor(slug: string): ProjectMetadata {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    hasWorkingDirectory: false,
    layoutCount: 0,
    hasKnowledge: false,
  };
}

function Harness({
  slugs,
  onCommit,
}: {
  slugs: string[];
  onCommit: (order: string[]) => void;
}) {
  const { rowReorderProps, announcement } = useProjectListReorder(
    slugs,
    onCommit,
    { labelFor: (slug) => slug.toUpperCase() },
  );
  return (
    <div>
      {slugs.map((slug, index) => (
        <ProjectSidebarRow
          key={slug}
          project={projectFor(slug)}
          isActive={false}
          activeLayout={null}
          collapsed={false}
          reorder={rowReorderProps(index)}
        />
      ))}
      <span role="status" aria-live="polite" data-testid="reorder-status">
        {announcement}
      </span>
    </div>
  );
}

/**
 * The sidebar's own wiring: `onCommit` applies the order, which is what makes
 * the keyed rows relocate and drop focus. A harness that swallows the commit
 * cannot exercise the focus-restore at all.
 */
function LiveHarness({ initial }: { initial: string[] }) {
  const [slugs, setSlugs] = useState(initial);
  return <Harness slugs={slugs} onCommit={setSlugs} />;
}

/** Give each rendered row a real vertical extent (jsdom rects are all zero). */
function layoutRows(container: HTMLElement, rowHeight = 40) {
  const rows = container.querySelectorAll('.sidebar__project-row');
  rows.forEach((row, index) => {
    (row as HTMLElement).getBoundingClientRect = () =>
      ({
        top: index * rowHeight,
        bottom: (index + 1) * rowHeight,
        height: rowHeight,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: index * rowHeight,
        toJSON: () => ({}),
      }) as DOMRect;
  });
}

afterEach(cleanup);

describe('project sidebar reorder (station#3315)', () => {
  test('reorderedSlugs applies splice semantics', () => {
    expect(reorderedSlugs(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(reorderedSlugs(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  test('keyboard: ArrowDown on the handle commits the moved order', () => {
    const onCommit = vi.fn();
    render(<Harness slugs={['alpha', 'beta', 'gamma']} onCommit={onCommit} />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder alpha' }), {
      key: 'ArrowDown',
    });
    expect(onCommit).toHaveBeenCalledWith(['beta', 'alpha', 'gamma']);
  });

  test('keyboard: ArrowUp at the top edge commits nothing', () => {
    const onCommit = vi.fn();
    render(<Harness slugs={['alpha', 'beta']} onCommit={onCommit} />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder alpha' }), {
      key: 'ArrowUp',
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('pointer: dragging the handle past the next row commits the moved order', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <Harness slugs={['alpha', 'beta', 'gamma']} onCommit={onCommit} />,
    );
    layoutRows(container);

    const handle = screen.getByRole('button', { name: 'Reorder alpha' });
    fireEvent.pointerDown(handle, { clientY: 20, button: 0 });
    // Below beta's midpoint (row 1 spans 40..80, midpoint 60).
    fireEvent.pointerMove(handle, { clientY: 70 });
    fireEvent.pointerUp(handle, { clientY: 70 });

    expect(onCommit).toHaveBeenCalledWith(['beta', 'alpha', 'gamma']);
  });

  // The indicator used to be `drag.to === index` drawn at the target row's TOP
  // edge. `to` is a POST-removal insertion index, so on a downward drag the
  // line rendered one row above where the row actually landed (rows A,B,C at
  // 40px; drag A to y=70 gives to=1, a line at y=40, and a drop of [B,A,C] with
  // A at y=80). These pin the indicator against the committed order.
  test.each([
    ['downward', 0, 70, 1, 'sidebar__project-row--drop-after'],
    ['upward', 2, 10, 0, 'sidebar__project-row--drop-before'],
  ] as const)(
    'pointer: a %s drag marks the edge the row will land against',
    (_direction, fromRow, clientY, markedRow, markerClass) => {
      const onCommit = vi.fn();
      const { container } = render(
        <Harness slugs={['alpha', 'beta', 'gamma']} onCommit={onCommit} />,
      );
      layoutRows(container);

      const slug = ['alpha', 'beta', 'gamma'][fromRow];
      const handle = screen.getByRole('button', { name: `Reorder ${slug}` });
      fireEvent.pointerDown(handle, { clientY: fromRow * 40 + 20, button: 0 });
      fireEvent.pointerMove(handle, { clientY });

      const rows = Array.from(
        container.querySelectorAll('.sidebar__project-row'),
      );
      const marked = rows.filter(
        (row) =>
          row.classList.contains('sidebar__project-row--drop-before') ||
          row.classList.contains('sidebar__project-row--drop-after'),
      );
      expect(marked).toHaveLength(1);
      expect(rows.indexOf(marked[0])).toBe(markedRow);
      expect(marked[0].classList.contains(markerClass)).toBe(true);

      // The marker's promise, checked against what the drop actually does.
      fireEvent.pointerUp(handle, { clientY });
      const committed = onCommit.mock.calls[0][0] as string[];
      const landedAfter = committed.indexOf(slug) - 1;
      const landedBefore = committed.indexOf(slug) + 1;
      const neighbour =
        markerClass === 'sidebar__project-row--drop-after'
          ? committed[landedAfter]
          : committed[landedBefore];
      // The marked row is the one the dragged row ends up adjacent to, on the
      // marked side.
      expect(rows[markedRow].textContent).toContain(neighbour);
    },
  );

  test('dropEdgeFor: no marker for a non-move, and only on the target row', () => {
    expect(dropEdgeFor(1, 1, 1)).toBe(null);
    expect(dropEdgeFor(0, 2, 1)).toBe(null);
    expect(dropEdgeFor(0, 2, 2)).toBe('bottom');
    expect(dropEdgeFor(2, 0, 0)).toBe('top');
  });

  test('pointer: releasing at the origin commits nothing', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <Harness slugs={['alpha', 'beta']} onCommit={onCommit} />,
    );
    layoutRows(container);

    const handle = screen.getByRole('button', { name: 'Reorder alpha' });
    fireEvent.pointerDown(handle, { clientY: 10, button: 0 });
    fireEvent.pointerUp(handle, { clientY: 15 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  // archive#3331 — a keyboard move used to be entirely silent, and the
  // optimistic reorder relocates the focused handle's DOM node, so the next
  // Arrow press went nowhere.
  test('keyboard: each move announces the new position in the live region', () => {
    render(<LiveHarness initial={['alpha', 'beta', 'gamma']} />);

    const status = screen.getByTestId('reorder-status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');

    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder alpha' }), {
      key: 'ArrowDown',
    });
    expect(status.textContent).toBe('ALPHA moved to position 2 of 3');

    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder alpha' }), {
      key: 'ArrowDown',
    });
    expect(status.textContent).toBe('ALPHA moved to position 3 of 3');
  });

  test('keyboard: a blocked move at the edge announces nothing', () => {
    render(<LiveHarness initial={['alpha', 'beta']} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder alpha' }), {
      key: 'ArrowUp',
    });
    expect(screen.getByTestId('reorder-status').textContent).toBe('');
  });

  // archive#3331 predicted that the optimistic reorder relocates the focused
  // handle and drops focus, so the second Arrow press would go nowhere. This
  // pins the OBSERVED behaviour instead — consecutive presses keep moving the
  // same row — which a real-browser A/B confirmed in Chromium and WebKit with
  // no focus-restore code present. jsdom cannot arbitrate focus-on-move, so
  // this asserts the moves, not the focus.
  test('keyboard: consecutive presses on the same handle keep moving that row', () => {
    const { container } = render(
      <LiveHarness initial={['alpha', 'beta', 'gamma']} />,
    );
    const rowNames = () =>
      Array.from(container.querySelectorAll('.sidebar__project-name')).map(
        (node) => node.textContent,
      );

    const handle = screen.getByRole('button', { name: 'Reorder alpha' });
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(rowNames()).toEqual(['beta', 'alpha', 'gamma']);

    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(rowNames()).toEqual(['beta', 'gamma', 'alpha']);
    // The handle element itself survives the reorder — React moves the keyed
    // node rather than remounting it, which is why focus survives in a browser.
    expect(handle.isConnected).toBe(true);
    expect(screen.getByRole('button', { name: 'Reorder alpha' })).toBe(handle);
  });

  // A pointer drag shows what it did; announcing it too would spam the region
  // on every commit.
  test('pointer: a drag commit does not write to the live region', () => {
    const { container } = render(
      <LiveHarness initial={['alpha', 'beta', 'gamma']} />,
    );
    layoutRows(container);

    const handle = screen.getByRole('button', { name: 'Reorder alpha' });
    fireEvent.pointerDown(handle, { clientY: 20, button: 0 });
    fireEvent.pointerUp(handle, { clientY: 70 });

    expect(screen.getByTestId('reorder-status').textContent).toBe('');
  });

  // archive#3331. jsdom evaluates no media query and computes no
  // layout, so this pins only the stylesheet's own text — every assertion is
  // scoped to the rule it is about, because an unscoped `css.toContain(...)`
  // is satisfied by any rule in the file and discriminates nothing.
  //
  // The RENDERED result was measured separately, under Chromium coarse-pointer
  // emulation against a live Station: `(pointer: coarse)` matched, the handle
  // computed to opacity 1 / 28x44 / touch-action none, the row-main box
  // measured 44px so adjacent handles tile instead of overlapping, and the
  // project name's right edge sat left of the handle's left edge. The same
  // probe with `opacity: 1` reverted reproduced the invisible-but-active trap.
  test('the reorder handle is visible and 44px-tall on coarse pointers (station#3331)', () => {
    const css = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../components/project-sidebar/ProjectSidebar.css',
      ),
      'utf8',
    );
    /** The declarations of the first rule whose selector line matches. */
    const ruleBody = (selector: string): string => {
      const start = css.indexOf(`\n${selector} {`);
      expect(start).toBeGreaterThan(-1);
      const from = start + selector.length + 4;
      return css.slice(from, css.indexOf('\n}', from));
    };

    // Base rule: hidden by default, and it owns the gesture. Both facts have
    // to live on the SAME rule for the trap to be what archive#3331 described.
    const base = ruleBody('.sidebar__reorder-handle');
    expect(base).toContain('opacity: 0');
    expect(base).toContain('touch-action: none');

    // Coarse block: visible, and the row grown so the 44px target fits inside
    // a row that was 34px (6px padding + a 22px accent, no min-height).
    const coarseStart = css.indexOf('@media (pointer: coarse)');
    expect(coarseStart).toBeGreaterThan(-1);
    const coarse = css.slice(coarseStart);
    const coarseBlock = coarse.slice(0, coarse.indexOf('}\n}'));
    expect(coarseBlock).toContain('opacity: 1');
    expect(coarseBlock).toContain('height: 44px');
    expect(coarseBlock).toContain('min-height: 44px');
    // The base rule's 0 must not survive into the coarse block.
    expect(coarseBlock).not.toContain('opacity: 0');

    // archive#3346: the row's other control. Whole-block `toContain` cannot
    // tell whose 44px it found — the handle already contributes one — so read
    // the chevron's own nested rule.
    const coarseRuleBody = (selector: string): string => {
      const start = coarseBlock.indexOf(`\n  ${selector} {`);
      expect(start).toBeGreaterThan(-1);
      const from = start + selector.length + 6;
      return coarseBlock.slice(from, coarseBlock.indexOf('\n  }', from));
    };
    const chevron = coarseRuleBody(
      '.sidebar:not(.sidebar--collapsed) .sidebar__chevron',
    );
    expect(chevron).toContain('height: 44px');
    // 28px is the widest that clears the handle's column, so the pair must
    // stay consistent: handle at right 34px + 28px wide, chevron at right 4px
    // + 28px wide, and the row reserving 66px for text left of both.
    expect(chevron).toContain('width: 28px');
    expect(chevron).toContain('right: 4px');
    const handle = coarseRuleBody('.sidebar__reorder-handle');
    expect(handle).toContain('width: 28px');
    expect(handle).toContain('right: 34px');
    const row = coarseRuleBody(
      '.sidebar:not(.sidebar--collapsed) .sidebar__project-btn',
    );
    expect(row).toContain('padding-right: 66px');
    // Base geometry the coarse block overrides — 20px wide at right 8px keeps
    // the same 18px centre, which is why the glyph does not move.
    const chevronBase = ruleBody('.sidebar__chevron');
    expect(chevronBase).toContain('width: 20px');
    expect(chevronBase).toContain('right: 8px');
  });

  // The accent palette is allocated over the SORTED slug set
  // (`projectAccents`), so an order change must never repaint a project.
  test('reordering does not reassign slug-derived accent colors', () => {
    const before = projectAccents(['alpha', 'beta', 'gamma']);
    const after = projectAccents(
      reorderedSlugs(['alpha', 'beta', 'gamma'], 0, 2),
    );
    for (const slug of ['alpha', 'beta', 'gamma']) {
      expect(after.get(slug)).toBe(before.get(slug));
    }
  });
});
