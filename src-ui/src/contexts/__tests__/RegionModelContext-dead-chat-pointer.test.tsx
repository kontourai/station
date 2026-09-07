/** @vitest-environment jsdom */

/**
 * #1582: what a load puts on screen must be a derivation of the persisted
 * arrangement, never a side effect of resolving a URL pointer.
 *
 * The measured defect: finishing the wizard and starting a chat leaves
 * `/?chat=<durable id>&dock=open` in the URL. A chat that never reached a
 * prompted turn is not promoted to a conversation, so its durable id is its
 * client session id (`activeChatDurableId`) and `serializeActiveChats` never
 * persists it — a reload of that URL is a guaranteed 404. The dock's cold
 * lookup then revealed Activity for that id, which placed and showed the
 * `right` region the user had never opened, with skeleton rows for a session
 * that does not exist.
 *
 * `useChatDockActiveChatSync.test.tsx` pins the hook's own decision. This file
 * executes the seam that produced the screenshot: the real
 * `RegionModelProvider` (seeded from the same device settings a reload reads),
 * the real `useShowSurface`, and the real hook, with only the network lookup
 * stubbed. Reverting the hook's fix reddens the arrangement assertion here.
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useChatDockActiveChatSync } from '../../components/chat-dock/useChatDockActiveChatSync';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider, useNavigation } from '../NavigationContext';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';
import { useShowSurface } from '../useShowSurface';

const fetchConversationById = vi.fn();
const openConversation = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  fetchConversationById: (...args: unknown[]) => fetchConversationById(...args),
}));

let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  const { activeChat, updateParams } = useNavigation();
  const showSurface = useShowSurface();
  // A region surface host is what makes `showSurface` a state write rather
  // than a deep-link navigation; the app mounts one whenever the ambient dock
  // is on screen, which is the state this reload lands in.
  const register = value.registerRegionSurfaceHost;
  useEffect(() => register(), [register]);
  useEffect(() => {
    model = value;
  }, [value]);
  useChatDockActiveChatSync({
    activeChat,
    agentCatalogKey: '__agent:claude',
    agentsLoaded: true,
    apiBase: '/api',
    sessions: [],
    openConversation,
    setActiveSessionId: vi.fn(),
    updateParams,
    showSurface,
  });
  return null;
}

function setUrl(url: string) {
  window.history.replaceState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

beforeEach(() => {
  model = null;
  fetchConversationById.mockReset();
  openConversation.mockReset();
  // The owning agent is gone, so the opener refuses — the only branch that
  // still reveals Activity once the lookup has produced a record.
  openConversation.mockResolvedValue(false);
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1440,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setUrl('/');
});

async function mountReload() {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(model).not.toBeNull());
}

describe('a reload carrying a chat pointer nothing can resolve', () => {
  test('leaves the side region closed and unoccupied', async () => {
    // Exactly what the audit reload carried: an unpromoted chat's session id.
    // `null` is now a 404 and only a 404 (see the SDK contract test).
    // Maximized, because that is the #1613 shape: the clear closes the dock
    // through `updateParams`, and `maximize` must go with it or the URL holds
    // the closed-and-still-maximized pair archive#795 refuses.
    setUrl('/?chat=claude%3A1788672912443&dock=open&maximize=true');
    fetchConversationById.mockResolvedValue(null);

    await mountReload();

    // The lookup has to have actually run, or the assertion below passes for
    // the wrong reason (nothing was ever attempted).
    await waitFor(() =>
      expect(fetchConversationById).toHaveBeenCalledWith(
        'claude:1788672912443',
        '/api',
      ),
    );
    // The pointer clears, which is the observable end of the resolution.
    await waitFor(() =>
      expect(
        new URLSearchParams(window.location.search).get('chat'),
      ).toBeNull(),
    );

    // station#1613 end to end: the real hook's real clear, through the real
    // store, leaves no `maximize` behind — the store-level tests drive
    // `updateParams` by hand, this one drives `clearDeadChatPointer`.
    expect(
      new URLSearchParams(window.location.search).get('maximize'),
    ).toBeNull();
    expect(model?.regions.right).toMatchObject({
      occupant: null,
      visible: false,
    });
    expect(model?.regions.left.occupant).toBeNull();
    // Activity is placed nowhere at all, not merely hidden in `right`.
    expect(
      Object.values(model?.regions ?? {}).some(
        (region) => region.occupant === 'activity',
      ),
    ).toBe(false);
  });

  // #1582 M1: the same URL, the same code path, and the opposite outcome —
  // because the SDK now separates "no such conversation" (404 -> null) from
  // "the lookup did not answer" (anything else -> throw). Before that split
  // the conversations route's `{success:false}` 500 arrived here as a miss and
  // this region stayed shut on a REAL conversation's pointer, which archive#1284
  // exists to prevent.
  test('a lookup that fails rather than misses keeps the Activity reveal', async () => {
    setUrl('/?chat=claude%3A1788672912443&dock=open');
    fetchConversationById.mockRejectedValue(
      Object.assign(new Error('Conversation lookup exploded'), { status: 500 }),
    );

    await mountReload();

    await waitFor(() =>
      expect(model?.regions.right).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );
  });

  test('still reveals Activity when the conversation exists but cannot be opened', async () => {
    // The archive#801/#1284 case this fix deliberately keeps: the lookup
    // returns a record, so there is a real session behind the id.
    setUrl('/?chat=orphaned-conversation&dock=open');
    fetchConversationById.mockResolvedValue({
      id: 'orphaned-conversation',
      agentSlug: 'deleted-agent',
      projectSlug: 'default',
    });

    await mountReload();

    await waitFor(() =>
      expect(model?.regions.right).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );
  });
});
