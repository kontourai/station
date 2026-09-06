/** @vitest-environment jsdom */

/**
 * #1582 D4 (L1): the sidebar's region-surface row reports `aria-pressed` and
 * hides through the model's `toggleSurface`. `ProjectSidebarNav.test.tsx` mocks
 * that model, so it proves the row CALLS the right seam and nothing about what
 * the seam then does.
 *
 * This runs the row against the REAL `RegionModelProvider` and the REAL
 * `toggleSurface`, because the `main`-occupancy path has a two-press shape
 * that a mock cannot show: `toggleSurface`'s `main` case relocates the surface
 * to its `defaultRegion` VISIBLE (#1523 — a chord that "hides" a `main`
 * occupant leaves Home behind rather than doing nothing), so the first press
 * re-docks it and the row stays pressed, truthfully, because the surface is
 * still showing. The second press hides the dock region.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ProjectSidebarNav } from '../../components/project-sidebar/ProjectSidebarNav';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';

vi.mock('../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set<string>(),
}));

let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  model = value;
  return null;
}

function Harness() {
  return (
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
          <ProjectSidebarNav
            collapsed={false}
            isMobile={false}
            navigate={vi.fn()}
            activePath="/"
          />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>
  );
}

function activityRow(): HTMLElement {
  return screen.getByRole('button', { name: 'Activity' });
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
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('the Activity row against the real region model', () => {
  test('a press reveals it and the next press hides it again', async () => {
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(activityRow().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(activityRow().getAttribute('aria-pressed')).toBe('true'),
    );
    expect(model?.regions.right).toMatchObject({
      occupant: 'activity',
      visible: true,
    });

    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(activityRow().getAttribute('aria-pressed')).toBe('false'),
    );
    expect(model?.regions.right.visible).toBe(false);
  });

  // The path `ProjectSidebarNav.test.tsx` cannot execute at all.
  test('from main, the first press re-docks it (still pressed) and the second hides it', async () => {
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    model?.placeSurface('activity', 'main');
    await waitFor(() => expect(model?.regions.main.occupant).toBe('activity'));
    expect(activityRow().getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(model?.regions.right).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );
    // #1523: `main` emptied to Home rather than the surface disappearing, and
    // the row is honest that Activity is still on screen.
    expect(model?.regions.main.occupant).toBeNull();
    expect(activityRow().getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(activityRow().getAttribute('aria-pressed')).toBe('false'),
    );
    expect(model?.regions.right.visible).toBe(false);
  });
});
