/**
 * @vitest-environment jsdom
 *
 * The shared TRUE-tab primitive (archive#4463). Covers the review's
 * fix-round contract: real `role="tablist"`/`role="tab"`/`aria-selected`,
 * generated `aria-controls`/id pairing for a host's `role="tabpanel"`,
 * automatic-vs-manual activation (WAI-ARIA APG), an optional count badge,
 * an attention indicator composed into the tab's own accessible name (not a
 * nested `role="status"` a real AT would prune), and — the guard against
 * the audit's named bug (a group label sharing the tab row) — a tablist
 * whose DOM children are never anything but tabs, because `Tabs` has no
 * `children` slot for a host to smuggle one in through.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { Tabs, tabElementId, tabPanelElementId } from '../components/Tabs';

const ITEMS = [
  { key: 'a', label: 'Alpha' },
  { key: 'b', label: 'Bravo' },
  { key: 'c', label: 'Charlie' },
];

describe('Tabs', () => {
  test('renders a tablist with one tab per item, aria-selected reflecting activeKey', () => {
    render(
      <Tabs
        id="t"
        activation="automatic"
        aria-label="Test tabs"
        items={ITEMS}
        activeKey="b"
        onSelect={vi.fn()}
      />,
    );
    const tablist = screen.getByRole('tablist', { name: 'Test tabs' });
    expect(tablist).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
    expect(
      screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected'),
    ).toBe('false');
    expect(
      screen.getByRole('tab', { name: 'Bravo' }).getAttribute('aria-selected'),
    ).toBe('true');
  });

  test('generates a stable, id-prefixed tab id with a matching aria-controls a host can pair with role="tabpanel"', () => {
    render(
      <Tabs
        id="conn"
        activation="automatic"
        aria-label="Test tabs"
        items={ITEMS}
        activeKey="b"
        onSelect={vi.fn()}
      />,
    );
    const tab = screen.getByRole('tab', { name: 'Bravo' });
    expect(tab.id).toBe(tabElementId('conn', 'b'));
    expect(tab.getAttribute('aria-controls')).toBe(
      tabPanelElementId('conn', 'b'),
    );
  });

  test('clicking a tab calls onSelect with its key, regardless of activation mode', () => {
    for (const activation of ['automatic', 'manual'] as const) {
      const onSelect = vi.fn();
      const { unmount } = render(
        <Tabs
          id="t"
          activation={activation}
          aria-label="Test tabs"
          items={ITEMS}
          activeKey="a"
          onSelect={onSelect}
        />,
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Charlie' }));
      expect(onSelect).toHaveBeenCalledWith('c');
      expect(screen.getByRole('tab', { name: 'Charlie' }).tagName).toBe(
        'BUTTON',
      );
      unmount();
    }
  });

  test('a count renders inside the tab', () => {
    render(
      <Tabs
        id="t"
        activation="automatic"
        aria-label="Counted tabs"
        items={[{ key: 'models', label: 'Models', count: 3 }]}
        activeKey="models"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab').textContent).toContain('3');
  });

  /**
   * archive#4463: `.page__tab` is
   * `display: inline-flex`, and flexbox trims a flex item's OWN leading
   * whitespace at the start of its line box — the count span's " 3" text
   * content visually rendered as "3" with no gap ("Models0") in a real
   * browser, while the accessible name (plain string concatenation below,
   * unaffected by CSS) correctly read "Models 3". jsdom does not model
   * flexbox whitespace trimming, so it cannot see that divergence directly
   * this pins the STRUCTURAL fix instead (the count span carries the
   * class `page-layout.css`'s `.page__tab-count` rule targets for its
   * `margin-left` gap) and separately pins that the visible text and the
   * accessible name agree on the "Label N" content (WCAG 2.5.3
   * Label-in-Name), so a future edit can't silently let the two diverge
   * again.
   */
  test('the count badge carries its CSS spacing class, and visible text agrees with the accessible name on "Label N" (WCAG Label-in-Name)', () => {
    render(
      <Tabs
        id="t"
        activation="automatic"
        aria-label="Counted tabs"
        items={[
          { key: 'models', label: 'Models', count: 3 },
          { key: 'warn', label: 'Warn', count: 2, attention: true },
        ]}
        activeKey="models"
        onSelect={vi.fn()}
      />,
    );

    // No `attention`: the accessible name derives from content, so it is
    // computed (dom-accessibility-api's own whitespace normalization, a
    // separate concern from this fix) rather than a literal string — found
    // by index instead of `name:`, since a name lookup here would assert
    // that normalization rather than this fix.
    const modelsTab = screen.getAllByRole('tab')[0];
    expect(modelsTab.textContent).toBe('Models 3');
    const countSpan = modelsTab.querySelector('span');
    expect(countSpan?.className).toContain('page__tab-count');

    const warnTab = screen.getByRole('tab', { name: /needs attention/i });
    const accessibleName = warnTab.getAttribute('aria-label');
    // The visible "Warn 2" composition must appear verbatim inside the
    // accessible name, not merely share a word — the exact guard against
    // the "Models0" vs "Models 0" class of divergence, generalized to the
    // attention-composed name.
    expect(accessibleName).toContain('Warn 2');
    expect(warnTab.textContent).toContain('Warn 2');
    expect(warnTab.querySelector('span.page__tab-count')?.className).toContain(
      'page__tab-count',
    );
  });

  test('attention composes into the tab\'s own accessible name — never a nested role="status" a real AT would prune', () => {
    render(
      <Tabs
        id="t"
        activation="automatic"
        aria-label="Attention tabs"
        items={[
          { key: 'ok', label: 'OK' },
          { key: 'warn', label: 'Warn', count: 2, attention: true },
        ]}
        activeKey="ok"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    const warnTab = screen.getByRole('tab', { name: /needs attention/i });
    expect(warnTab.getAttribute('aria-label')).toBe('Warn 2, needs attention');
    // A tab with no attention gets no aria-label override — its accessible
    // name derives from visible text content, same as before.
    expect(
      screen.getByRole('tab', { name: 'OK' }).hasAttribute('aria-label'),
    ).toBe(false);
  });

  describe('automatic activation', () => {
    test('roving tabindex tracks the ACTIVE tab', () => {
      render(
        <Tabs
          id="t"
          activation="automatic"
          aria-label="Test tabs"
          items={ITEMS}
          activeKey="b"
          onSelect={vi.fn()}
        />,
      );
      expect(
        screen.getByRole('tab', { name: 'Alpha' }).getAttribute('tabindex'),
      ).toBe('-1');
      expect(
        screen.getByRole('tab', { name: 'Bravo' }).getAttribute('tabindex'),
      ).toBe('0');
    });

    test('ArrowRight activates the next tab immediately (moves focus AND selects)', () => {
      const onSelect = vi.fn();
      render(
        <Tabs
          id="t"
          activation="automatic"
          aria-label="Test tabs"
          items={ITEMS}
          activeKey="c"
          onSelect={onSelect}
        />,
      );
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Charlie' }), {
        key: 'ArrowRight',
      });
      expect(onSelect).toHaveBeenCalledWith('a');
    });

    test('ArrowLeft wraps to the last tab and activates it', () => {
      const onSelect = vi.fn();
      render(
        <Tabs
          id="t"
          activation="automatic"
          aria-label="Test tabs"
          items={ITEMS}
          activeKey="a"
          onSelect={onSelect}
        />,
      );
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Alpha' }), {
        key: 'ArrowLeft',
      });
      expect(onSelect).toHaveBeenCalledWith('c');
    });

    test('Home and End jump to and activate the first and last tab', () => {
      const onSelect = vi.fn();
      render(
        <Tabs
          id="t"
          activation="automatic"
          aria-label="Test tabs"
          items={ITEMS}
          activeKey="b"
          onSelect={onSelect}
        />,
      );
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Bravo' }), {
        key: 'Home',
      });
      expect(onSelect).toHaveBeenLastCalledWith('a');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Bravo' }), {
        key: 'End',
      });
      expect(onSelect).toHaveBeenLastCalledWith('c');
    });
  });

  describe('manual activation', () => {
    /**
     * archive#4463: automatic activation on a
     * route-changing host (Connections, Developer) was pushing one history
     * entry per arrow-key press. Manual activation's whole contract is
     * that arrow keys move focus ONLY — this is the fault-injectable proof
     * of that contract (see the fix-round report for the injection that
     * reddens this).
     */
    test('ArrowRight moves focus WITHOUT calling onSelect', () => {
      const onSelect = vi.fn();
      render(
        <Tabs
          id="t"
          activation="manual"
          aria-label="Test tabs"
          items={ITEMS}
          activeKey="a"
          onSelect={onSelect}
        />,
      );
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Alpha' }), {
        key: 'ArrowRight',
      });
      expect(onSelect).not.toHaveBeenCalled();
      expect(
        screen.getByRole('tab', { name: 'Bravo' }).getAttribute('tabindex'),
      ).toBe('0');
      expect(
        screen.getByRole('tab', { name: 'Alpha' }).getAttribute('tabindex'),
      ).toBe('-1');
      // Selection (aria-selected) has NOT moved — only focus has.
      expect(
        screen
          .getByRole('tab', { name: 'Alpha' })
          .getAttribute('aria-selected'),
      ).toBe('true');
    });

    test('Enter activates the currently focused tab', () => {
      const onSelect = vi.fn();
      render(
        <Tabs
          id="t"
          activation="manual"
          aria-label="Test tabs"
          items={ITEMS}
          activeKey="a"
          onSelect={onSelect}
        />,
      );
      const alpha = screen.getByRole('tab', { name: 'Alpha' });
      fireEvent.keyDown(alpha, { key: 'ArrowRight' });
      expect(onSelect).not.toHaveBeenCalled();
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Bravo' }), {
        key: 'Enter',
      });
      expect(onSelect).toHaveBeenCalledWith('b');
    });

    test('Space activates the currently focused tab', () => {
      const onSelect = vi.fn();
      render(
        <Tabs
          id="t"
          activation="manual"
          aria-label="Test tabs"
          items={ITEMS}
          activeKey="a"
          onSelect={onSelect}
        />,
      );
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Alpha' }), {
        key: ' ',
      });
      expect(onSelect).toHaveBeenCalledWith('a');
    });

    test('roving tabindex resets to the active tab when activeKey changes externally', () => {
      const { rerender } = render(
        <Tabs
          id="t"
          activation="manual"
          aria-label="Test tabs"
          items={ITEMS}
          activeKey="a"
          onSelect={vi.fn()}
        />,
      );
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Alpha' }), {
        key: 'ArrowRight',
      });
      expect(
        screen.getByRole('tab', { name: 'Bravo' }).getAttribute('tabindex'),
      ).toBe('0');
      // The host drives a real navigation (e.g. Enter elsewhere, or a deep
      // link) and re-renders with a new activeKey.
      rerender(
        <Tabs
          id="t"
          activation="manual"
          aria-label="Test tabs"
          items={ITEMS}
          activeKey="c"
          onSelect={vi.fn()}
        />,
      );
      expect(
        screen.getByRole('tab', { name: 'Charlie' }).getAttribute('tabindex'),
      ).toBe('0');
      expect(
        screen.getByRole('tab', { name: 'Bravo' }).getAttribute('tabindex'),
      ).toBe('-1');
    });
  });

  test('a key that is not a navigation key does nothing', () => {
    const onSelect = vi.fn();
    render(
      <Tabs
        id="t"
        activation="automatic"
        aria-label="Test tabs"
        items={ITEMS}
        activeKey="b"
        onSelect={onSelect}
      />,
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Bravo' }), {
      key: 'Tab',
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('the tablist renders only tab children — the guard against a group label sharing the row', () => {
    render(
      <Tabs
        id="t"
        activation="automatic"
        aria-label="Test tabs"
        items={ITEMS}
        activeKey="a"
        onSelect={vi.fn()}
      />,
    );
    const tablist = screen.getByRole('tablist');
    expect(tablist.children.length).toBeGreaterThan(0);
    for (const child of Array.from(tablist.children)) {
      expect(child.getAttribute('role')).toBe('tab');
    }
  });
});
