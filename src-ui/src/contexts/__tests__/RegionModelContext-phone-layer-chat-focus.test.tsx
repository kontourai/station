/** @vitest-environment jsdom */

/**
 * Review M4: a chat-focus intent — `focusSession`, `openChatForAgent`,
 * opening a conversation — shows Chat, so a pane open OVER Chat on a phone
 * must get out of the way. Driven through the real `useChatDockActions`
 * under the real provider and navigation store; only the chat-session
 * plumbing it reaches past the dock (API base, chat store, session create)
 * is stood in for.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../ActiveChatsContext', () => ({
  useActiveChatActions: () => ({ updateChat: vi.fn(), removeChat: vi.fn() }),
}));
vi.mock('../../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => vi.fn(),
  useOpenConversation: () => vi.fn(),
}));

import { useChatDockActions } from '../../hooks/useChatDockActions';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';

const PR = 'pr:github.com/kontourai/station#2049';
let model: ReturnType<typeof useRegionModel> | null = null;
let actions: ReturnType<typeof useChatDockActions> | null = null;

function Probe() {
  const value = useRegionModel();
  const chat = useChatDockActions({
    sessions: [],
    agents: [],
    activeSessionId: null,
    setActiveSessionId: () => {},
  } as unknown as Parameters<typeof useChatDockActions>[0]);
  useEffect(() => {
    model = value;
    actions = chat;
  }, [value, chat]);
  return null;
}

function current() {
  if (!model || !actions) throw new Error('probe never rendered');
  return { model, actions };
}

beforeEach(() => {
  model = null;
  actions = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', { dock: 'open', maximize: null });
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 390,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === MOBILE_MEDIA_QUERY || query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  navigationStore.navigate('/', { dock: null, dockSlotPlacement: null });
});

describe('focusing a chat while a pane is open over Chat', () => {
  test('focusSession dismisses the layer: Chat is shown, the minted tab gone', async () => {
    render(
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <RegionModelProvider>
            <Probe />
          </RegionModelProvider>
        </NavigationProvider>
      </KeyboardShortcutsProvider>,
    );
    await waitFor(() =>
      expect(current().model.regions.bottom.visible).toBe(true),
    );
    act(() => {
      current().model.openSurfaceInRegion(PR);
    });
    await waitFor(() =>
      expect(current().model.regions.bottom.occupant).toBe(PR),
    );

    act(() => current().actions.focusSession('session-1'));

    await waitFor(() => expect(current().model.phoneLayer).toBeNull());
    expect(current().model.regions.bottom).toMatchObject({
      panes: ['chat'],
      occupant: 'chat',
      visible: true,
    });
  });
});
