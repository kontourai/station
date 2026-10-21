/** @vitest-environment jsdom */

/**
 * Nested suspensions add up (`SuspendRegionSurfaces`): the Coding centre's
 * Chat and a source-hidden preview are suspended by different owners, and an
 * inner owner must never un-suspend what an outer one took. Before the union,
 * the inner provider REPLACED the outer list.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import type { RegionArrangement } from '../../regions/region-model';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import {
  RegionModelProvider,
  SuspendRegionSurfaces,
  useRegionModel,
  useRegionModelOptional,
} from '../RegionModelContext';

const seen: { regions: RegionArrangement | null } = { regions: null };
let model: ReturnType<typeof useRegionModel> | null = null;

function ModelProbe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

function Reader() {
  const value = useRegionModelOptional();
  useEffect(() => {
    seen.regions = value?.regions ?? null;
  }, [value]);
  return null;
}

beforeEach(() => {
  seen.regions = null;
  model = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1280,
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
  vi.unstubAllGlobals();
});

function mount(outer: readonly string[], inner: readonly string[]) {
  return render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <ModelProbe />
          <SuspendRegionSurfaces surfaces={outer}>
            <SuspendRegionSurfaces surfaces={inner}>
              <Reader />
            </SuspendRegionSurfaces>
          </SuspendRegionSurfaces>
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
}

test('an inner suspension adds to the outer one and never lifts it', async () => {
  mount(['chat'], ['activity']);
  await waitFor(() => expect(model).not.toBeNull());
  act(() => {
    model?.placeSurface('activity', 'right');
    model?.setRegion('bottom', { visible: true });
  });
  await waitFor(() => expect(model?.regions.right.panes).toEqual(['activity']));
  // Both owners' surfaces are out of the view; the record still holds them.
  expect(seen.regions?.bottom.panes).toEqual([]);
  expect(seen.regions?.right.panes).toEqual([]);
  expect(model?.regions.bottom.panes).toEqual(['chat']);
});

test('an inner owner with nothing to suspend leaves the outer suspension in force', async () => {
  mount(['chat'], []);
  await waitFor(() => expect(model).not.toBeNull());
  act(() => model?.setRegion('bottom', { visible: true }));
  await waitFor(() => expect(model?.regions.bottom.visible).toBe(true));
  expect(seen.regions?.bottom.panes).toEqual([]);
});
