/**
 * @vitest-environment jsdom
 *
 * The shared scroll-spy / URL-section navigation primitive (archive#4463).
 * Real `<a aria-current="location">` anchors in a `nav`
 * landmark — NOT `role="tab"` — covering the review's contract: no arrow-key
 * activation (that reproduced the history-push/focus-steal defect on
 * an earlier version that treated this the same as `Tabs`), a modifier
 * click bails out before `preventDefault`, and `dividerAfter` draws
 * a real presentational element rather than a border modifier on the item
 * itself.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { SectionNav } from '../components/SectionNav';

const ITEMS = [
  { key: 'a', label: 'Alpha', href: '/settings?view=a' },
  { key: 'b', label: 'Bravo', href: '/settings?view=b' },
  { key: 'c', label: 'Charlie', href: '/settings?view=c' },
];

describe('SectionNav', () => {
  test('renders a nav landmark of real links, aria-current reflecting activeKey', () => {
    render(
      <SectionNav
        aria-label="Test sections"
        items={ITEMS}
        activeKey="b"
        onNavigate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('navigation', { name: 'Test sections' }),
    ).toBeTruthy();
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
    expect(
      screen.getByRole('link', { name: 'Alpha' }).getAttribute('aria-current'),
    ).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Bravo' }).getAttribute('aria-current'),
    ).toBe('location');
    expect(
      screen.getByRole('link', { name: 'Bravo' }).getAttribute('href'),
    ).toBe('/settings?view=b');
  });

  test('every link is independently Tab-focusable — no roving tabindex hiding one behind another', () => {
    render(
      <SectionNav
        aria-label="Test sections"
        items={ITEMS}
        activeKey="b"
        onNavigate={vi.fn()}
      />,
    );
    for (const link of screen.getAllByRole('link')) {
      expect(link.hasAttribute('tabindex')).toBe(false);
    }
  });

  test('a plain click navigates: preventDefault and onNavigate both fire', () => {
    const onNavigate = vi.fn();
    render(
      <SectionNav
        aria-label="Test sections"
        items={ITEMS}
        activeKey="a"
        onNavigate={onNavigate}
      />,
    );
    const clickReturned = fireEvent.click(
      screen.getByRole('link', { name: 'Charlie' }),
    );
    expect(onNavigate).toHaveBeenCalledWith('c');
    // `fireEvent.click` returns `false` when `preventDefault` was called.
    expect(clickReturned).toBe(false);
  });

  test.each([['metaKey'], ['ctrlKey'], ['shiftKey'], ['altKey']] as const)(
    'a %s-modified click bails out before preventDefault — onNavigate is not called',
    (modifier) => {
      const onNavigate = vi.fn();
      render(
        <SectionNav
          aria-label="Test sections"
          items={ITEMS}
          activeKey="a"
          onNavigate={onNavigate}
        />,
      );
      // Record whether the COMPONENT prevented the default, then prevent it
      // ourselves at the window (bubble runs target-first, so the component's
      // handler has already decided by the time this listener sees the
      // event). Without this catcher, the un-prevented anchor click proceeds
      // into jsdom's not-implemented navigation, which passes the test but
      // fails the vitest PROCESS (exit 1 with 0 failed tests) — the exact
      // exit-vs-tally mismatch ci:fast's diagnostics reconciliation rejects.
      let componentPrevented: boolean | null = null;
      const catcher = (event: MouseEvent) => {
        componentPrevented = event.defaultPrevented;
        event.preventDefault();
      };
      window.addEventListener('click', catcher);
      try {
        fireEvent.click(screen.getByRole('link', { name: 'Charlie' }), {
          [modifier]: true,
        });
      } finally {
        window.removeEventListener('click', catcher);
      }
      expect(onNavigate).not.toHaveBeenCalled();
      // Not prevented by the component — the browser's native
      // "open in new tab/window" default wins.
      expect(componentPrevented).toBe(false);
    },
  );

  test('ArrowRight does nothing — SectionNav has no arrow-key activation', () => {
    const onNavigate = vi.fn();
    render(
      <SectionNav
        aria-label="Test sections"
        items={ITEMS}
        activeKey="a"
        onNavigate={onNavigate}
      />,
    );
    fireEvent.keyDown(screen.getByRole('link', { name: 'Alpha' }), {
      key: 'ArrowRight',
    });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  test('dividerAfter renders a real, presentational separator element — not a border on the item', () => {
    const { container } = render(
      <SectionNav
        aria-label="Test sections"
        items={[
          { key: 'a', label: 'Alpha', href: '/a', dividerAfter: true },
          { key: 'b', label: 'Bravo', href: '/b' },
        ]}
        activeKey="a"
        onNavigate={vi.fn()}
      />,
    );
    const dividers = container.querySelectorAll('.section-nav__divider');
    expect(dividers).toHaveLength(1);
    expect(dividers[0].getAttribute('aria-hidden')).toBe('true');
    // The divider is a sibling of the links, not a class on the link itself.
    expect(
      screen
        .getByRole('link', { name: 'Alpha' })
        .classList.contains('section-nav__divider'),
    ).toBe(false);
  });

  test('an item with no dividerAfter draws no divider', () => {
    const { container } = render(
      <SectionNav
        aria-label="Test sections"
        items={ITEMS}
        activeKey="a"
        onNavigate={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('.section-nav__divider')).toHaveLength(0);
  });
});
