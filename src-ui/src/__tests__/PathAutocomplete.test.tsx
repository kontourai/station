/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const browseMock = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useFileSystemBrowseQuery: (path?: string, config?: { enabled?: boolean }) =>
    browseMock(path, config),
}));

import { PathAutocomplete } from '../components/PathAutocomplete';

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
    expect(screen.getAllByText('project')).toHaveLength(1);
    expect(inputs[1].parentElement?.querySelector('button')).toBeTruthy();
    fireEvent.focus(inputs[0]);
    expect(screen.getAllByText('project')).toHaveLength(1);
    expect(inputs[0].parentElement?.querySelector('button')).toBeTruthy();
    expect(inputs[1].parentElement?.querySelector('button')).toBeNull();
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
