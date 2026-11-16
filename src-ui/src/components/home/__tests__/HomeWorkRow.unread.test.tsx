// @vitest-environment jsdom

/**
 * #3075 review: Home's work rows are the same row as the dock inbox's, and
 * the conversation on screen in a focused window is being read there too.
 * Without that, Home flashed the open chat's row as unread on each new turn.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { conversationOnScreenStore } from '../../../contexts/conversation-on-screen-store';
import type { HomeLaneItem } from '../../../views/home/home-lane-model';
import { renderHomeWorkRow } from '../HomeWorkRow';

const AT = Date.parse('2026-11-11T12:00:00.000Z');

const item: HomeLaneItem = {
  id: 'conversation-1',
  stableId: 'conversation-1',
  kind: 'chat',
  kindLabel: 'Direct chat',
  title: 'Write a migration note',
  projectLabel: 'launch',
  agentLabel: 'Reviewer',
  modelLabel: 'fixture-model',
  updatedAt: AT - 60_000,
  lifecycleLabel: 'Ready',
  chatSessionId: 'chat-1',
  unread: true,
  readVersion: AT - 60_000,
};

function rowUnread(): boolean {
  const { container } = render(
    <ul>
      {renderHomeWorkRow({
        task: item,
        isWoken: false,
        agents: [],
        onOpen: () => {},
        context: {
          now: AT,
          detailsFor: null,
          setDetailsFor: () => {},
          chrome: 'hover',
        },
      })}
    </ul>,
  );
  return (
    container
      .querySelector('[data-testid="inbox-row"]')
      ?.hasAttribute('data-unread') ?? false
  );
}

const owner = Symbol('test-dock');
let focused = true;

describe('Home rows and the conversation on screen', () => {
  beforeEach(() => {
    focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  });
  afterEach(() => {
    act(() => conversationOnScreenStore.release(owner));
    cleanup();
    vi.restoreAllMocks();
  });

  test('the chat on screen in a focused window does not read unread on Home', () => {
    act(() => conversationOnScreenStore.publish(owner, 'chat-1'));
    expect(rowUnread()).toBe(false);
  });

  test('another chat on screen, or none, leaves the server answer', () => {
    act(() => conversationOnScreenStore.publish(owner, 'chat-2'));
    expect(rowUnread()).toBe(true);
    cleanup();
    act(() => conversationOnScreenStore.release(owner));
    expect(rowUnread()).toBe(true);
  });

  test('an unfocused window leaves it unread', () => {
    focused = false;
    act(() => conversationOnScreenStore.publish(owner, 'chat-1'));
    expect(rowUnread()).toBe(true);
  });
});
