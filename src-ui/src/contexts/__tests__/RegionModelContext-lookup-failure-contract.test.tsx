/** @vitest-environment jsdom */

/**
 * #1582 review (M1): the sibling files here mock `@kontourai/station-sdk`, so
 * they pin what the dock does with a `null` and what it does with a throw —
 * and nothing about WHICH server answer produces which. That distinction is
 * the whole fix: `fetchConversationById` used to report any
 * `{ success: false }` envelope as `null`, and the conversations route sends
 * that shape for a 500, a 400 and a 401 as readily as for a miss, so a
 * transient blip during a reload dropped a real conversation's `?chat=`
 * pointer and shut the region archive#1284 opens.
 *
 * This one stubs `fetch` and lets the REAL SDK function run into the real hook
 * and the real region model. Reverting the SDK to `return null` for a
 * non-success reddens the 500 case here, which is what makes it a test of the
 * contract rather than of the mock.
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

let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  const { activeChat, updateParams } = useNavigation();
  const showSurface = useShowSurface();
  const register = value.registerRegionSurfaceHost;
  useEffect(() => register(), [register]);
  useEffect(() => {
    model = value;
  }, [value]);
  useChatDockActiveChatSync({
    activeChat,
    agentCatalogKey: '__agent:claude',
    agentsLoaded: true,
    apiBase: 'https://station.example.test',
    sessions: [],
    openConversation: vi.fn().mockResolvedValue(true),
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

/** The conversations route's own envelope, at whatever status. */
function stubConversationLookup(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(
        typeof input === 'string' ? input : (input as Request).url,
      );
      if (url.includes('/api/conversations/')) {
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  model = null;
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

describe('what the server answered decides what the reload shows', () => {
  test('a 500 keeps the Activity reveal — the pointer is unresolved, not dead', async () => {
    setUrl('/?chat=real-conversation&dock=open');
    stubConversationLookup(500, {
      success: false,
      error: 'Conversation lookup exploded',
    });

    await mountReload();

    await waitFor(
      () =>
        expect(model?.regions.right).toMatchObject({
          occupant: 'activity',
          visible: true,
        }),
      { timeout: 4000 },
    );
  });

  test('a 404 places no surface — that id names nothing', async () => {
    setUrl('/?chat=claude%3A1788672912443&dock=open');
    stubConversationLookup(404, {
      success: false,
      error: 'Conversation not found',
    });

    await mountReload();

    await waitFor(() =>
      expect(
        new URLSearchParams(window.location.search).get('chat'),
      ).toBeNull(),
    );
    expect(
      Object.values(model?.regions ?? {}).some(
        (region) => region.occupant === 'activity',
      ),
    ).toBe(false);
  });
});
