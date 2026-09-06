/** @vitest-environment jsdom */

/**
 * #917: the coarse device's region commands live in the `⋯` overflow menu,
 * because the toolbar row cannot afford a 44px region control and still keep
 * the Settings gear on a 402px viewport. These assertions are about what the
 * menu offers and what selecting a row does to the region model — the toolbar
 * side (that it renders nothing at those widths) is
 * `RegionToolbarControls.test.tsx`.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  regions: {
    main: { visible: true, size: 0, occupant: null as string | null },
    left: { visible: false, size: 400, occupant: null },
    right: { visible: false, size: 400, occupant: null },
    bottom: { visible: true, size: 320, occupant: 'chat' },
  },
  setRegion: vi.fn(),
  placeSurface: vi.fn(),
  showSurface: vi.fn(),
  toggleSurface: vi.fn(),
  bottomOnly: true,
  isMobile: true,
  hasRegionModel: true,
}));

vi.mock('../../../contexts/RegionModelContext', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../contexts/RegionModelContext')
    >();
  const { REGION_SURFACE_REGISTRY } = await import(
    '../../../regions/region-model'
  );
  const model = () => ({
    regions: harness.regions,
    lastShownRegion: null,
    surfaces: REGION_SURFACE_REGISTRY,
    setRegion: harness.setRegion,
    placeSurface: harness.placeSurface,
    showSurface: harness.showSurface,
    toggleSurface: harness.toggleSurface,
  });
  return {
    ...actual,
    useRegionModelOptional: () => (harness.hasRegionModel ? model() : null),
    useRegionModel: () => model(),
  };
});

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => harness.isMobile,
  useDockSlotDevice: () => ({
    viewportWidth: harness.bottomOnly ? 402 : 1440,
    coarsePointer: harness.bottomOnly,
  }),
  availablePlacements: () =>
    harness.bottomOnly ? ['bottom'] : ['left', 'right', 'bottom'],
}));

vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isDesktop: false }),
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionStatusDot: () => <span data-testid="connection-status" />,
}));

import { OverflowMenu } from '../OverflowMenu';

const onClose = vi.fn();

function renderMenu() {
  return render(
    <OverflowMenu
      isOpen
      connStatus="connected"
      userInitials="ST"
      onClose={onClose}
      onOpenConnections={vi.fn()}
      onOpenHelp={vi.fn()}
      onOpenProfile={vi.fn()}
    />,
  );
}

describe('OverflowMenu region section (#917)', () => {
  beforeEach(() => {
    Object.assign(harness.regions.main, {
      visible: true,
      size: 0,
      occupant: null,
    });
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
    harness.setRegion.mockReset();
    harness.placeSurface.mockReset();
    harness.showSurface.mockReset();
    harness.toggleSurface.mockReset();
    harness.bottomOnly = true;
    harness.isMobile = true;
    harness.hasRegionModel = true;
    onClose.mockReset();
  });

  test('a coarse device gets one row per surface, checked to match what is visible', () => {
    renderMenu();

    const group = screen.getByRole('group', { name: 'Regions' });
    // The verb is the only state a sighted user sees; `aria-pressed` is what
    // an assistive technology reads, and it must agree with the model rather
    // than with the word in the label.
    const hideChat = screen.getByRole('button', {
      name: 'Hide Chat from the dock',
    });
    expect(hideChat.getAttribute('aria-pressed')).toBe('true');
    expect(group.contains(hideChat)).toBe(true);
    const showActivity = screen.getByRole('button', {
      name: 'Show Activity in the dock',
    });
    expect(showActivity.getAttribute('aria-pressed')).toBe('false');
    expect(group.contains(showActivity)).toBe(true);
  });

  test('the region rows follow the menu it already had, never displacing it', () => {
    renderMenu();

    // The existing rows keep their documented order — Connections first,
    // Profile demoted below the tray row, Help after it — because pushing one
    // of them down into a notice band is what archive#3311 was about.
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.app-toolbar__overflow-menu button',
      ),
    ).map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(rows).toEqual([
      'Connections',
      'Profile',
      'Help',
      'Hide Chat from the dock',
      'Show Activity in the dock',
    ]);
  });

  test('a fine pointer gets no region rows, because the toolbar still has them', () => {
    harness.bottomOnly = false;
    harness.isMobile = false;
    renderMenu();

    expect(screen.queryByRole('group', { name: 'Regions' })).toBeNull();
    expect(
      document.querySelectorAll('.app-toolbar__overflow-regions button'),
    ).toHaveLength(0);
    // The rest of the menu is untouched.
    expect(screen.getByRole('button', { name: 'Connections' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Profile' })).toBeTruthy();
  });

  test('a coarse device too wide to be mobile gets no region rows either', () => {
    // chat.css only displays `.app-toolbar__overflow-btn` under the mobile
    // media query, so a landscape tablet never opens this menu. Its region
    // commands stay in the toolbar; putting them here as well would be a
    // second, unreachable copy.
    harness.isMobile = false;
    renderMenu();

    expect(screen.queryByRole('group', { name: 'Regions' })).toBeNull();
    expect(
      document.querySelectorAll('.app-toolbar__overflow-regions button'),
    ).toHaveLength(0);
  });

  test('rendered outside a region model it offers no region rows and does not throw', () => {
    harness.hasRegionModel = false;
    renderMenu();

    expect(
      document.querySelectorAll('.app-toolbar__overflow-regions button'),
    ).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Connections' })).toBeTruthy();
  });

  /** The row issued the model's toggle for `surfaceId`, and nothing else. */
  const expectOnlyToggle = (surfaceId: string) => {
    expect(harness.toggleSurface).toHaveBeenCalledTimes(1);
    expect(harness.toggleSurface).toHaveBeenCalledWith(surfaceId);
    expect(harness.placeSurface).not.toHaveBeenCalled();
    expect(harness.setRegion).not.toHaveBeenCalled();
    expect(harness.showSurface).not.toHaveBeenCalled();
  };

  test('selecting a visible surface issues the model toggle and closes the menu', () => {
    renderMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Hide Chat from the dock' }));

    // Hiding the folded region is the model's decision (`toggleSurface` in
    // region-model.ts); the row issues the command.
    expectOnlyToggle('chat');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('selecting an unplaced surface issues the model toggle; the coarse fold rule is the model’s', () => {
    renderMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Show Activity in the dock' }));

    // Placing it in its default region and closing every other region — a
    // coarse device shows exactly one dock surface at a time — is the model's
    // (`toggleSurface` → `showSurface` → `showSurfaceAlone`, region-model.ts).
    // The row issues that one command and places nothing itself (#1420).
    expectOnlyToggle('activity');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a hidden surface reads as unchecked and its row issues the same toggle', () => {
    harness.regions.bottom.visible = false;
    renderMenu();

    const showChat = screen.getByRole('button', {
      name: 'Show Chat in the dock',
    });
    expect(showChat.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(showChat);
    expectOnlyToggle('chat');
  });

  /**
   * #1523: a surface occupying `main` is neither shown nor hidden by a dock
   * toggle, so its row says what the toggle does — return it to the dock — and
   * claims no pressed state. `Show Activity` here would reveal it where it
   * already is, and the tap would read as nothing happening.
   */
  test('a surface occupying main gets a Move row, not a Show toggle', () => {
    harness.regions.main.occupant = 'activity';
    renderMenu();

    expect(screen.queryByRole('button', { name: 'Show Activity in the dock' })).toBeNull();
    const move = screen.getByRole('button', {
      name: 'Move Activity to the dock',
    });
    expect(move.hasAttribute('aria-pressed')).toBe(false);
    expect(screen.getByRole('group', { name: 'Regions' }).contains(move)).toBe(
      true,
    );
    fireEvent.click(move);
    expectOnlyToggle('activity');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
