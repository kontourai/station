/**
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect, useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
  }),
}));

// Drive the layout's responsive branch through the shared hook so tests can
// flip between desktop and mobile deterministically.
const isMobileMock = vi.fn(() => false);
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => isMobileMock(),
  MOBILE_MEDIA_QUERY: '(max-width: 768px)',
}));

import { PageFrame } from '../components/page-frame';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import {
  SplitPaneReturnFocusProvider,
  useSplitPaneExternalReturnFocus,
} from '../components/split-pane-return-focus-context';

const splitPaneCss = readFileSync(
  'src-ui/src/components/SplitPaneLayout.css',
  'utf8',
);
const skeletonCss = readFileSync('src-ui/src/components/Skeleton.css', 'utf8');

function cssRuleFrom(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  const end = css.indexOf('\n}', start);
  return start === -1 || end === -1 ? '' : css.slice(start, end + 2);
}

function cssRule(selector: string): string {
  return cssRuleFrom(splitPaneCss, selector);
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

describe('SplitPaneLayout', () => {
  beforeEach(() => {
    isMobileMock.mockReturnValue(false);
    window.localStorage.clear();
  });

  test('owns mobile detail-sheet dock and back clearance in the shared shell', () => {
    const back = cssRule('.split-pane__back');
    const sheet = cssRule('.split-pane__right--sheet');
    const portaledSheet = cssRule('.split-pane__right--portaled');
    const sheetDetailHeader = cssRule(
      '.split-pane__right--sheet .detail-header',
    );
    const mobileStart = splitPaneCss.indexOf('@media (max-width: 768px)');

    expect(sheet).toContain('--split-pane-mobile-back-height: 44px;');
    expect(back).toContain('min-height: var(--split-pane-mobile-back-height);');
    expect(splitPaneCss).not.toContain('.split-pane__right::after');
    expect(sheet).toContain('position: absolute;');
    expect(sheet).toContain('inset: 0;');
    expect(portaledSheet).toContain('position: fixed;');
    expect(portaledSheet).toContain('--app-toolbar-total-height, 46px');
    expect(portaledSheet).toContain('--banner-stack-height, 0px');
    expect(portaledSheet).toContain('right: 0;');
    expect(portaledSheet).toContain('left: 0;');
    expect(portaledSheet).toContain('--dock-slot-size');
    expect(portaledSheet).toContain('--chat-dock-header-height, 38px');
    expect(portaledSheet).toContain('--safe-bottom, 0px');
    expect(portaledSheet).toContain('--visual-viewport-bottom-inset, 0px');
    expect(portaledSheet).toContain('z-index: var(--layer-sticky);');
    expect(sheet).toContain(
      'scroll-padding-top: var(--split-pane-mobile-back-height);',
    );
    expect(sheetDetailHeader).toContain('position: static;');
    expect(splitPaneCss.indexOf(sheet)).toBeGreaterThan(mobileStart);
    expect(splitPaneCss.indexOf(sheetDetailHeader)).toBeGreaterThan(
      mobileStart,
    );
  });

  test('renders entity-specific list empty copy when provided', () => {
    render(
      <SplitPaneLayout
        label="skills"
        paneId="skills"
        title="Skills"
        items={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onSearch={vi.fn()}
        listEmptyTitle="No skills yet"
        listEmptyDescription="Create a workspace skill."
      >
        <div>detail pane</div>
      </SplitPaneLayout>,
    );

    expect(screen.getByText('No skills yet')).toBeTruthy();
    expect(screen.getByText('Create a workspace skill.')).toBeTruthy();
  });

  // archive#4463 (the double-empty rule): an empty list has nothing
  // to select, so the detail pane's default "nothing selected" copy is not a
  // second fact — it repeats the list pane's own empty message. Review's
  // queue showed both at once (the); this is the
  // mechanism every split-pane route inherits.
  describe('the double-empty rule', () => {
    test('an empty list suppresses the default detail empty state entirely', () => {
      render(
        <SplitPaneLayout
          label="skills"
          title="Skills"
          items={[]}
          selectedId={null}
          onSelect={vi.fn()}
          onSearch={vi.fn()}
          listEmptyTitle="No skills yet"
          emptyTitle="Nothing selected"
          emptyDescription="Select a skill from the list"
        >
          <div>detail pane</div>
        </SplitPaneLayout>,
      );

      expect(screen.getByText('No skills yet')).toBeTruthy();
      expect(screen.queryByText('Nothing selected')).toBeNull();
      expect(screen.queryByText('Select a skill from the list')).toBeNull();
    });

    test('a non-empty list with nothing selected keeps the default detail empty state', () => {
      render(
        <SplitPaneLayout
          label="skills"
          title="Skills"
          items={[{ id: 'a', name: 'Alpha' }]}
          selectedId={null}
          onSelect={vi.fn()}
          onSearch={vi.fn()}
          emptyTitle="Nothing selected"
          emptyDescription="Select a skill from the list"
        >
          <div>detail pane</div>
        </SplitPaneLayout>,
      );

      expect(screen.getByText('Nothing selected')).toBeTruthy();
    });

    test('a search that filters the list to nothing also suppresses the detail default', () => {
      render(
        <SplitPaneLayout
          label="skills"
          title="Skills"
          items={[]}
          selectedId={null}
          onSelect={vi.fn()}
          onSearch={vi.fn()}
          searchValue="zzz"
          emptyTitle="Nothing selected"
        >
          <div>detail pane</div>
        </SplitPaneLayout>,
      );

      expect(screen.getByText('Nothing in items matches “zzz”')).toBeTruthy();
      expect(screen.queryByText('Nothing selected')).toBeNull();
    });

    test('a caller-supplied emptyContent is trusted even when the list is empty', () => {
      render(
        <SplitPaneLayout
          label="connections"
          title="Engines"
          items={[]}
          selectedId={null}
          onSelect={vi.fn()}
          onSearch={vi.fn()}
          emptyContent={<div>Add catalog</div>}
        >
          <div>detail pane</div>
        </SplitPaneLayout>,
      );

      expect(screen.getByText('Add catalog')).toBeTruthy();
    });

    // a failed read is ALSO an empty items array, so the
    // detail default must defer here too — the list pane's error message is
    // the one fact worth showing, not "error" beside a "nothing selected"
    // that has nothing to do with the read that failed.
    test('a list-read error also suppresses the default detail empty state', () => {
      render(
        <SplitPaneLayout
          label="skills"
          title="Skills"
          items={[]}
          selectedId={null}
          onSelect={vi.fn()}
          onSearch={vi.fn()}
          error={new Error('skills read failed')}
          listErrorTitle="Unable to load skills"
          emptyTitle="Nothing selected"
          emptyDescription="Select a skill from the list"
        >
          <div>detail pane</div>
        </SplitPaneLayout>,
      );

      expect(screen.getByText('Unable to load skills')).toBeTruthy();
      expect(screen.queryByText('Nothing selected')).toBeNull();
      expect(screen.queryByText('Select a skill from the list')).toBeNull();
    });

    test('unselectedDetailOpen keeps the default detail state even over an empty list', () => {
      render(
        <SplitPaneLayout
          label="connections"
          title="Engines"
          items={[]}
          selectedId={null}
          onSelect={vi.fn()}
          onSearch={vi.fn()}
          emptyTitle="Select an engine"
          unselectedDetailOpen
        >
          <div>detail pane</div>
        </SplitPaneLayout>,
      );

      expect(screen.getByText('Select an engine')).toBeTruthy();
    });
  });

  // the eight split-pane routes each derived "the list is empty"
  // from `items.length === 0`, which is ALSO what a failed read produces —
  // Guidance asserted "No installed skills yet" over a 500. The failure branch
  // is the shell's, so every route gets it from one place.
  test('renders the read failure instead of the list empty state', () => {
    const onRetry = vi.fn();
    render(
      <SplitPaneLayout
        label="skills"
        title="Installed Skills"
        items={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onSearch={vi.fn()}
        listEmptyTitle="No installed skills yet"
        error={new Error('skills read failed')}
        onRetry={onRetry}
        listErrorTitle="Unable to load skills"
      >
        <div />
      </SplitPaneLayout>,
    );

    expect(screen.queryByText('No installed skills yet')).toBeNull();
    expect(screen.getByText('Unable to load skills')).toBeTruthy();
    expect(screen.getByText('skills read failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // archive#771: `error` used to outrank `items`
  // unconditionally, so a REFETCH failure with cached items still on hand
  // blanked a working list behind an error card — the exact regression archive#769
  // exists to prevent (ProjectPage renders cached data with no banner on a
  // refetch failure). A non-empty `items` must win: the list keeps
  // rendering, with no new banner UI, exactly as it did before the refetch.
  test('a refetch failure with cached items keeps the list rendering, not the error card', () => {
    const onRetry = vi.fn();
    render(
      <SplitPaneLayout
        label="skills"
        title="Installed Skills"
        items={[{ id: 'skill-1', name: 'Pizza skill' }]}
        selectedId={null}
        onSelect={vi.fn()}
        onSearch={vi.fn()}
        error={new Error('skills read failed')}
        onRetry={onRetry}
        listErrorTitle="Unable to load skills"
      >
        <div />
      </SplitPaneLayout>,
    );

    expect(screen.getByText('Pizza skill')).toBeTruthy();
    expect(screen.queryByText('Unable to load skills')).toBeNull();
    expect(screen.queryByText('skills read failed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  test('names the failure after the collection when no title is supplied', () => {
    render(
      <SplitPaneLayout
        label="skills"
        title="Skills"
        items={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onSearch={vi.fn()}
        error={new Error('boom')}
      >
        <div />
      </SplitPaneLayout>,
    );

    expect(screen.getByText('Unable to load skills')).toBeTruthy();
  });

  // The wait is the more specific fact while it holds: a first read in flight
  // has not failed yet, and blanking to an error would be its own false claim.
  test('the loading skeleton outranks the failure branch', () => {
    render(
      <SplitPaneLayout
        label="skills"
        title="Installed Skills"
        items={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onSearch={vi.fn()}
        loading
        error={new Error('skills read failed')}
      >
        <div />
      </SplitPaneLayout>,
    );

    expect(screen.getByLabelText('Loading list')).toBeTruthy();
    expect(screen.queryByText('Unable to load skills')).toBeNull();
  });

  test('distinguishes a filtered-empty list and clears its controlled search', () => {
    const onSearch = vi.fn();
    render(
      <SplitPaneLayout
        label="sessions"
        title="Sessions"
        items={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onSearch={onSearch}
        searchValue="build"
        listEmptyTitle="Sessions have not started yet"
        listFilteredEmptyNoun="sessions"
      >
        <div>detail pane</div>
      </SplitPaneLayout>,
    );

    expect(screen.queryByText('Sessions have not started yet')).toBeNull();
    expect(
      screen.getByText('Nothing in sessions matches “build”'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(onSearch).toHaveBeenCalledWith('');
  });

  // archive#4463: a typed query
  // over a collection that is ALREADY empty is not what emptied it — without
  // `collectionEmpty`, this misattributed the emptiness to the search
  // ("Nothing in X matches your search") and offered a "Clear filter" action
  // that fixes nothing, because nothing exists regardless of the query.
  describe('collectionEmpty', () => {
    test('a genuinely-empty collection shows the plain empty state even with a typed query', () => {
      const onSearch = vi.fn();
      render(
        <SplitPaneLayout
          label="sessions"
          title="Sessions"
          items={[]}
          selectedId={null}
          onSelect={vi.fn()}
          onSearch={onSearch}
          searchValue="build"
          listEmptyTitle="Sessions have not started yet"
          listFilteredEmptyNoun="sessions"
          collectionEmpty
        >
          <div>detail pane</div>
        </SplitPaneLayout>,
      );

      expect(screen.getByText('Sessions have not started yet')).toBeTruthy();
      expect(
        screen.queryByText('Nothing in sessions matches “build”'),
      ).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
    });

    test('a query that filters a NON-empty collection to nothing still shows FilteredEmpty', () => {
      render(
        <SplitPaneLayout
          label="sessions"
          title="Sessions"
          items={[]}
          selectedId={null}
          onSelect={vi.fn()}
          onSearch={vi.fn()}
          searchValue="build"
          listEmptyTitle="Sessions have not started yet"
          listFilteredEmptyNoun="sessions"
          collectionEmpty={false}
        >
          <div>detail pane</div>
        </SplitPaneLayout>,
      );

      expect(
        screen.getByText('Nothing in sessions matches “build”'),
      ).toBeTruthy();
      expect(screen.queryByText('Sessions have not started yet')).toBeNull();
    });

    test('defaults to false: unset callers keep exactly their current FilteredEmpty behavior', () => {
      render(
        <SplitPaneLayout
          label="sessions"
          title="Sessions"
          items={[]}
          selectedId={null}
          onSelect={vi.fn()}
          onSearch={vi.fn()}
          searchValue="build"
          listFilteredEmptyNoun="sessions"
        >
          <div>detail pane</div>
        </SplitPaneLayout>,
      );

      expect(
        screen.getByText('Nothing in sessions matches “build”'),
      ).toBeTruthy();
    });
  });

  test('keeps optional list guidance in the mobile-first list pane', () => {
    isMobileMock.mockReturnValue(true);
    const { container } = render(
      <SplitPaneLayout
        label="sessions"
        title="Sessions"
        items={[{ id: 'a', name: 'Alpha' }]}
        selectedId={null}
        onSelect={vi.fn()}
        onSearch={vi.fn()}
        listIntro={<div>Coordinate delegated work</div>}
      >
        <div>detail pane</div>
      </SplitPaneLayout>,
    );

    expect(screen.getByText('Coordinate delegated work')).toBeTruthy();
    expect(container.querySelector('.split-pane__left--visible')).toBeTruthy();
  });

  test('routes mobile list-intro selection through detail-sheet focus management', () => {
    isMobileMock.mockReturnValue(true);

    function IntroSelectionFixture() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return (
        <SplitPaneLayout
          label="sessions"
          title="Sessions"
          items={[{ id: 'a', name: 'Alpha' }]}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDeselect={() => setSelectedId(null)}
          onSearch={vi.fn()}
          listIntro={(selectItem) => (
            <button type="button" onClick={() => selectItem('a')}>
              Open active task
            </button>
          )}
        >
          <div>Task detail</div>
        </SplitPaneLayout>
      );
    }

    render(<IntroSelectionFixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Open active task' }));

    expect(screen.getByText('Task detail')).toBeTruthy();
    expect(screen.getByText('← Back to list')).toBe(document.activeElement);
  });

  function renderWithSelection() {
    return render(
      <SplitPaneLayout
        label="skills"
        paneId="skills"
        title="Skills"
        items={[{ id: 'a', name: 'Alpha' }]}
        selectedId="a"
        onSelect={vi.fn()}
        onDeselect={vi.fn()}
        onSearch={vi.fn()}
      >
        <div>detail pane</div>
      </SplitPaneLayout>,
    );
  }

  // The clickable title was reachable by mouse only: no role, no tab stop, no
  // key handler. These assert the `activatable` wiring end-to-end in a real
  // component, which the primitive's own unit tests cannot.
  test('a clearable title is a keyboard-operable control', () => {
    const onDeselect = vi.fn();
    render(
      <SplitPaneLayout
        label="skills"
        paneId="skills"
        title="Skills"
        items={[{ id: 'a', name: 'Alpha' }]}
        selectedId="a"
        onSelect={vi.fn()}
        onDeselect={onDeselect}
        onSearch={vi.fn()}
      >
        <div>detail pane</div>
      </SplitPaneLayout>,
    );

    const title = screen.getByRole('button', { name: 'Skills' });
    expect(title.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(title, { key: 'Enter' });
    expect(onDeselect).toHaveBeenCalledTimes(1);

    // Space follows native button timing: suppressed on keydown (no page
    // scroll), activated on keyup — so a held key cannot auto-repeat.
    fireEvent.keyDown(title, { key: ' ' });
    expect(onDeselect).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(title, { key: ' ' });
    expect(onDeselect).toHaveBeenCalledTimes(2);

    // Keys that mean something else must pass straight through.
    fireEvent.keyDown(title, { key: 'Tab' });
    expect(onDeselect).toHaveBeenCalledTimes(2);
  });

  test('a title with nothing to clear is not a control at all', () => {
    // No selection to deselect: a tab stop here would promise an action the
    // element does not perform.
    render(
      <SplitPaneLayout
        label="skills"
        paneId="skills"
        title="Skills"
        items={[{ id: 'a', name: 'Alpha' }]}
        selectedId={null}
        onSelect={vi.fn()}
        onSearch={vi.fn()}
      >
        <div>detail pane</div>
      </SplitPaneLayout>,
    );

    expect(screen.queryByRole('button', { name: 'Skills' })).toBeNull();
    expect(screen.getByText('Skills').getAttribute('tabindex')).toBeNull();
  });

  test('desktop keeps both panes visible with no back affordance', () => {
    isMobileMock.mockReturnValue(false);
    const { container } = renderWithSelection();

    // Both list (left) and detail (right) panes render their --visible modifier
    // on desktop, so panes sit side-by-side rather than stacking.
    expect(container.querySelector('.split-pane__left--visible')).toBeTruthy();
    expect(container.querySelector('.split-pane__right--visible')).toBeTruthy();
    expect(screen.queryByText('← Back to list')).toBeNull();
  });

  test('mobile collapses to a single column with a back affordance', () => {
    isMobileMock.mockReturnValue(true);
    const { container } = renderWithSelection();

    // With a selection on mobile, only the detail pane is visible (single
    // column) and the list pane is hidden behind a back affordance.
    expect(container.querySelector('.split-pane__left--visible')).toBeNull();
    expect(container.querySelector('.split-pane__right--visible')).toBeTruthy();
    expect(container.querySelector('.split-pane__right--sheet')).toBeTruthy();
    expect(screen.getByText('← Back to list')).toBeTruthy();
  });

  test('renders layout-shaped skeletons while loading without a selection', () => {
    const { container } = render(
      <SplitPaneLayout
        label="skills"
        paneId="skills"
        title="Skills"
        items={[]}
        selectedId={null}
        loading
        onSelect={vi.fn()}
        onSearch={vi.fn()}
      >
        <div>detail pane</div>
      </SplitPaneLayout>,
    );

    expect(screen.getByLabelText('Loading list')).toBeTruthy();
    expect(screen.getByLabelText('Loading detail')).toBeTruthy();
    // archive#4463: the list wait is the shared `SkeletonList` row
    // shape (icon + two lines), not a bespoke local skeleton.
    expect(container.querySelectorAll('.skeleton-list__item')).toHaveLength(7);
    expect(
      container.querySelectorAll(
        '.split-pane__detail-skeleton-blocks .skeleton--block',
      ),
    ).toHaveLength(3);

    // Count/nesting alone did not catch the rhythm actually
    // drifting when the local skeletons were collapsed onto the shared
    // primitives — the shared circle defaults to 28px, visibly taller than
    // what this replaced. The icon size is a directly-binding CSS property
    // (a fixed width/height has no competing natural-size claim), so a text
    // assertion against the shipped CSS is trustworthy for it; ROW HEIGHT is
    // not (see SplitPaneLayout.skeleton-geometry.test.tsx: min-height alone
    // could not be trusted this way — the row's own content already
    // exceeded it, so the min-height text this test used to assert never
    // bound in the rendered page. That property is now proven with a real
    // Chromium measurement instead of grepped CSS text.
    expect(cssRuleFrom(skeletonCss, '.skeleton-list__icon')).toContain(
      'width: 24px;',
    );
    expect(cssRuleFrom(skeletonCss, '.skeleton-list__icon')).toContain(
      'height: 24px;',
    );
    expect(
      cssRuleFrom(
        splitPaneCss,
        '.split-pane__detail-skeleton-blocks .skeleton--block',
      ),
    ).toContain('height: 5rem;');
  });

  test('renders the detail skeleton for a loading deep link with a selected id', () => {
    render(
      <SplitPaneLayout
        label="skills"
        paneId="skills"
        title="Skills"
        items={[]}
        selectedId="deep-linked-skill"
        loading
        onSelect={vi.fn()}
        onSearch={vi.fn()}
      >
        <div>stale detail pane</div>
      </SplitPaneLayout>,
    );

    expect(screen.getByLabelText('Loading detail')).toBeTruthy();
    expect(screen.queryByText('stale detail pane')).toBeNull();
  });

  test('desktop collapse hides the list pane and persists skeleton state', () => {
    const { container } = renderWithSelection();

    fireEvent.click(screen.getByLabelText('Hide list pane'));

    expect(container.querySelector('.split-pane--collapsed')).toBeTruthy();
    expect(container.querySelector('.split-pane__left--visible')).toBeNull();
    expect(window.localStorage.getItem('station:split-pane:skills')).toContain(
      '"collapsed":true',
    );

    fireEvent.click(screen.getByLabelText('Show list pane'));
    expect(container.querySelector('.split-pane--collapsed')).toBeNull();
  });

  test('desktop collapse and expand transfer focus between their controls', () => {
    renderWithSelection();

    const collapse = screen.getByRole('button', { name: 'Hide list pane' });
    collapse.focus();
    fireEvent.click(collapse);

    const reopen = screen.getByRole('button', { name: 'Show list pane' });
    expect(document.activeElement).toBe(reopen);

    fireEvent.click(reopen);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Hide list pane' }),
    );
  });

  test('mobile sheet open and dismiss transfer focus and restore the selected item', async () => {
    isMobileMock.mockReturnValue(true);

    function MobileHarness() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return (
        <SplitPaneLayout
          label="skills"
          paneId="skills"
          title="Skills"
          items={[{ id: 'a', name: 'Alpha' }]}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDeselect={() => setSelectedId(null)}
          onSearch={vi.fn()}
        >
          <div>detail pane</div>
        </SplitPaneLayout>
      );
    }

    render(<MobileHarness />);
    const item = screen.getByRole('button', { name: 'Alpha' });
    item.focus();
    fireEvent.click(item);

    const dismiss = screen.getByRole('button', { name: '← Back to list' });
    expect(document.activeElement).toBe(dismiss);

    fireEvent.click(dismiss);
    await waitFor(() => expect(document.activeElement).toBe(item));
  });

  test('route-driven mobile closes restore their opener once and do not carry it into a direct open', async () => {
    isMobileMock.mockReturnValue(true);

    function AddModelButton({ onOpen }: { onOpen: () => void }) {
      const returnFocus = useSplitPaneExternalReturnFocus();
      return (
        <button
          type="button"
          onClick={(event) => {
            returnFocus?.captureExternalReturnFocus(event.currentTarget);
            onOpen();
          }}
        >
          + Add model
        </button>
      );
    }
    function RoutedCloseHarness() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return (
        <SplitPaneReturnFocusProvider>
          <AddModelButton onOpen={() => setSelectedId('new')} />
          <button type="button" onClick={() => setSelectedId('direct')}>
            Open direct detail
          </button>
          <button type="button" onClick={() => setSelectedId(null)}>
            Close route
          </button>
          <SplitPaneLayout
            label="models"
            title="Models"
            items={[{ id: 'ollama', name: 'Ollama' }]}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDeselect={() => setSelectedId(null)}
            onSearch={vi.fn()}
          >
            <div>Model detail</div>
          </SplitPaneLayout>
        </SplitPaneReturnFocusProvider>
      );
    }

    render(<RoutedCloseHarness />);
    const row = screen.getByRole('button', { name: 'Ollama' });
    const closeRoute = screen.getByRole('button', { name: 'Close route' });
    row.focus();
    fireEvent.click(row);
    expect(screen.getByRole('button', { name: '← Back to list' })).toBe(
      document.activeElement,
    );
    fireEvent.click(closeRoute);
    await waitFor(() => expect(document.activeElement).toBe(row));

    const add = screen.getByRole('button', { name: '+ Add model' });
    add.focus();
    fireEvent.click(add);
    fireEvent.click(closeRoute);
    await waitFor(() => expect(document.activeElement).toBe(add));

    fireEvent.click(screen.getByRole('button', { name: 'Open direct detail' }));
    fireEvent.click(closeRoute);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector('.split-pane__list'),
      ),
    );
  });

  test('a mobile breakpoint transition preserves, rather than returns or clears, an open sheet chain', async () => {
    isMobileMock.mockReturnValue(true);
    function BreakpointHarness() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return (
        <>
          <button type="button" onClick={() => setSelectedId(null)}>
            Close route
          </button>
          <SplitPaneLayout
            label="models"
            title="Models"
            items={[{ id: 'ollama', name: 'Ollama' }]}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDeselect={() => setSelectedId(null)}
            onSearch={vi.fn()}
          >
            <div>Model detail</div>
          </SplitPaneLayout>
        </>
      );
    }

    const { rerender } = render(<BreakpointHarness />);
    const row = screen.getByRole('button', { name: 'Ollama' });
    row.focus();
    fireEvent.click(row);

    isMobileMock.mockReturnValue(false);
    rerender(<BreakpointHarness />);
    expect(document.activeElement).not.toBe(row);

    // Returning to mobile and then closing the route must still use the
    // original row chain. If the desktop transition consumed it, this lands on
    // the list fallback instead.
    isMobileMock.mockReturnValue(true);
    rerender(<BreakpointHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Close route' }));
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  test('closing the preserved detail on desktop abandons its chain before a later mobile direct open', async () => {
    isMobileMock.mockReturnValue(true);
    function BreakpointCloseHarness() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return (
        <>
          <button type="button" onClick={() => setSelectedId('direct')}>
            Open direct detail
          </button>
          <button type="button" onClick={() => setSelectedId(null)}>
            Close route
          </button>
          <SplitPaneLayout
            label="models"
            title="Models"
            items={[{ id: 'ollama', name: 'Ollama' }]}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDeselect={() => setSelectedId(null)}
            onSearch={vi.fn()}
          >
            <div>Model detail</div>
          </SplitPaneLayout>
        </>
      );
    }

    const { rerender } = render(<BreakpointCloseHarness />);
    const row = screen.getByRole('button', { name: 'Ollama' });
    row.focus();
    fireEvent.click(row);

    isMobileMock.mockReturnValue(false);
    rerender(<BreakpointCloseHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Close route' }));

    isMobileMock.mockReturnValue(true);
    rerender(<BreakpointCloseHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open direct detail' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close route' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector('.split-pane__list'),
      ),
    );
  });

  test('unmounting a routed mobile detail abandons its scheduled return', async () => {
    isMobileMock.mockReturnValue(true);
    function AddModelButton({ onOpen }: { onOpen: () => void }) {
      const returnFocus = useSplitPaneExternalReturnFocus();
      return (
        <button
          type="button"
          onClick={(event) => {
            returnFocus?.captureExternalReturnFocus(event.currentTarget);
            onOpen();
          }}
        >
          + Add model
        </button>
      );
    }
    function SectionHarness() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const [showModels, setShowModels] = useState(true);
      return (
        <SplitPaneReturnFocusProvider>
          <AddModelButton onOpen={() => setSelectedId('new')} />
          <button type="button" onClick={() => setSelectedId(null)}>
            Close route
          </button>
          <button type="button" onClick={() => setShowModels(false)}>
            Leave models
          </button>
          {showModels && (
            <SplitPaneLayout
              label="models"
              title="Models"
              items={[]}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onDeselect={() => setSelectedId(null)}
              onSearch={vi.fn()}
            >
              <div>Model detail</div>
            </SplitPaneLayout>
          )}
        </SplitPaneReturnFocusProvider>
      );
    }

    render(<SectionHarness />);
    const add = screen.getByRole('button', { name: '+ Add model' });
    add.focus();
    fireEvent.click(add);
    fireEvent.click(screen.getByRole('button', { name: 'Close route' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave models' }));

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(document.activeElement).not.toBe(add);
  });

  test('a framed mobile sheet portals once outside the page frame and focuses Back', () => {
    isMobileMock.mockReturnValue(true);

    function FramedHarness() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return (
        <PageFrame spec={{ title: 'Models' }} routeIdentity="models-new">
          <SplitPaneLayout
            label="models"
            title="Models"
            items={[{ id: 'ollama', name: 'Ollama' }]}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDeselect={() => setSelectedId(null)}
            onSearch={vi.fn()}
          >
            <div>Ollama detail</div>
          </SplitPaneLayout>
        </PageFrame>
      );
    }

    const { container } = render(<FramedHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Ollama' }));

    const back = screen.getByRole('button', { name: '← Back to list' });
    const frame = container.querySelector('.page-frame');
    const slot = container.querySelector('.page-frame__mobile-detail-slot');
    expect(document.activeElement).toBe(back);
    expect(slot?.contains(back)).toBe(true);
    expect(frame?.contains(back)).toBe(false);
    expect(frame?.hasAttribute('inert')).toBe(true);
    expect(
      container.querySelectorAll(
        '.page-frame__mobile-detail-slot .split-pane__right',
      ),
    ).toHaveLength(1);
    expect(slot?.querySelector('.split-pane__right--portaled')).toBeTruthy();
    expect(
      container.querySelector('.split-pane > .split-pane__right'),
    ).toBeNull();
  });

  test('a directly opened framed mobile sheet portals once and focuses Back', () => {
    isMobileMock.mockReturnValue(true);
    const { container } = render(
      <PageFrame spec={{ title: 'Models' }} routeIdentity="models-ollama">
        <SplitPaneLayout
          label="models"
          title="Models"
          items={[{ id: 'ollama', name: 'Ollama' }]}
          selectedId="ollama"
          onSelect={vi.fn()}
          onDeselect={vi.fn()}
          onSearch={vi.fn()}
        >
          <div>Ollama detail</div>
        </SplitPaneLayout>
      </PageFrame>,
    );

    const back = screen.getByRole('button', { name: '← Back to list' });
    const frame = container.querySelector('.page-frame');
    const slot = container.querySelector('.page-frame__mobile-detail-slot');
    expect(document.activeElement).toBe(back);
    expect(slot?.contains(back)).toBe(true);
    expect(frame?.contains(back)).toBe(false);
    expect(frame?.hasAttribute('inert')).toBe(true);
    expect(
      container.querySelectorAll(
        '.page-frame__mobile-detail-slot .split-pane__right--portaled',
      ),
    ).toHaveLength(1);
    expect(
      container.querySelector('.split-pane > .split-pane__right'),
    ).toBeNull();
  });

  test('an unframed mobile sheet stays inline', () => {
    isMobileMock.mockReturnValue(true);
    const { container } = renderWithSelection();

    expect(
      container.querySelector('.page-frame__mobile-detail-slot'),
    ).toBeNull();
    expect(
      container.querySelector(
        '.split-pane__detail-inline-host > .split-pane__right',
      ),
    ).toBeTruthy();
    expect(container.querySelector('.split-pane__right--portaled')).toBeNull();
  });

  test('keeps one stateful detail subtree and root while moving desktop → mobile → desktop', () => {
    let mounts = 0;
    let unmounts = 0;
    function StatefulDetail() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounts += 1;
        return () => {
          unmounts += 1;
        };
      }, []);
      return (
        <>
          <button type="button" onClick={() => setCount((value) => value + 1)}>
            Count {count}
          </button>
          <input aria-label="Detail draft" defaultValue="preserved" />
        </>
      );
    }
    function Host() {
      return (
        <PageFrame spec={{ title: 'Models' }} routeIdentity="models">
          <SplitPaneLayout
            label="models"
            title="Models"
            items={[{ id: 'ollama', name: 'Ollama' }]}
            selectedId="ollama"
            onSelect={vi.fn()}
            onDeselect={vi.fn()}
            onSearch={vi.fn()}
          >
            <StatefulDetail />
          </SplitPaneLayout>
        </PageFrame>
      );
    }

    const { container, rerender } = render(<Host />);
    const desktopRoot = container.querySelector('.split-pane__right');
    // Hydration's inline bootstrap deliberately gives way to the stable portal
    // root once. Movement after that must not create another detail subtree.
    const mountsBeforeMovement = mounts;
    const unmountsBeforeMovement = unmounts;
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Detail draft' }), {
      target: { value: 'changed draft' },
    });

    isMobileMock.mockReturnValue(true);
    rerender(<Host />);
    const slot = container.querySelector('.page-frame__mobile-detail-slot');
    const mobileRoot = slot?.querySelector('.split-pane__right');
    expect(mobileRoot).toBe(desktopRoot);
    expect(screen.getByRole('button', { name: 'Count 1' })).toBeTruthy();
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Detail draft',
        }) as HTMLInputElement
      ).value,
    ).toBe('changed draft');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '← Back to list' }),
    );
    expect(container.querySelector('.page-frame')?.hasAttribute('inert')).toBe(
      true,
    );

    isMobileMock.mockReturnValue(false);
    rerender(<Host />);
    expect(container.querySelector('.split-pane__right')).toBe(desktopRoot);
    expect(screen.getByRole('button', { name: 'Count 1' })).toBeTruthy();
    expect(mounts).toBe(mountsBeforeMovement);
    expect(unmounts).toBe(unmountsBeforeMovement);
  });

  test('StrictMode creates one reusable portal root with no detached orphan', () => {
    isMobileMock.mockReturnValue(true);
    const { container, unmount } = render(
      <StrictMode>
        <PageFrame spec={{ title: 'Models' }} routeIdentity="models">
          <SplitPaneLayout
            label="models"
            title="Models"
            items={[{ id: 'ollama', name: 'Ollama' }]}
            selectedId="ollama"
            onSelect={vi.fn()}
            onDeselect={vi.fn()}
            onSearch={vi.fn()}
          >
            <div>Ollama detail</div>
          </SplitPaneLayout>
        </PageFrame>
      </StrictMode>,
    );
    expect(container.querySelectorAll('.split-pane__right')).toHaveLength(1);
    unmount();
    expect(document.querySelectorAll('.split-pane__right')).toHaveLength(0);
  });

  /**
   * archive#1259. The row this restores to is a list item, and the detail pane
   * the sheet opened is free to delete it — a bare ref to the button was then a
   * detached node, and `.focus` on one is a silent no-op that leaves `<body>`
   * focused (archive#1126). The test above is the surviving-row control; this
   * is the case that had no restore at all.
   *
   * jsdom is the right level for this half: it is about a node leaving the
   * document and the walk continuing to the ancestor it occupied, both of which
   * jsdom models. The half jsdom cannot see — a surviving ancestor that is
   * present but refuses focus — belongs to the shared module and is proven in
   * Chromium by `tests/dialog-return-focus.spec.ts`.
   */
  test('mobile dismiss falls back to the list when the detail pane deleted the row', async () => {
    isMobileMock.mockReturnValue(true);

    function DeletingHarness() {
      const [items, setItems] = useState([
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
      ]);
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return (
        <SplitPaneLayout
          label="skills"
          paneId="skills-deleting"
          title="Skills"
          items={items}
          selectedId={selectedId}
          onSelect={setSelectedId}
          // The real shape: the detail pane deletes the record it is showing
          // and the sheet closes in the same commit.
          onDeselect={() => {
            setItems((current) => current.filter((item) => item.id !== 'a'));
            setSelectedId(null);
          }}
          onSearch={vi.fn()}
        >
          <div>detail pane</div>
        </SplitPaneLayout>
      );
    }

    const { container } = render(<DeletingHarness />);
    const item = screen.getByRole('button', { name: 'Alpha' });
    item.focus();
    fireEvent.click(item);

    const dismiss = screen.getByRole('button', { name: '← Back to list' });
    expect(document.activeElement).toBe(dismiss);

    fireEvent.click(dismiss);
    expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull();
    expect(item.isConnected).toBe(false);

    const list = container.querySelector('.split-pane__list');
    expect(list).not.toBeNull();
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(list);
    });
  });

  test('mobile Add sheet transfers focus and restores the Add button', async () => {
    isMobileMock.mockReturnValue(true);

    function MobileAddHarness() {
      const [adding, setAdding] = useState(false);
      return (
        <SplitPaneLayout
          label="connections"
          title="Engines"
          items={[]}
          selectedId={null}
          onSelect={vi.fn()}
          onDeselect={() => setAdding(false)}
          onSearch={vi.fn()}
          onAdd={() => setAdding(true)}
          addLabel="+ Add engine"
          emptyContent={<div>Add catalog</div>}
          unselectedDetailOpen={adding}
        >
          <div>detail pane</div>
        </SplitPaneLayout>
      );
    }

    render(<MobileAddHarness />);
    const add = screen.getByRole('button', { name: '+ Add engine' });
    add.focus();
    fireEvent.click(add);

    const dismiss = screen.getByRole('button', { name: '← Back to list' });
    expect(document.activeElement).toBe(dismiss);

    fireEvent.click(dismiss);
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  test('consumes the Connections frame Add return chain once when a routed detail opens', async () => {
    isMobileMock.mockReturnValue(true);
    function AddButton({ onOpen }: { onOpen: () => void }) {
      const returnFocus = useSplitPaneExternalReturnFocus();
      return (
        <button
          type="button"
          onClick={(event) => {
            returnFocus?.captureExternalReturnFocus(event.currentTarget);
            onOpen();
          }}
        >
          + Add model
        </button>
      );
    }
    function Harness() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return (
        <SplitPaneReturnFocusProvider>
          <AddButton onOpen={() => setSelectedId('new')} />
          <button type="button" onClick={() => setSelectedId('direct')}>
            Direct detail
          </button>
          <SplitPaneLayout
            label="models"
            title="Models"
            items={[]}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDeselect={() => setSelectedId(null)}
            onSearch={vi.fn()}
          >
            <div>New model</div>
          </SplitPaneLayout>
        </SplitPaneReturnFocusProvider>
      );
    }

    render(<Harness />);
    const add = screen.getByRole('button', { name: '+ Add model' });
    add.focus();
    fireEvent.click(add);
    fireEvent.click(screen.getByRole('button', { name: '← Back to list' }));
    await waitFor(() => expect(document.activeElement).toBe(add));

    // The chain is consumed on its first open; a direct subsequent selection
    // has no stale Add intent to resurrect and lands on the focusable list.
    fireEvent.click(screen.getByRole('button', { name: 'Direct detail' }));
    fireEvent.click(screen.getByRole('button', { name: '← Back to list' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector('.split-pane__list'),
      ),
    );
  });

  test('desktop divider is keyboard-operable and exposes separator values', () => {
    renderWithSelection();

    const divider = screen.getByRole('separator', {
      name: 'Resize list pane',
    });
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    expect(divider.getAttribute('aria-valuemin')).toBe('220');
    expect(divider.getAttribute('aria-valuemax')).toBe('420');
    expect(divider.getAttribute('aria-valuenow')).toBe('280');

    fireEvent.keyDown(divider, { key: 'ArrowRight' });

    expect(divider.getAttribute('aria-valuenow')).toBe('296');
    expect(window.localStorage.getItem('station:split-pane:skills')).toContain(
      '"width":296',
    );

    fireEvent.keyDown(divider, { key: 'Home' });
    expect(divider.getAttribute('aria-valuenow')).toBe('220');
  });

  test('desktop divider removes pointer listeners on pointer cancel', () => {
    renderWithSelection();
    const divider = screen.getByRole('separator', {
      name: 'Resize list pane',
    });
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    Object.assign(divider, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 280 });
    fireEvent.pointerCancel(window, { pointerId: 1 });

    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith(
      'pointercancel',
      expect.any(Function),
    );
    expect(
      (divider as HTMLButtonElement & { releasePointerCapture: () => void })
        .releasePointerCapture,
    ).toHaveBeenCalled();
    removeSpy.mockRestore();
  });

  test('desktop resize ignores move, end, and cancel events from other pointers', () => {
    renderWithSelection();
    const divider = screen.getByRole('separator', {
      name: 'Resize list pane',
    });
    Object.assign(divider, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 280 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 400 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    fireEvent.pointerCancel(window, { pointerId: 2 });
    expect(divider.getAttribute('aria-valuenow')).toBe('280');

    fireEvent.pointerMove(window, { pointerId: 1, clientX: 330 });
    expect(divider.getAttribute('aria-valuenow')).toBe('330');

    fireEvent.pointerCancel(window, { pointerId: 1 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 360 });
    expect(divider.getAttribute('aria-valuenow')).toBe('330');
  });

  test('desktop divider removes live pointer listeners on unmount', () => {
    const { unmount } = renderWithSelection();
    const divider = screen.getByRole('separator', {
      name: 'Resize list pane',
    });
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    Object.assign(divider, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 280 });
    unmount();

    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith(
      'pointercancel',
      expect.any(Function),
    );
    expect(
      (divider as HTMLButtonElement & { releasePointerCapture: () => void })
        .releasePointerCapture,
    ).toHaveBeenCalled();
    removeSpy.mockRestore();
  });

  // SHELL-11: eight routes had no page header because this layout drew its own
  // 14.7px panel title instead. Framed, the collection's identity goes UP into
  // the page header and the pane keeps only its search and its list.
  describe('inside a page frame', () => {
    function renderFramed(props: Record<string, unknown> = {}) {
      return render(
        <PageFrame
          spec={{ width: 'full', body: 'fill', flush: true }}
          routeIdentity="connections-providers"
        >
          <SplitPaneLayout
            label="connections / providers"
            paneId="framed"
            title="Providers"
            subtitle="Connect model services for chats and agents"
            items={[]}
            selectedId={null}
            onSelect={vi.fn()}
            onSearch={vi.fn()}
            searchPlaceholder="Search providers..."
            {...props}
          >
            <div>detail pane</div>
          </SplitPaneLayout>
        </PageFrame>,
      );
    }

    test('publishes its title, subtitle and trail into the page header', () => {
      const { container } = renderFramed();

      const header = container.querySelector('.page-frame__header');
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading.textContent).toBe('Providers');
      expect(header?.contains(heading)).toBe(true);
      expect(header?.textContent).toContain(
        'Connect model services for chats and agents',
      );
      // The trail minus its own name — archive#4463 (the
      //) retired the page header's old self-referential eyebrow
      // shape (`SCHEDULE` above **Schedule**); only the real ancestor
      // ('connections') remains, and the current page's own segment
      // ('providers', which restates the page's h1) is dropped.
      expect(container.querySelector('.page__label')?.textContent).toBe(
        'connections',
      );
    });

    test('renders no eyebrow at all for a top-level route (label restates the title)', () => {
      const { container } = renderFramed({
        label: 'agents',
        title: 'Agents',
      });

      expect(container.querySelector('.page__label')).toBeNull();
      expect(
        screen.getByRole('heading', { level: 1, name: 'Agents' }),
      ).toBeTruthy();
    });

    // archive#4463: `framedBreadcrumbSegments` only drops a
    // trailing segment that RESTATES the title. When it does not (a real
    // multi-level trail — an entity slug ahead of an editor tab, say), the
    // last segment is KEPT — and a kept terminal crumb must never auto-link
    // to a fabricated `/<segment>` route; only earlier, real ancestor
    // segments do. Probes on the first unsuppression of the framed dedup
    // found live `/edit`/`/detail`/`/tools` links exactly from this gap.
    test('a kept terminal crumb (the trail does not restate the title) is inert text, not a fabricated link', () => {
      const { container } = renderFramed({
        label: 'Agents / my-agent',
        title: 'Tools',
      });

      const eyebrow = container.querySelector('.page__label');
      expect(eyebrow?.textContent).toBe('Agents / my-agent');

      // The real ancestor ('Agents') still auto-links.
      const links = eyebrow?.querySelectorAll('.split-pane__label-link');
      expect(Array.from(links ?? []).map((el) => el.textContent)).toEqual([
        'Agents',
      ]);

      // The kept terminal crumb ('my-agent') is plain text, not a link.
      const myAgentSpan = Array.from(eyebrow?.children ?? []).find(
        (el) => el.textContent === 'my-agent',
      );
      expect(myAgentSpan?.className ?? '').not.toContain(
        'split-pane__label-link',
      );
    });

    test('renders no heading of its own, and keeps the search and list', () => {
      const { container } = renderFramed();

      expect(container.querySelector('.split-pane__title')).toBeNull();
      expect(container.querySelector('.split-pane__heading')).toBeNull();
      expect(
        container.querySelector('.page-frame__body h1, .page-frame__body h2'),
      ).toBeNull();
      expect(screen.getByPlaceholderText('Search providers...')).toBeTruthy();
      // The collapse control moves next to the search rather than vanishing
      // with the heading block it used to live in.
      expect(screen.getByLabelText('Hide list pane')).toBeTruthy();
    });

    test('puts the primary and secondary actions in the header action cell', () => {
      const onAdd = vi.fn();
      const { container } = renderFramed({
        onAdd,
        addLabel: '+ Add provider',
        headerActions: (
          <button type="button" className="page__btn-secondary">
            Browse Registry
          </button>
        ),
        sidebarActions: <div className="delegated-card">list chrome</div>,
      });

      const actions = container.querySelector('.page__actions');
      expect(actions?.textContent).toContain('Browse Registry');
      expect(actions?.textContent).toContain('+ Add provider');
      // The shared Button, not a third button family: `page__btn-primary`
      // was retired with the rest of it.
      expect(actions?.querySelector('.button')?.textContent).toBe(
        '+ Add provider',
      );
      fireEvent.click(screen.getByText('+ Add provider'));
      expect(onAdd).toHaveBeenCalledTimes(1);

      // List chrome is NOT a page action and stays in the list footer.
      const footer = container.querySelector('.split-pane__add');
      expect(footer?.textContent).toBe('list chrome');
    });

    test('unframed, it still draws its own heading and footer add button', () => {
      const { container } = render(
        <SplitPaneLayout
          label="connections / providers"
          paneId="unframed"
          title="Providers"
          items={[]}
          selectedId={null}
          onSelect={vi.fn()}
          onSearch={vi.fn()}
          onAdd={vi.fn()}
          addLabel="+ Add provider"
        >
          <div>detail pane</div>
        </SplitPaneLayout>,
      );

      expect(container.querySelector('.split-pane__title')?.textContent).toBe(
        'Providers',
      );
      expect(
        container.querySelector('.split-pane__add .split-pane__add-btn')
          ?.textContent,
      ).toBe('+ Add provider');
    });
  });
});

