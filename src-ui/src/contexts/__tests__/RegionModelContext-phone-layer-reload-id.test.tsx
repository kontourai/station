/** @vitest-environment jsdom */

/**
 * Review MEDIUM: a phone layer's history entry ids restarted at 0 per page
 * load, but a reloaded entry keeps its marker. The first layer opened after a
 * reload then got the SAME id as the entry it was opened on, so
 * `dialog-history`'s popstate read "still on my entry" and Back did not close
 * the layer (the pane lost its maximize; a second Back was needed). Ids carry
 * a per-load nonce now.
 *
 * Its own file on purpose: `dialog-history` keeps module state (live
 * entries, orphaned markers) across tests in one file, and an orphan left by
 * an earlier test would mask the collision. This file is a fresh page load.
 */

import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { expect, test, vi } from 'vitest';
import { DIALOG_HISTORY_KEY } from '../../components/dialog-history';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';

const PR = 'pr:github.com/kontourai/station#2049';
let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

test('a layer opened on an entry an earlier load left behind still closes on Back', async () => {
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
  navigationStore.navigate('/', { dock: 'open', maximize: null });
  // The entry a reload left behind: an earlier load's first layer id.
  window.history.replaceState(
    { ...window.history.state, [DIALOG_HISTORY_KEY]: 'phone-pane-layer:1' },
    '',
    window.location.href,
  );
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(model?.regions.bottom.visible).toBe(true));
  act(() => {
    model?.openSurfaceInRegion(PR);
  });
  await waitFor(() => expect(model?.phoneLayer).not.toBeNull());
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('maximize')).toBe(
      'true',
    ),
  );
  act(() => window.history.back());
  await waitFor(() => expect(model?.phoneLayer).toBeNull());
  expect(model?.regions.bottom).toMatchObject({
    panes: ['chat'],
    occupant: 'chat',
  });
});
