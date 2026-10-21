/** @vitest-environment jsdom */

/**
 * `panesHiddenByReveal` predicts what the model's own reveal of a surface
 * takes off screen, for a caller that must ask those panes' guards BEFORE the
 * reveal. A prediction that drifts from the model asks the wrong pane or
 * hides one unasked, so each case here performs the REAL `showSurface` and
 * requires the prediction to equal what actually left the screen.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import {
  DOCK_REGION_IDS,
  panesHiddenByReveal,
  type RegionArrangement,
} from '../../regions/region-model';
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

function current() {
  if (!model) throw new Error('probe never rendered');
  return model;
}

function onScreen(arrangement: RegionArrangement) {
  return DOCK_REGION_IDS.flatMap((id) => {
    const region = arrangement[id];
    return region.visible && region.occupant ? [region.occupant] : [];
  });
}

function device({ folded }: { folded: boolean }) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: folded ? 390 : 1280,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches:
      folded && (query === MOBILE_MEDIA_QUERY || query === '(pointer: coarse)'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

async function mount() {
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

beforeEach(() => {
  model = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  window.history.replaceState({}, '', '/');
  navigationStore.navigate('/', { dock: null, maximize: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the reveal prediction matches the model’s own reveal of Chat', () => {
  test.each([
    {
      name: 'a hidden Chat beside a shown Activity',
      folded: false,
      hidden: [] as string[],
      arrange: () => current().placeSurface('activity', 'right'),
    },
    {
      name: 'Chat behind Activity’s tab in its own region',
      folded: false,
      hidden: ['activity'],
      arrange: () => {
        navigationStore.navigate('/', { dock: 'open' });
        current().placeSurface('activity', 'bottom');
      },
    },
    {
      name: 'a maximized Chat',
      folded: false,
      hidden: [] as string[],
      arrange: () =>
        navigationStore.navigate('/', { dock: 'open', maximize: 'true' }),
    },
    {
      name: 'a folded device showing another region',
      folded: true,
      hidden: ['workspace-agents'],
      arrange: () => current().placeSurface('workspace-agents', 'right'),
    },
  ])('$name', async ({ folded, hidden, arrange }) => {
    device({ folded });
    await mount();
    act(() => arrange());
    await act(async () => {});
    const before = current().regions;
    const predicted = panesHiddenByReveal(before, 'chat', 'bottom', folded);
    act(() => current().showSurface('chat'));
    await act(async () => {});
    const still = new Set(onScreen(current().regions));
    const actual = onScreen(before).filter(
      (id) => id !== 'chat' && !still.has(id),
    );
    expect(predicted).toEqual(actual);
    expect(actual).toEqual(hidden);
    expect(current().regions.bottom.occupant).toBe('chat');
  });
});
