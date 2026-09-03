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
  bottomOnly: false,
  shortcuts: new Map<
    string,
    {
      id: string;
      key: string;
      modifiers: string[];
      description: string;
      handler: () => void;
    }
  >(),
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
  useDockSlotDevice: () => ({
    viewportWidth: harness.bottomOnly ? 390 : 1024,
    coarsePointer: harness.bottomOnly,
  }),
  availablePlacements: () =>
    harness.bottomOnly ? ['bottom'] : ['left', 'right', 'bottom'],
}));

vi.mock('../../../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: (
    id: string,
    key: string,
    modifiers: string[],
    description: string,
    handler: () => void,
  ) => {
    harness.shortcuts.set(id, { id, key, modifiers, description, handler });
  },
}));

import { RegionToolbarControls } from '../RegionToolbarControls';

describe('RegionToolbarControls', () => {
  beforeEach(() => {
    harness.setDockMode.mockReset();
    harness.setDockState.mockReset();
    harness.setRegion.mockReset();
    harness.placeSurface.mockReset();
    harness.bottomOnly = false;
    harness.shortcuts.clear();
  });

  test('registers both surface shortcuts and toggles or places from their metadata', () => {
    render(<RegionToolbarControls />);

    expect(harness.shortcuts.get('dock.toggle')).toMatchObject({
      id: 'dock.toggle',
      key: 'd',
      modifiers: ['cmd'],
      description: 'Toggle Chat region',
    });
    expect(harness.shortcuts.get('activity.toggle')).toMatchObject({
      key: 'a',
      modifiers: ['cmd', 'shift'],
      description: 'Toggle Activity region',
    });
    harness.shortcuts.get('dock.toggle')?.handler();
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: false,
    });
    expect(harness.regions.bottom.occupant).toBe('chat');

    harness.shortcuts.get('activity.toggle')?.handler();
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'right');

    fireEvent.click(
      screen.getByRole('button', { name: 'Hide Chat Bottom region' }),
    );
    expect(harness.setRegion).toHaveBeenLastCalledWith('bottom', {
      visible: false,
    });
  });

  test('an empty region opens a portalled menu and places either registered surface', () => {
    render(<RegionToolbarControls />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Choose a surface for Left region' }),
    );
    const menu = screen.getByRole('menu', { name: 'Left region surfaces' });
    expect(document.body.contains(menu)).toBe(true);
    expect(
      screen.getByRole('menuitemradio', { name: 'Place Chat here' }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: 'Place Activity here' }),
    );
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'left');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('an occupied region exposes a keyboard-reachable swap menu that dismisses on Escape and outside pointerdown', () => {
    render(<RegionToolbarControls />);

    const trigger = screen.getByRole('button', {
      name: 'Change Bottom region surface',
    });
    trigger.focus();
    fireEvent.click(trigger);
    expect(
      screen.getByRole('menuitemradio', { name: 'Swap in Activity' }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Close Bottom region menu' }),
    );
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('a bottom-only device renders one control per surface and makes either surface the sole visible region', () => {
    harness.bottomOnly = true;
    render(<RegionToolbarControls />);

    expect(screen.getAllByRole('button')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Show Activity' }));
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'right');
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: false,
    });
    expect(harness.setRegion).toHaveBeenCalledWith('right', { visible: true });

    fireEvent.click(screen.getByRole('button', { name: 'Show Chat' }));
    expect(harness.setRegion).toHaveBeenCalledWith('right', { visible: false });
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', { visible: true });
  });
});
