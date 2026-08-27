/**
 * @vitest-environment jsdom
 */

/**
 * station#1245 — a call site the issue does not list, found by its sweep.
 *
 * `MobileTaskSwitcher` is hand-rolled rather than a `ResponsiveDialogSurface`
 * (its own comment says so, about the history layer), and its restore was
 * `requestAnimationFrame(() => triggerRef.current?.focus())` — no `isConnected`
 * guard at all, the same shape as `CommandPalette`'s and worse than the one
 * station#1126 was filed against. Selecting a row switches chat, which can
 * replace the header the trigger lives in.
 *
 * COVERAGE HONESTY. jsdom, scoped to the wiring: the sheet captures a chain
 * from its trigger while it is still attached and hands it to
 * `@kontourai/station-shared/return-focus`. The module's structural veto is
 * proven in jsdom (`packages/shared/src/__tests__/return-focus.test.ts`) and
 * its post-focus verification only in Chromium
 * (`tests/dialog-return-focus.spec.ts`) — jsdom reports `.focus()` on a hidden
 * node as successful, so neither suite alone covers the behaviour.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { act, createRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MobileTaskSwitcher } from '../components/chat-dock/MobileTaskSwitcher';
import type { HomeTaskItem } from '../views/home/home-view-model';

const tasks: HomeTaskItem[] = [
  {
    id: 'chat:one',
    kind: 'chat',
    title: 'Draft the release note',
    projectLabel: 'Station',
    agentLabel: 'Claude Code',
    modelLabel: 'Sonnet',
    lifecycleLabel: 'Running',
    lifecycle: 'active',
    updatedAt: Date.now(),
    chatSessionId: 'one',
  } as unknown as HomeTaskItem,
];

function stubFrame() {
  const frame: { callback: FrameRequestCallback | null } = { callback: null };
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frame.callback = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return frame;
}

let frame: ReturnType<typeof stubFrame>;

beforeEach(() => {
  frame = stubFrame();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Deliberately not `document.body.innerHTML = ''`: Testing Library's own
  // cleanup removes its container from <body> afterwards and throws if this
  // hook already emptied it. Each test removes the nodes it appended.
});

function mountSheet(trigger: HTMLButtonElement, onClose = vi.fn()) {
  const triggerRef = createRef<HTMLButtonElement>() as {
    current: HTMLButtonElement | null;
  };
  triggerRef.current = trigger;
  const view = render(
    <MobileTaskSwitcher
      open
      tasks={tasks}
      activeChatSessionId={null}
      visualViewportStyle={{}}
      triggerRef={triggerRef}
      onClose={onClose}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      now={Date.now()}
    />,
  );
  return { view, onClose };
}

describe('MobileTaskSwitcher return focus (station#1245)', () => {
  test('restores focus to the trigger that opened it', () => {
    const header = document.createElement('header');
    const trigger = document.createElement('button');
    header.append(trigger);
    document.body.append(header);
    trigger.focus();

    mountSheet(trigger);
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.click(
      screen.getByRole('button', { name: 'Close task switcher' }),
    );
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(trigger);
    expect(trigger.hasAttribute('tabindex')).toBe(false);
  });

  /**
   * The sheet's own action removes its trigger: selecting a row switches the
   * active chat, and the mobile header re-renders around the new one. Pre-fix
   * `triggerRef.current?.focus()` on a detached node was a silent no-op and
   * focus sat on `<body>` (station#1126).
   */
  test('falls back to a surviving ancestor when the trigger did not survive', () => {
    const header = document.createElement('header');
    const bar = document.createElement('div');
    const trigger = document.createElement('button');
    bar.append(trigger);
    header.append(bar);
    document.body.append(header);
    trigger.focus();

    mountSheet(trigger);
    fireEvent.click(
      screen.getByRole('button', { name: 'Close task switcher' }),
    );
    // Switching chat re-rendered the header the trigger lived in.
    bar.remove();
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(header);
    expect(document.activeElement).not.toBe(document.body);
    expect(header.getAttribute('tabindex')).toBe('-1');
  });

  /** Gap 1: the chat the sheet just opened keeps the focus it claimed. */
  test('leaves focus alone when the destination already claimed it', () => {
    const header = document.createElement('header');
    const bar = document.createElement('div');
    const trigger = document.createElement('button');
    const composer = document.createElement('textarea');
    bar.append(trigger);
    header.append(bar);
    document.body.append(header, composer);
    trigger.focus();

    mountSheet(trigger);
    fireEvent.click(
      screen.getByRole('button', { name: 'Close task switcher' }),
    );
    bar.remove();
    composer.focus();
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(composer);
    expect(header.hasAttribute('tabindex')).toBe(false);
  });
});
