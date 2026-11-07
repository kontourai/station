/** @vitest-environment jsdom */

/**
 * Duo audit (51): with Home's composer focused on a phone, the collapsed dock
 * bar rode on top of the software keyboard, half under its accessory bar,
 * because the bar anchors to the visible viewport's bottom edge. The real
 * `DockShell` reads the keyboard from the real shared visual-viewport store
 * (`@kontourai/station-shared/visual-viewport`) and real focus; only the
 * shell's chrome state is stubbed, and the browser's `visualViewport` is a
 * stand-in whose height the test shortens the way a keyboard does.
 */

import { visualViewportSnapshot } from '@kontourai/station-shared/visual-viewport';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { DockShellChrome } from '../../../hooks/useDockShellChrome';
import { SOFT_KEYBOARD_MIN_INSET_PX } from '../../../hooks/useSoftKeyboardTarget';

const chrome = vi.hoisted(() => ({
  current: {} as Partial<DockShellChrome>,
}));
vi.mock('../../../hooks/useDockShellChrome', () => ({
  useDockShellChrome: () => chrome.current,
}));
vi.mock('../ChatDockResizeHandle', () => ({
  ChatDockResizeHandle: () => null,
}));

import { DockShell } from '../DockShell';

// The keyboard's stand-in: what the visual viewport loses at the bottom.
let keyboardInset = 0;
const viewport = new EventTarget();
beforeAll(() => {
  Object.defineProperty(viewport, 'height', {
    get: () => window.innerHeight - keyboardInset,
  });
  Object.defineProperty(viewport, 'offsetTop', { get: () => 0 });
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  });
});

function setKeyboard(inset: number) {
  keyboardInset = inset;
  act(() => {
    viewport.dispatchEvent(new Event('resize'));
  });
}

/** The store has read the new inset and React has rendered from it. */
async function settled(inset: number) {
  await waitFor(() => expect(visualViewportSnapshot().bottomInset).toBe(inset));
  await act(async () => {});
}

function chromeFor(
  overrides: Partial<DockShellChrome>,
): Partial<DockShellChrome> {
  return {
    isDockOpen: false,
    isDockMaximized: false,
    isDragging: false,
    isCollapsedDragPreview: false,
    isMobile: true,
    effectiveDockSlotPlacement: 'bottom',
    visualViewport: { style: {} } as DockShellChrome['visualViewport'],
    liveDragHeight: null,
    dockHeight: 320,
    ...overrides,
  };
}

function renderShell() {
  const field = document.createElement('textarea');
  document.body.append(field);
  const view = render(
    <DockShell>{() => <textarea aria-label="Dock composer" />}</DockShell>,
  );
  const dock = () => view.container.querySelector('section.chat-dock');
  return { field, dock, view };
}

beforeEach(() => {
  keyboardInset = 0;
  chrome.current = chromeFor({});
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  setKeyboard(0);
});

test('a collapsed phone bar steps aside while the keyboard types elsewhere, and returns with it', async () => {
  const { field, dock } = renderShell();
  expect(dock()?.hasAttribute('data-keyboard-hidden')).toBe(false);

  act(() => field.focus());
  setKeyboard(320);
  await waitFor(() =>
    expect(dock()?.hasAttribute('data-keyboard-hidden')).toBe(true),
  );

  // Keyboard down (the field may keep focus): the bar is back.
  setKeyboard(0);
  await waitFor(() =>
    expect(dock()?.hasAttribute('data-keyboard-hidden')).toBe(false),
  );
});

test('browser chrome alone is not a keyboard, and neither is a short viewport with nothing to type in', async () => {
  const { field, dock } = renderShell();
  // iOS Safari's floating toolbar costs the visual viewport well under the
  // keyboard threshold.
  act(() => field.focus());
  setKeyboard(SOFT_KEYBOARD_MIN_INSET_PX - 70);
  await settled(SOFT_KEYBOARD_MIN_INSET_PX - 70);
  expect(dock()?.hasAttribute('data-keyboard-hidden')).toBe(false);

  act(() => field.blur());
  setKeyboard(320);
  await settled(320);
  expect(dock()?.hasAttribute('data-keyboard-hidden')).toBe(false);
});

test('an open dock, a desktop, or the dock’s own field keeps the dock where it is', async () => {
  for (const overrides of [{ isDockOpen: true }, { isMobile: false }]) {
    chrome.current = chromeFor(overrides);
    const { field, dock } = renderShell();
    act(() => field.focus());
    setKeyboard(320);
    await settled(320);
    expect(dock()?.hasAttribute('data-keyboard-hidden')).toBe(false);
    cleanup();
    document.body.replaceChildren();
    setKeyboard(0);
  }
  chrome.current = chromeFor({});
  const { dock, view } = renderShell();
  act(() => view.getByLabelText('Dock composer').focus());
  setKeyboard(320);
  await settled(320);
  expect(dock()?.hasAttribute('data-keyboard-hidden')).toBe(false);
});