/**
 * a row with `trailing` content (Agents' Chat/Connect
 * button, Sessions' project-filter pill) ellipsized names like "Claude Code"
 * and "Station" at the pane's generous default width (280px,
 * `SPLIT_PANE_DEFAULT_WIDTH`). `.split-pane__item`'s own right padding is
 * meant for a STANDALONE row, whose right edge is the pane's own edge — but
 * inside `.split-pane__item-row` that edge is already the row's own
 * gap + padding-right before the trailing action, so the item's copy of
 * that padding doubled the reserved space between the name and the button
 * and starved the name column before the pane ran out of width. jsdom does
 * not apply stylesheets or compute layout, so this pins the fix in the CSS
 * source: the standalone-row padding is not duplicated for a trailing row,
 * and the row's own edge spacing did not silently grow back to compensate.
 */
describe('split-pane row column sizing (station audit F6)', () => {
  const itemInRow = cssRule('.split-pane__item-row .split-pane__item');
  const row = cssRule('.split-pane__item-row');

  test('the item does not duplicate the standalone row’s right padding when it shares a trailing row', () => {
    expect(itemInRow).toMatch(/padding-right:\s*0\s*;/);
  });

  test('the trailing row’s own edge spacing stays tight rather than growing back to reclaim the freed space', () => {
    const gap = row.match(/gap:\s*([^;]+);/)?.[1]?.trim();
    const paddingRight = row.match(/padding-right:\s*([^;]+);/)?.[1]?.trim();
    expect(gap).toBe('0.2rem');
    expect(paddingRight).toBe('0.2rem');
  });
});
