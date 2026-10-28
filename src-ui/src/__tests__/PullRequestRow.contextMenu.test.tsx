/** @vitest-environment jsdom */

/**
 * A right-click or a touch hold on a pull request row opens the row's own `⋯`
 * menu — the same rows, from the same trigger — through
 * `useContextMenuGesture` and `ActionOverflowMenu`'s handle. Driven through the
 * real row, so a row that stops wiring the gesture, or a menu that stops
 * honouring the handle, fails here.
 */

import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PullRequestRow } from '../components/pull-requests/PullRequestRow';
import { selectTextAt } from './selection-stub';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

function renderRow(onOpen = vi.fn(), unlink = vi.fn()) {
  render(
    <ul>
      <PullRequestRow
        title="Fix the dock"
        reference="#42"
        onOpen={onOpen}
        overflowLabel="More actions for #42"
        overflow={[{ key: 'unlink', label: 'Unlink', onSelect: unlink }]}
      />
    </ul>,
  );
  return {
    onOpen,
    unlink,
    open: screen.getByRole('button', { name: 'Fix the dock' }),
  };
}

/** Dispatches a contextmenu and reports whether the native menu was refused. */
function rightClick(target: Element, init: MouseEventInit = {}): boolean {
  const event = createEvent.contextMenu(target, {
    button: 2,
    clientX: 20,
    clientY: 30,
    ...init,
  });
  fireEvent(target, event);
  return event.defaultPrevented;
}

describe('pull request row context menu', () => {
  test('a right-click on the row opens the ⋯ menu with its rows', () => {
    const { open, unlink } = renderRow();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(rightClick(open)).toBe(true);
    const menu = screen.getByRole('menu', { name: 'More actions for #42' });
    expect(menu).toBeTruthy();
    const trigger = screen.getByRole('button', {
      name: 'More actions for #42',
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // Focus moved to the ⋯ so the menu hands it back there on close.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unlink' }));
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  test('a second right-click while open keeps the menu open', () => {
    const { open } = renderRow();
    rightClick(open);
    rightClick(open);
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  test('Shift+right-click is left to the platform', () => {
    const { open } = renderRow();
    expect(rightClick(open, { shiftKey: true })).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('Shift+F10 (the keyboard menu key, no right button) opens the row menu', () => {
    const { open } = renderRow();
    expect(rightClick(open, { shiftKey: true, button: 0 })).toBe(true);
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  test('a right-click on selected text is left to the platform', () => {
    const { open } = renderRow();
    const title = screen.getByText('Fix the dock');
    selectTextAt(title, { left: 0, top: 0, right: 100, bottom: 100 });
    expect(rightClick(title)).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(open).toBeTruthy();
  });

  test('after a hold, a quick tap on the menu it opened is not swallowed', () => {
    vi.useFakeTimers();
    const { open, unlink } = renderRow();
    fireEvent.pointerDown(open, {
      pointerType: 'touch',
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerUp(open, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Inside the 700ms swallow window. The menu is a body portal, but React
    // bubbles its events through the row: this click is the menu's, not the
    // hold's trailing one.
    const row = screen.getByRole('menuitem', { name: 'Unlink' });
    fireEvent.pointerDown(row, { pointerType: 'touch', button: 0 });
    fireEvent.pointerUp(row, { pointerType: 'touch' });
    fireEvent.click(row);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  test('holding a row of the open menu is not a new hold on the item', () => {
    vi.useFakeTimers();
    const { open, unlink } = renderRow();
    fireEvent.pointerDown(open, {
      pointerType: 'touch',
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerUp(open, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const row = screen.getByRole('menuitem', { name: 'Unlink' });
    fireEvent.pointerDown(row, { pointerType: 'touch', button: 0 });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.pointerUp(row, { pointerType: 'touch' });
    fireEvent.click(row);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  test("the platform's own long-press contextmenu during a hold is refused and opens nothing new", () => {
    vi.useFakeTimers();
    const { open } = renderRow();
    fireEvent.pointerDown(open, {
      pointerType: 'touch',
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    // Android's recogniser fires after the timer, while the finger is down.
    expect(rightClick(open, { button: 0 })).toBe(true);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    // Still the open menu's: a repeat open must not pull focus back out.
    expect(screen.getByRole('menu').contains(document.activeElement)).toBe(
      true,
    );
  });

  test('a long-press contextmenu that closed the menu first opens it again', () => {
    vi.useFakeTimers();
    const { open } = renderRow();
    fireEvent.pointerDown(open, {
      pointerType: 'touch',
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // Chromium's long-press moved focus onto the backdrop, which closes it.
    fireEvent.click(screen.getByRole('button', { name: /^Close more/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(rightClick(open, { button: 0 })).toBe(true);
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  test('a touch hold opens the menu and swallows the click it ends in', () => {
    vi.useFakeTimers();
    const { open, onOpen } = renderRow();
    fireEvent.pointerDown(open, {
      pointerType: 'touch',
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerUp(open, { pointerType: 'touch' });
    fireEvent.click(open);
    expect(onOpen).not.toHaveBeenCalled();
    // The swallow is bounded: a later tap opens the review as usual.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('a touch that moves (a scroll) opens nothing and keeps its click', () => {
    vi.useFakeTimers();
    const { open, onOpen } = renderRow();
    fireEvent.pointerDown(open, {
      pointerType: 'touch',
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(open, {
      pointerType: 'touch',
      clientX: 10,
      clientY: 40,
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.pointerUp(open, { pointerType: 'touch' });
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('a mouse hold is not a menu gesture', () => {
    vi.useFakeTimers();
    const { open } = renderRow();
    fireEvent.pointerDown(open, { pointerType: 'mouse', button: 0 });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
