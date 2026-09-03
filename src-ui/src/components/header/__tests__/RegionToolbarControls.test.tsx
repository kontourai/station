/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from '@testing-library/react';
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
    Object.assign(harness.regions.left, {
      visible: false,
      size: 400,
      occupant: null,
    });
    Object.assign(harness.regions.right, {
      visible: false,
      size: 400,
      occupant: null,
    });
    Object.assign(harness.regions.bottom, {
      visible: true,
      size: 320,
      occupant: 'chat',
    });
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

  test('the Activity chord uses a free region instead of evicting Chat from its preferred region', () => {
    Object.assign(harness.regions.bottom, {
      visible: false,
      occupant: null,
    });
    Object.assign(harness.regions.right, { visible: true, occupant: 'chat' });
    render(<RegionToolbarControls />);

    harness.shortcuts.get('activity.toggle')?.handler();

    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'bottom');
    expect(harness.regions.right.occupant).toBe('chat');
  });

  test('the Activity chord toggles its existing region hidden and visible', () => {
    Object.assign(harness.regions.right, {
      visible: true,
      occupant: 'activity',
    });
    render(<RegionToolbarControls />);

    harness.shortcuts.get('activity.toggle')?.handler();
    expect(harness.setRegion).toHaveBeenLastCalledWith('right', {
      visible: false,
    });
    harness.regions.right.visible = false;
    harness.shortcuts.get('activity.toggle')?.handler();
    expect(harness.setRegion).toHaveBeenLastCalledWith('right', {
      visible: true,
    });
  });

  test('an empty region opens a portalled menu and places either registered surface', () => {
    const { container } = render(<RegionToolbarControls />);

    const trigger = screen.getByRole('button', {
      name: 'Choose a surface for Left region',
    });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-pressed')).toBe(false);
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      right: 760,
    } as DOMRect);
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Left region surfaces' });
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.right).toBe(`${window.innerWidth - 760}px`);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByRole('menuitem', { name: 'Place Chat here' }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Place Activity here' }),
    );
    expect(harness.placeSurface).toHaveBeenCalledWith('activity', 'left');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('an occupied region exposes a keyboard-reachable swap menu that dismisses on Escape and outside pointerdown', () => {
    render(<RegionToolbarControls />);

    const trigger = screen.getByRole('button', {
      name: 'Change Bottom region surface',
    });
    expect(trigger.style.minWidth).toBe('24px');
    expect(trigger.style.minHeight).toBe('24px');
    trigger.focus();
    fireEvent.click(trigger);
    expect(
      screen.getByRole('menuitem', { name: 'Swap in Activity' }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    const underneath = vi.fn();
    const beneath = document.createElement('button');
    beneath.addEventListener('click', underneath);
    document.body.append(beneath);
    fireEvent.click(trigger);
    const backdrop = screen.getByRole('button', {
      name: 'Close Bottom region menu',
    });
    fireEvent.pointerDown(backdrop);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(backdrop);
    expect(underneath).not.toHaveBeenCalled();
    act(() => frameCallbacks.forEach((callback) => callback(0)));
    expect(screen.queryByRole('menu')).toBeNull();
    beneath.remove();
  });

  test('a bottom-only device renders one control per surface and makes either surface the sole visible region', () => {
    harness.bottomOnly = true;
    const { rerender } = render(<RegionToolbarControls />);

    expect(
      screen.getByRole('group', { name: 'Regions' }).querySelectorAll('button'),
    ).toHaveLength(2);
    const chat = screen.getByRole('button', { name: 'Hide Chat' });
    expect(chat.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chat);
    expect(harness.setRegion).toHaveBeenCalledWith('bottom', {
      visible: false,
    });

    harness.setRegion.mockClear();
    harness.regions.bottom.visible = false;
    rerender(<RegionToolbarControls />);
    expect(
      screen
        .getByRole('button', { name: 'Show Chat' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
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
