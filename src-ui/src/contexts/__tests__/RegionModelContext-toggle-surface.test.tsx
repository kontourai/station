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

describe('RegionModelProvider pane selection (#2046 2a)', () => {
  /**
   * `showSurface` for a surface a region holds BEHIND another pane's tab
   * selects that tab (and shows the region). Reverting `revealSurface` to a
   * visibility-only write leaves `occupant` at `chat` and the first
   * assertion reds; reverting `placeSurface`'s join leaves `panes` at
   * `['chat']` and the precondition reds. (Chat is `bottom`'s default pane,
   * so it is first in tab order; Activity joins behind it.)
   */
  test('showSurface selects the tab of a pane the region already holds', async () => {
    await mount();
    act(() => model?.placeSurface('activity', 'bottom'));
    act(() => model?.placeSurface('chat', 'bottom'));
    await waitFor(() =>
      expect(model?.regions.bottom).toMatchObject({
        panes: ['chat', 'activity'],
        occupant: 'chat',
        visible: true,
      }),
    );
    act(() => model?.setRegion('bottom', { visible: false }));
    await waitFor(() => expect(model?.regions.bottom.visible).toBe(false));

    act(() => model?.showSurface('activity'));

    await waitFor(() =>
      expect(model?.regions.bottom).toMatchObject({
        panes: ['chat', 'activity'],
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(model?.lastShownRegion).toBe('bottom');
    // A select places nothing: Activity did not go to its default `right`.
    expect(model?.regions.right.panes).toEqual([]);
  });

  test('selectPane selects a held pane, ignores one the region does not hold, and shows nothing', async () => {
    await mount();
    act(() => model?.placeSurface('activity', 'bottom'));
    act(() => model?.placeSurface('chat', 'bottom'));
    act(() => model?.setRegion('bottom', { visible: false }));
    await waitFor(() => expect(model?.regions.bottom.visible).toBe(false));

    act(() => model?.selectPane('bottom', 'activity'));
    await waitFor(() =>
      expect(model?.regions.bottom.occupant).toBe('activity'),
    );
    expect(model?.regions.bottom.visible).toBe(false);

    act(() => model?.selectPane('right', 'chat'));
    act(() => model?.selectPane('bottom', 'home'));
    await act(async () => undefined);
    expect(model?.regions.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
    });
    expect(model?.regions.right.panes).toEqual([]);
  });

  test('placeSurface into a region already holding the surface selects it', async () => {
    await mount();
    act(() => model?.placeSurface('activity', 'bottom'));
    await waitFor(() =>
      expect(model?.regions.bottom.occupant).toBe('activity'),
    );

    act(() => model?.placeSurface('chat', 'bottom'));
    await waitFor(() => expect(model?.regions.bottom.occupant).toBe('chat'));
    expect(model?.regions.bottom.panes).toEqual(['chat', 'activity']);
  });
});

describe('RegionModelProvider.toggleSurface', () => {
  test('a surface occupying main returns to its default dock region, visible, and main empties to Home', async () => {
    await mount();
    act(() => model?.placeSurface('activity', 'main'));
    await waitFor(() => expect(model?.regions.main.occupant).toBe('activity'));

    act(() => model?.toggleSurface('activity'));

    await waitFor(() =>
      expect(model?.regions.right).toMatchObject({
        panes: ['activity'],
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(model?.regions.main).toEqual({
      visible: true,
      size: 0,
      maximized: false,
      panes: [],
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
        panes: ['activity'],
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
        panes: ['activity'],
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
