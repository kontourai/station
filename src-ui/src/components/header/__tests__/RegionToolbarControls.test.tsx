/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  regions: {
    main: { visible: true, size: 0, occupant: null },
    left: { visible: false, size: 400, occupant: null },
    right: { visible: false, size: 400, occupant: null },
    bottom: { visible: true, size: 320, occupant: 'chat' },
  },
  setDockMode: vi.fn(),
  setDockState: vi.fn(),
  setRegion: vi.fn(),
  placeSurface: vi.fn(),
  shortcut: null as null | {
    id: string;
    key: string;
    modifiers: string[];
    description: string;
    handler: () => void;
  },
}));

vi.mock('../../../contexts/RegionModelContext', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../contexts/RegionModelContext')
    >();
  const { REGION_SURFACE_REGISTRY } = await import(
    '../../../regions/region-model'
  );
  return {
    ...actual,
    useRegionModelOptional: () => ({
      regions: harness.regions,
      surfaces: REGION_SURFACE_REGISTRY,
      setRegion: vi.fn(),
      placeSurface: harness.placeSurface,
    }),
    useRegionModel: () => ({
      regions: harness.regions,
      surfaces: REGION_SURFACE_REGISTRY,
      setRegion: harness.setRegion,
      placeSurface: harness.placeSurface,
    }),
  };
});

vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    dockMode: 'bottom',
    isDockMaximized: false,
    pathname: '/',
    setDockMode: harness.setDockMode,
    setDockState: harness.setDockState,
  }),
}));

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  useDockSlotDevice: () => ({ viewportWidth: 1024, coarsePointer: false }),
  availablePlacements: () => ['left', 'right', 'bottom'],
}));

vi.mock('../../../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: (
    id: string,
    key: string,
    modifiers: string[],
    description: string,
    handler: () => void,
  ) => {
    harness.shortcut = { id, key, modifiers, description, handler };
  },
}));

import { RegionToolbarControls } from '../RegionToolbarControls';

describe('RegionToolbarControls', () => {
  beforeEach(() => {
    harness.setDockMode.mockReset();
    harness.setDockState.mockReset();
    harness.setRegion.mockReset();
    harness.placeSurface.mockReset();
    harness.shortcut = null;
  });

  test('registers the surface shortcut in shell chrome and toggles visibility without replacing its occupant', () => {
    render(<RegionToolbarControls />);

    expect(harness.shortcut).toMatchObject({
      id: 'dock.toggle',
      key: 'd',
      modifiers: ['cmd'],
      description: 'Toggle Chat region',
    });
    harness.shortcut?.handler();
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: false,
    });
    expect(harness.regions.bottom.occupant).toBe('chat');

    fireEvent.click(
      screen.getByRole('button', { name: 'Hide Chat Bottom region' }),
    );
    expect(harness.setRegion).toHaveBeenLastCalledWith('bottom', {
      visible: false,
    });
  });

  test('offers the registered surface in each empty available region', () => {
    render(<RegionToolbarControls />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Place Chat in Left region' }),
    );
    expect(harness.placeSurface).toHaveBeenCalledWith('chat', 'left');
    expect(
      screen.getByRole('button', { name: 'Place Chat in Right region' }),
    ).toBeTruthy();
  });
});
