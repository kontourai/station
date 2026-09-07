/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const browseMock = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useFileSystemBrowseQuery: (path?: string, config?: { enabled?: boolean }) =>
    browseMock(path, config),
}));

import {
  anchorIsWithinClip,
  PathAutocomplete,
  scrollClipRect,
} from '../components/PathAutocomplete';

function ControlledPathAutocomplete({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <PathAutocomplete
      value={value}
      onChange={setValue}
      apiBase="http://localhost:3000"
      browsable
    />
  );
}

/**
 * #1582 E6. Scrolling the New Project modal's body by 220px put the directory
 * input 177px above the visible area while its suggestion list — which hangs
 * below the input and is taller than that gap — still painted 138px of itself
 * over the Description field. Measured live on 2026-09-06 before the fix:
 * input `top: -47`, dropdown `top: 12`, scrollport `top: 130`.
 */
describe('the suggestion list follows its input out of a scrollport', () => {
  test('the clip rectangle is the first ancestor that actually scrolls', () => {
    const outer = document.createElement('div');
    const middle = document.createElement('div');
    const scroller = document.createElement('div');
    const inner = document.createElement('div');
    const input = document.createElement('input');
    // Only `scroller` clips. `outer` also scrolls, and must NOT be the answer:
    // an element is clipped by the FIRST such ancestor, and taking the
    // outermost one would report a field visible while a nearer scrollport
    // had already hidden it.
    outer.style.overflowY = 'auto';
    scroller.style.overflowY = 'auto';
    outer.appendChild(middle);
    middle.appendChild(scroller);
    scroller.appendChild(inner);
    inner.appendChild(input);
    document.body.appendChild(outer);
    const rect = (element: Element, top: number, bottom: number) => {
      Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          top,
          bottom,
          left: 0,
          right: 100,
          width: 100,
          height: bottom - top,
        }),
      });
    };
    rect(outer, 0, 900);
    rect(scroller, 130, 492);

    expect(scrollClipRect(input)).toMatchObject({ top: 130, bottom: 492 });

    document.body.removeChild(outer);
  });

  test('an unmeasurable anchor is not treated as hidden', () => {
    // jsdom lays nothing out, and a real field renders a frame before layout.
    // An all-zero rect is the absence of a measurement, not evidence.
    const zero = { top: 0, bottom: 0, left: 0, right: 0 };
    expect(
      anchorIsWithinClip(zero, { top: 130, bottom: 492, left: 0, right: 670 }),
    ).toBe(true);
  });

  test('the anchor is hidden exactly when it has left the scrollport', () => {
    const clip = { top: 130, bottom: 492, left: 305, right: 975 };
    // The measured pre-fix position: the input scrolled fully above the port.
    expect(
      anchorIsWithinClip({ top: -47, bottom: 6, left: 322, right: 910 }, clip),
    ).toBe(false);
    // One pixel of it still showing is still showing.
    expect(
      anchorIsWithinClip(
        { top: 100, bottom: 131, left: 322, right: 910 },
        clip,
      ),
    ).toBe(true);
    // Flush against the top edge is NOT visible: `bottom === clip.top` means
    // zero rows of the field are on screen.
    expect(
      anchorIsWithinClip({ top: 77, bottom: 130, left: 322, right: 910 }, clip),
    ).toBe(false);
    // Below the port, and horizontally out of it.
    expect(
      anchorIsWithinClip(
        { top: 492, bottom: 545, left: 322, right: 910 },
        clip,
      ),
    ).toBe(false);
    expect(
      anchorIsWithinClip({ top: 200, bottom: 253, left: 0, right: 305 }, clip),
    ).toBe(false);
  });

  test('a scroll that hides the input removes the list, and scrolling back restores it', () => {
    browseMock.mockReturnValue({
      data: {
        path: '/Users/test',
        entries: [{ name: 'Documents', isDirectory: true }],
      },
    });
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    document.body.appendChild(scroller);
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 130,
        bottom: 492,
        left: 0,
        right: 670,
        width: 670,
        height: 362,
      }),
    });

    render(
      <PathAutocomplete
        value="~/Do"
        onChange={vi.fn()}
        apiBase="http://localhost:3000"
      />,
      { container: scroller },
    );
    const input = scroller.querySelector('input');
    if (!input) throw new Error('the field did not render');
    let inputTop = 200;
    Object.defineProperty(input, 'getBoundingClientRect', {
      configurable: true,
      get: () => () => ({
        top: inputTop,
        bottom: inputTop + 53,
        left: 0,
        right: 588,
        width: 588,
        height: 53,
      }),
    });

    // In view: the list is on screen. (The effect measures on mount, so this
    // also proves the mount measurement does not hide a visible field.)
    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(screen.getByText('Documents')).toBeTruthy();

    // Scrolled out: the list goes with it.
    inputTop = -47;
    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(screen.queryByText('Documents')).toBeNull();

    // Nothing was dismissed — scrolling back shows the same list. A fix that
    // closed the list instead would pass the assertion above and fail here.
    inputTop = 200;
    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(screen.getByText('Documents')).toBeTruthy();

    document.body.removeChild(scroller);
  });
});

