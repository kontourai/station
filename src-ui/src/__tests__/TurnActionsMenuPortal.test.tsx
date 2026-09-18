/**
 * @vitest-environment jsdom
 */

/**
 * The per-turn `…` menu opens from inside a message bubble. Absolutely
 * positioned there, it was clipped by the surfaces around it — the side-mode
 * transcript rules give `.message` itself `overflow-x: hidden`, so the menu's
 * left half was cut off at the bubble's own edge. The fix is the same escape
 * the TaskPicker dialog and the dock's More menu take: portal to
 * `document.body` and fix the box to the trigger's own rect.
 *
 * These tests drive the real trigger and assert what a user gets: the menu
 * leaves the component subtree entirely, and its fixed geometry anchors to
 * the trigger (above it, right-aligned) with the two disclosed fallbacks —
 * flip below when the viewport top cannot hold it, and pin the viewport
 * gutter when a narrow left dock leaves no room to right-align a min-width
 * menu.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import TurnActionsMenu from '../components/chat/TurnActionsMenu';

const FORK_SOURCE = { turnId: 'turn-1', agentSlug: 'agent-1' };

function stubTriggerRect(
  trigger: HTMLElement,
  rect: { top: number; bottom: number; left: number; right: number },
) {
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  } as DOMRect);
}

function openMenu(rect: {
  top: number;
  bottom: number;
  left: number;
  right: number;
}) {
  const { container } = render(
    <TurnActionsMenu forkSource={FORK_SOURCE} onForkFromTurn={vi.fn()} />,
  );
  const trigger = screen.getByRole('button', { name: 'More answer actions' });
  stubTriggerRect(trigger, rect);
  fireEvent.click(trigger);
  const menu = screen.getByRole('menu', { name: 'Answer actions' });
  return { container, trigger, menu };
}

describe('the turn actions menu escapes the message bubble', () => {
  test('renders in document.body, outside the component subtree', () => {
    const { container, menu } = openMenu({
      top: 400,
      bottom: 432,
      left: 800,
      right: 828,
    });
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  test('opens above the trigger, right-aligned to it', () => {
    const { menu } = openMenu({
      top: 400,
      bottom: 432,
      left: 800,
      right: 828,
    });
    // jsdom's viewport is 1024x768; gap is 4px.
    expect(menu.style.bottom).toBe(`${768 - 400 + 4}px`);
    expect(menu.style.right).toBe(`${1024 - 828}px`);
    expect(menu.style.top).toBe('');
    expect(menu.style.left).toBe('');
  });

  test('flips below when the trigger is too near the viewport top', () => {
    const { menu } = openMenu({
      top: 10,
      bottom: 42,
      left: 800,
      right: 828,
    });
    expect(menu.style.top).toBe(`${42 + 4}px`);
    expect(menu.style.bottom).toBe('');
    expect(menu.style.right).toBe(`${1024 - 828}px`);
  });

  test('pins the viewport gutter when the trigger is too near the left edge', () => {
    const { menu } = openMenu({
      top: 400,
      bottom: 432,
      left: 60,
      right: 88,
    });
    // 88px to the right edge cannot hold a min-width 180px menu with a gutter.
    expect(menu.style.left).toBe('8px');
    expect(menu.style.right).toBe('');
  });
});
