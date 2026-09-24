/** @vitest-environment jsdom */

/**
 * Review MEDIUM: a phone layer's history entry ids restarted per page load,
 * but a reloaded entry keeps its marker. The first layer opened after a
 * reload then got the SAME id as the entry it was opened on, so
 * `dialog-history`'s popstate read "still on my entry" and Back did not close
 * the layer (a second Back was needed). Ids carry a per-load nonce now.
 *
 * Two real page loads, not a hand-written marker: the first load opens a
 * layer and its REAL marker is captured; `vi.resetModules()` then gives the
 * second load fresh modules — a fresh nonce, a fresh `dialog-history` and
 * navigation store — mounted on that same entry. A nonce that did not change
 * per load (a constant) reproduces the collision here.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { type ComponentType, type ReactNode, useEffect } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';

const PR = 'pr:github.com/kontourai/station#2049';

type Model = {
  phoneLayer: { region: string; surfaceId: string } | null;
  regions: Record<
    string,
    { panes: readonly string[]; occupant: string | null; visible: boolean }
  >;
  openSurfaceInRegion(surfaceId: string): unknown;
};

/** One page load: this load's modules, mounted on the current entry. */
async function loadPage() {
  const [shortcuts, navigation, navStore, regionModel, dialogHistory] =
    await Promise.all([
      import('../KeyboardShortcutsContext'),
      import('../NavigationContext'),
      import('../navigation-store'),
      import('../RegionModelContext'),
      import('../../components/dialog-history'),
    ]);
  let model: Model | null = null;
  function Probe() {
    const value = regionModel.useRegionModel() as unknown as Model;
    useEffect(() => {
      model = value;
    }, [value]);
    return null;
  }
  const Shortcuts = shortcuts.KeyboardShortcutsProvider as ComponentType<{
    children: ReactNode;
  }>;
  const Navigation = navigation.NavigationProvider as ComponentType<{
    children: ReactNode;
  }>;
  const Regions = regionModel.RegionModelProvider;
  render(
    <Shortcuts>
      <Navigation>
        <Regions>
          <Probe />
        </Regions>
      </Navigation>
    </Shortcuts>,
  );
  await waitFor(() => expect(model?.regions.bottom.visible).toBe(true));
  const current = () => {
    if (!model) throw new Error('probe never rendered');
    return model;
  };
  const marker = () =>
    (window.history.state as Record<string, unknown> | null)?.[
      dialogHistory.DIALOG_HISTORY_KEY
    ];
  return { current, marker, navigationStore: navStore.navigationStore };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a layer opened on the entry an earlier load left behind still closes on Back', async () => {
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
  window.history.replaceState({}, '', '/?dock=open');

  // Load 1: open a layer, and capture the entry it leaves.
  const first = await loadPage();
  first.navigationStore.navigate('/', { dock: 'open', maximize: null });
  act(() => {
    first.current().openSurfaceInRegion(PR);
  });
  await waitFor(() =>
    expect(String(first.marker() ?? '')).toMatch(/^phone-pane-layer:/),
  );
  const leftBehind = first.marker();
  const href = window.location.href;
  const state = window.history.state;

  // The reload: the entry stays exactly as the unloaded page left it (a real
  // reload runs no React cleanup), and the new load has fresh modules.
  cleanup();
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  window.history.replaceState(state, '', href);
  sessionStorage.clear();
  vi.resetModules();

  // Load 2 on that entry: its first layer must get a different id.
  const second = await loadPage();
  expect(second.marker()).toBe(leftBehind);
  act(() => {
    second.current().openSurfaceInRegion(PR);
  });
  await waitFor(() => expect(second.current().phoneLayer).not.toBeNull());
  // Let the layer's entry and its `?maximize` settle before Back (the
  // assertion that matters is Back closing it, below).
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('maximize')).toBe(
      'true',
    ),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  act(() => window.history.back());
  await waitFor(() => expect(second.current().phoneLayer).toBeNull());
  expect(second.current().regions.bottom).toMatchObject({
    panes: ['chat'],
    occupant: 'chat',
  });
});