describe('PathAutocomplete', () => {
  beforeEach(() => {
    browseMock.mockReset();
  });

  test('queries the home shortcut path and suggests directories only', () => {
    browseMock.mockReturnValue({
      data: {
        path: '/Users/test',
        entries: [
          { name: 'Documents', isDirectory: true },
          { name: 'Downloads', isDirectory: true },
          { name: 'notes.txt', isDirectory: false },
        ],
      },
    });
    const onChange = vi.fn();

    render(
      <PathAutocomplete
        value="~/Do"
        onChange={onChange}
        apiBase="http://localhost:3000"
      />,
    );

    expect(browseMock).toHaveBeenCalledWith('~', { enabled: true });
    expect(screen.getByText('Documents')).toBeTruthy();
    expect(screen.queryByText(/notes\.txt/)).toBeNull();
  });

  test('prefix-matches only — typing "de" excludes .codex/.claude, includes dev/Desktop', () => {
    browseMock.mockReturnValue({
      data: {
        path: '/Users/test',
        entries: [
          { name: '.codex', isDirectory: true },
          { name: '.claude', isDirectory: true },
          { name: 'dev', isDirectory: true },
          { name: 'Desktop', isDirectory: true },
          { name: 'Documents', isDirectory: true },
        ],
      },
    });

    render(
      <PathAutocomplete
        value="~/de"
        onChange={vi.fn()}
        apiBase="http://localhost:3000"
      />,
    );

    // Prefix matches present.
    expect(screen.getByText('dev')).toBeTruthy();
    expect(screen.getByText('Desktop')).toBeTruthy();
    // Substring-only matches (`.codex`, `.claude` contain "de") excluded.
    expect(screen.queryByText('.codex')).toBeNull();
    expect(screen.queryByText('.claude')).toBeNull();
    // Non-matching prefix excluded.
    expect(screen.queryByText('Documents')).toBeNull();
  });

  test('caps the suggestion list at 8 results', () => {
    browseMock.mockReturnValue({
      data: {
        path: '/Users/test',
        entries: Array.from({ length: 20 }, (_, i) => ({
          name: `demo-${String(i).padStart(2, '0')}`,
          isDirectory: true,
        })),
      },
    });

    render(
      <PathAutocomplete
        value="~/demo"
        onChange={vi.fn()}
        apiBase="http://localhost:3000"
      />,
    );

    const options = screen.getAllByRole('button');
    expect(options.length).toBe(8);
  });

  test('tab-completes a single directory and appends a trailing slash', () => {
    browseMock.mockImplementation((path?: string) => {
      if (path === '/tmp/pro') {
        return { data: undefined };
      }
      return {
        data: {
          path: '/tmp',
          entries: [{ name: 'project', isDirectory: true }],
        },
      };
    });
    const onChange = vi.fn();

    render(
      <PathAutocomplete
        value="/tmp/pro"
        onChange={onChange}
        apiBase="http://localhost:3000"
      />,
    );

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' });

    expect(onChange).toHaveBeenCalledWith('/tmp/project/');
  });

  test('enter accepts the exact typed directory and appends a trailing slash', () => {
    browseMock.mockImplementation((path?: string) => {
      if (path === '/tmp/project') {
        return {
          data: {
            path: '/tmp/project',
            entries: [{ name: 'src', isDirectory: true }],
          },
        };
      }

      return {
        data: {
          path: '/tmp',
          entries: [{ name: 'project', isDirectory: true }],
        },
      };
    });
    const onChange = vi.fn();

    render(
      <PathAutocomplete
        value="/tmp/project"
        onChange={onChange}
        apiBase="http://localhost:3000"
      />,
    );

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('/tmp/project/');
  });

  test('uses ~ prefix in suggestions when user types ~/ even though server returns absolute path', () => {
    browseMock.mockImplementation(() => ({
      data: {
        path: '/Users/test',
        entries: [
          { name: 'Documents', isDirectory: true },
          { name: 'Projects', isDirectory: true },
        ],
      },
    }));

    render(
      <PathAutocomplete
        value="~/"
        onChange={vi.fn()}
        apiBase="http://localhost:3000"
      />,
    );

    expect(browseMock).toHaveBeenCalledWith('~', { enabled: true });

    const docsItem = screen.getByText('Documents').closest('button');
    const projItem = screen.getByText('Projects').closest('button');

    expect(docsItem?.textContent).toContain('~/Documents');
    expect(docsItem?.textContent).not.toContain('/Users/test/Documents');
    expect(projItem?.textContent).toContain('~/Projects');
  });

  test('auto-focuses the input on mount', () => {
    browseMock.mockReturnValue({ data: undefined });

    render(
      <PathAutocomplete
        value="/tmp"
        onChange={vi.fn()}
        apiBase="http://localhost:3000"
      />,
    );

    const input = screen.getByRole('textbox');
    expect(input).toBe(document.activeElement);
  });

  test('dismisses on outside pointer interaction without consuming the outside action', () => {
    browseMock.mockReturnValue({
      data: {
        path: '/tmp',
        entries: [{ name: 'project', isDirectory: true }],
      },
    });
    const outsideAction = vi.fn();
    render(
      <>
        <PathAutocomplete
          value="/tmp/pro"
          onChange={vi.fn()}
          apiBase="http://localhost:3000"
        />
        <button type="button" onClick={outsideAction}>
          Outside action
        </button>
      </>,
    );

    const outside = screen.getByRole('button', { name: 'Outside action' });
    fireEvent.pointerDown(outside);
    outside.focus();

    // Keep the list mounted until the target's click is delivered. On narrow
    // screens the list participates in layout; dismissing during pointerdown
    // or focus transfer would move the target and lose the click.
    expect(screen.getByText('project')).toBeTruthy();
    fireEvent.click(outside);

    expect(screen.queryByText('project')).toBeNull();
    expect(outsideAction).toHaveBeenCalledOnce();
  });

  test('commits an internal pointer selection before closing', () => {
    browseMock.mockReturnValue({
      data: {
        path: '/tmp',
        entries: [{ name: 'project', isDirectory: true }],
      },
    });
    const onChange = vi.fn();
    render(
      <PathAutocomplete
        value="/tmp/pro"
        onChange={onChange}
        apiBase="http://localhost:3000"
      />,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: /project/ }));
    expect(onChange).toHaveBeenCalledWith('/tmp/project/');
  });

  test('Escape and focus transfer outside dismiss and reset selection', () => {
    browseMock.mockReturnValue({
      data: {
        path: '/tmp',
        entries: [
          { name: 'project', isDirectory: true },
          { name: 'prototype', isDirectory: true },
        ],
      },
    });
    render(
      <>
        <PathAutocomplete
          value="/tmp/pro"
          onChange={vi.fn()}
          apiBase="http://localhost:3000"
        />
        <button type="button">Next field</button>
      </>,
    );
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('project')).toBeNull();

    fireEvent.focus(input);
    expect(screen.getByText('project')).toBeTruthy();
    fireEvent.focus(screen.getByRole('button', { name: 'Next field' }));
    expect(screen.queryByText('project')).toBeNull();
  });

  test('multiple instances dismiss independently', () => {
    browseMock.mockReturnValue({
      data: {
        path: '/tmp',
        entries: [{ name: 'project', isDirectory: true }],
      },
    });
    render(
      <>
        <PathAutocomplete
          value="/tmp/pro"
          onChange={vi.fn()}
          apiBase="http://localhost:3000"
        />
        <PathAutocomplete
          value="/tmp/pro"
          onChange={vi.fn()}
          apiBase="http://localhost:3000"
        />
      </>,
    );

    const inputs = screen.getAllByRole('textbox');
    const dropdownButton = (input: HTMLElement) =>
      input
        .closest('.path-autocomplete')
        ?.querySelector('.path-autocomplete__dropdown button');
    expect(screen.getAllByText('project')).toHaveLength(1);
    expect(dropdownButton(inputs[1])).toBeTruthy();
    fireEvent.focus(inputs[0]);
    expect(screen.getAllByText('project')).toHaveLength(1);
    expect(dropdownButton(inputs[0])).toBeTruthy();
    expect(dropdownButton(inputs[1])).toBeNull();
  });

  test('removes document listeners when an open instance unmounts', () => {
    browseMock.mockReturnValue({
      data: {
        path: '/tmp',
        entries: [{ name: 'project', isDirectory: true }],
      },
    });
    const remove = vi.spyOn(document, 'removeEventListener');
    const view = render(
      <PathAutocomplete
        value="/tmp/pro"
        onChange={vi.fn()}
        apiBase="http://localhost:3000"
      />,
    );
    view.unmount();

    expect(remove).toHaveBeenCalledWith(
      'pointerdown',
      expect.any(Function),
      true,
    );
    expect(remove).toHaveBeenCalledWith('focusin', expect.any(Function), true);
    remove.mockRestore();
  });

  test('a late browse result cannot reopen an outside-dismissed list', () => {
    let entries = [{ name: 'project', isDirectory: true }];
    browseMock.mockImplementation(() => ({
      data: { path: '/tmp', entries },
    }));
    const view = render(
      <>
        <PathAutocomplete
          value="/tmp/pro"
          onChange={vi.fn()}
          apiBase="http://localhost:3000"
        />
        <button type="button">Outside</button>
      </>,
    );
    const outside = screen.getByRole('button', { name: 'Outside' });
    fireEvent.pointerDown(outside);
    fireEvent.click(outside);
    expect(screen.queryByText('project')).toBeNull();

    entries = [
      { name: 'project', isDirectory: true },
      { name: 'prototype', isDirectory: true },
    ];
    view.rerender(
      <>
        <PathAutocomplete
          value="/tmp/pro"
          onChange={vi.fn()}
          apiBase="http://localhost:3000"
        />
        <button type="button">Outside</button>
      </>,
    );
    expect(screen.queryByText('prototype')).toBeNull();
  });

  test('Escape before browse resolves keeps late suggestions dismissed', () => {
    let entries: Array<{ name: string; isDirectory: boolean }> = [];
    browseMock.mockImplementation(() => ({
      data: { path: '/tmp', entries },
    }));
    const view = render(
      <PathAutocomplete
        value="/tmp/pro"
        onChange={vi.fn()}
        apiBase="http://localhost:3000"
      />,
    );

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    entries = [{ name: 'project', isDirectory: true }];
    view.rerender(
      <PathAutocomplete
        value="/tmp/pro"
        onChange={vi.fn()}
        apiBase="http://localhost:3000"
      />,
    );

    expect(screen.queryByText('project')).toBeNull();
  });

  test('renders no Browse button by default (opt-in only)', () => {
    browseMock.mockReturnValue({ data: undefined });

    render(
      <PathAutocomplete
        value="/tmp"
        onChange={vi.fn()}
        apiBase="http://localhost:3000"
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Browse for a folder' }),
    ).toBeNull();
  });

  test('browsable renders a Browse button that opens the shared folder browser', () => {
    browseMock.mockReturnValue({
      data: { path: '/tmp', entries: [{ name: 'project', isDirectory: true }] },
    });

    render(
      <PathAutocomplete
        value="/tmp"
        onChange={vi.fn()}
        apiBase="http://localhost:3000"
        browsable
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Browse for a folder' }),
    );

    expect(screen.getByText('Select This Folder')).toBeTruthy();
  });

  test('selecting a folder in the browser lands the value through the same onChange, trailing-slash normalized', () => {
    browseMock.mockReturnValue({
      data: { path: '/tmp/picked', entries: [] },
    });
    const onChange = vi.fn();

    render(
      <PathAutocomplete
        value="/tmp"
        onChange={onChange}
        apiBase="http://localhost:3000"
        browsable
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Browse for a folder' }),
    );
    fireEvent.click(screen.getByText('Select This Folder'));

    expect(onChange).toHaveBeenCalledWith('/tmp/picked/');
    expect(screen.queryByText('Select This Folder')).toBeNull();
  });

  test('a stale blur-dismiss timer from opening the browser cannot dismiss suggestions reopened by closing it (#998 class)', () => {
    vi.useFakeTimers();
    try {
      browseMock.mockReturnValue({
        data: {
          path: '/tmp',
          entries: [{ name: 'project', isDirectory: true }],
        },
      });

      render(<ControlledPathAutocomplete initial="/tmp/pro" />);
      const input = screen.getByRole('textbox');
      // The shared browseMock also backs the folder browser modal's own
      // listing (both call the same mocked hook), so once the dialog is
      // open a "project" row exists there too — scope every assertion to
      // the suggestion DROPDOWN specifically, never bare text.
      const dropdown = () =>
        document.querySelector('.path-autocomplete__dropdown');

      expect(dropdown()).toBeTruthy();

      // Real-browser sequence: mousedown on Browse moves focus off the
      // input (firing its blur handler, scheduling a 200ms dismiss) before
      // the click handler that opens the dialog runs.
      fireEvent.blur(input);
      fireEvent.click(
        screen.getByRole('button', { name: 'Browse for a folder' }),
      );
      // Opening dismisses the dropdown so it doesn't render under the modal.
      expect(dropdown()).toBeNull();

      fireEvent.click(
        screen.getByRole('button', { name: 'Close folder browser' }),
      );

      // Closing returns focus to the input synchronously and reopens the
      // dropdown for the still-current value.
      expect(document.activeElement).toBe(input);
      expect(dropdown()).toBeTruthy();

      // Advance past the 200ms window the very first blur scheduled. If
      // that timer were not cancelled when Browse opened, it would fire
      // now and dismiss the dropdown the close just reopened.
      vi.advanceTimersByTime(250);

      expect(dropdown()).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // #998. A stale blur — armed for a reason unrelated to the user
  // leaving the field (e.g. a sibling remount stealing focus then returning
  // it) — must not dismiss a dropdown the input was re-engaged with before
  // the 200ms timer fired. Runs under fake timers because the underlying
  // race is only ~1/6 reproducible against real timers; this deterministically
  // arms the exact stale-timer window regardless.
  test('a refocus inside the 200ms blur window keeps suggestions shown', () => {
    vi.useFakeTimers();
    try {
      browseMock.mockReturnValue({
        data: {
          path: '/tmp',
          entries: [{ name: 'project', isDirectory: true }],
        },
      });
      render(
        <PathAutocomplete
          value="/tmp/pro"
          onChange={vi.fn()}
          apiBase="http://localhost:3000"
        />,
      );
      const input = screen.getByRole('textbox');
      expect(screen.getByText('project')).toBeTruthy();

      // Blur arms the 200ms dismiss timer.
      fireEvent.blur(input);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      // The input is legitimately re-engaged before the timer fires.
      fireEvent.focus(input);
      // Advance past the original 200ms mark (100ms already elapsed + 150ms).
      act(() => {
        vi.advanceTimersByTime(150);
      });

      expect(screen.getByText('project')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
