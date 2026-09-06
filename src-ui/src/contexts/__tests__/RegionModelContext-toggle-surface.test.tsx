/** @vitest-environment jsdom */

/**
 * #1523: `RegionModelContext.toggleSurface` is the one decision behind a
 * surface's chord and its folded-menu row. The rules themselves are the pure
 * `toggleSurface` in region-model.ts (`region-model.test.ts`); what this file
 * proves is the provider's WIRING of them — that the command reaches state the
 * shells render, updates the fold's `lastShownRegion`, and hands the "show"
 * case to `showSurface` rather than re-deriving it. The toolbar and overflow
 * menu tests stub the model, so without this a provider that never applied
 * the result would leave every one of them green.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';

let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

function Harness() {
  return (
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>
  );
}

function setUrl(url: string) {
  window.history.replaceState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

async function mount() {
  render(<Harness />);
  await waitFor(() => expect(model).not.toBeNull());
}

beforeEach(() => {
  model = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1024,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  setUrl('/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setUrl('/');
});

describe('RegionModelProvider.toggleSurface', () => {
  test('a surface occupying main returns to its default dock region, visible, and main empties to Home', async () => {
    await mount();
    act(() => model?.placeSurface('activity', 'main'));
    await waitFor(() => expect(model?.regions.main.occupant).toBe('activity'));

    act(() => model?.toggleSurface('activity'));

    await waitFor(() =>
      expect(model?.regions.right).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(model?.regions.main).toEqual({
      visible: true,
      size: 0,
      occupant: null,
    });
    // The fold follows the region that just became visible.
    expect(model?.lastShownRegion).toBe('right');
    expect(window.location.pathname).toBe('/');
  });

  /**
   * Owner decision, review round 1 (#1523): the chord relocates a `main`
   * occupant from ANY route, visible, WITHOUT navigating. Showing Activity
   * beside the current view beats hijacking navigation to `/`; `main` empties
   * to Home behind the routed view, for whenever the user returns to `/`.
   */
  test('from another route, a main occupant returns to its dock without navigating', async () => {
    await mount();
    act(() => model?.placeSurface('activity', 'main'));
    await waitFor(() => expect(model?.regions.main.occupant).toBe('activity'));
    setUrl('/settings');
    await act(async () => undefined);
    const navigateSpy = vi.spyOn(navigationStore, 'navigate');

    act(() => model?.toggleSurface('activity'));

    await waitFor(() =>
      expect(model?.regions.right).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(model?.regions.main.occupant).toBeNull();
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/settings');
  });

  test('a dock occupant is hidden and revealed in place', async () => {
    await mount();
    act(() => model?.setRegion('bottom', { visible: true }));
    await waitFor(() => expect(model?.regions.bottom.visible).toBe(true));

    act(() => model?.toggleSurface('chat'));
    await waitFor(() => expect(model?.regions.bottom.visible).toBe(false));
    expect(model?.regions.bottom.occupant).toBe('chat');

    act(() => model?.toggleSurface('chat'));
    await waitFor(() => expect(model?.regions.bottom.visible).toBe(true));
    expect(model?.lastShownRegion).toBe('bottom');
  });

  test('an unplaced surface is shown where showSurface would put it', async () => {
    await mount();
    expect(model?.regions.right.occupant).toBeNull();

    act(() => model?.toggleSurface('activity'));

    await waitFor(() =>
      expect(model?.regions.right).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(model?.regions.main.occupant).toBe('home');
  });

  test('Home in main toggles to nothing', async () => {
    await mount();
    const before = model?.regions;

    act(() => model?.toggleSurface('home'));
    await act(async () => undefined);

    expect(model?.regions).toBe(before);
  });
});
