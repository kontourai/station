/**
 * @vitest-environment jsdom
 *
 * #928 step 3b: the region model is the authority for chat placement and
 * visibility; navigation is an outbound mirror plus an inbound seed. While
 * the two agree, an end-to-end "click the control, the dock collapses" test
 * passes whether the chrome reads the model or navigation — it cannot tell
 * them apart.
 *
 * The discriminating case is a DIVERGENCE: write region state directly, leave
 * navigation alone, and assert the chrome follows the region model — for open
 * state and for placement alike.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  settings: {
    chatDockHeight: 320,
    chatDockWidth: 400,
    dockSlotPlacement: 'bottom' as const,
  },
  isDockOpen: true,
  dockMode: 'bottom' as 'left' | 'bottom' | 'right',
  setDeviceSetting: vi.fn(),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    isDockOpen: harness.isDockOpen,
    isDockMaximized: false,
    dockMode: harness.dockMode,
    pathname: '/',
    setDockState: vi.fn(),
    setDockMode: vi.fn(),
    collapseMaximizedDock: vi.fn(),
  }),
  NavigationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: () => {},
}));
vi.mock('../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => harness.settings,
  useDeviceSettingsActions: () => ({
    setDeviceSetting: harness.setDeviceSetting,
  }),
}));

const { RegionModelProvider, useRegionModel } = await import(
  '../contexts/RegionModelContext'
);
const { useDockShellChrome } = await import('../hooks/useDockShellChrome');

describe('useDockShellChrome reads its open state from the region model', () => {
  beforeEach(() => {
    harness.isDockOpen = true;
    harness.dockMode = 'bottom';
  });

  test('follows the region model when it diverges from navigation', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <RegionModelProvider>{children}</RegionModelProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        chrome: useDockShellChrome({
          publishesDockSlotClearance: false,
          registersDockShortcuts: false,
        }),
        model: useRegionModel(),
      }),
      { wrapper },
    );

    // Navigation says open, and the seeded model agrees.
    expect(harness.isDockOpen).toBe(true);
    expect(result.current.chrome.isDockOpen).toBe(true);

    // Diverge: hide the region WITHOUT touching navigation.
    act(() => {
      result.current.model.setRegion('bottom', { visible: false });
    });

    expect(harness.isDockOpen).toBe(true);
    expect(result.current.chrome.isDockOpen).toBe(false);
  });

  // Step 3b makes the region model authoritative; navigation is its durable
  // mirror, so a disagreement is resolved by the model's occupant.
  test('keeps the model as the placement authority when the two disagree', () => {
    harness.dockMode = 'right';
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <RegionModelProvider>{children}</RegionModelProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        chrome: useDockShellChrome({
          publishesDockSlotClearance: false,
          registersDockShortcuts: false,
        }),
        model: useRegionModel(),
      }),
      { wrapper },
    );

    // Seeding uses navigation's resolved placement, so the old device versus
    // navigation split from before #1265 no longer exists. A later model write
    // is authoritative and chrome follows it before the mirror runs.
    expect(result.current.model.regions.right.occupant).toBe('chat');
    act(() => result.current.model.placeSurface('chat', 'left'));
    expect(result.current.chrome.dockMode).toBe('left');
    // Open state still comes from the region that holds chat, not from
    // `regions[dockMode]` — 'right' is unoccupied and seeds `visible: false`.
    expect(result.current.chrome.isDockOpen).toBe(true);
  });

  // The settings-panel choice, drag-to-edge and the "Open chats" route all
  // arrive here with a mode; the model must receive THAT mode, not a fixed
  // one. No DOM path exercises this argument, so it is pinned at the hook.
  test('commitDockPlacement places chat in the region it was given', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <RegionModelProvider>{children}</RegionModelProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        chrome: useDockShellChrome({
          publishesDockSlotClearance: false,
          registersDockShortcuts: false,
        }),
        model: useRegionModel(),
      }),
      { wrapper },
    );
    expect(result.current.model.regions.bottom.occupant).toBe('chat');

    act(() => {
      result.current.chrome.commitDockPlacement('right');
    });

    expect(result.current.model.regions.right.occupant).toBe('chat');
    expect(result.current.model.regions.bottom.occupant).toBeNull();
    expect(result.current.chrome.dockMode).toBe('right');
  });

  test('an explicit regionId reads that region even when chat is elsewhere', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <RegionModelProvider>{children}</RegionModelProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        chrome: useDockShellChrome({
          publishesDockSlotClearance: false,
          registersDockShortcuts: false,
          regionId: 'right',
        }),
        model: useRegionModel(),
      }),
      { wrapper },
    );
    act(() => result.current.model.setRegion('right', { visible: true }));
    expect(result.current.model.regions.bottom.occupant).toBe('chat');
    expect(result.current.chrome.dockMode).toBe('right');
    expect(result.current.chrome.isDockOpen).toBe(true);
  });

  test('a side shell folded to the bottom persists its drag as a bottom height', () => {
    // ≤768px folds every placement to bottom (useIsMobile.ts
    // `availablePlacements`); the dragged value is a height and must not
    // land in the side region's `size`, which mirrors to `chatDockWidth`.
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <RegionModelProvider>{children}</RegionModelProvider>
        </QueryClientProvider>
      );
      const { result } = renderHook(
        () => ({
          chrome: useDockShellChrome({
            publishesDockSlotClearance: false,
            registersDockShortcuts: false,
            regionId: 'right',
          }),
          model: useRegionModel(),
        }),
        { wrapper },
      );
      act(() => result.current.model.placeSurface('chat', 'right'));
      expect(result.current.chrome.effectiveDockSlotPlacement).toBe('bottom');
      act(() => {
        result.current.chrome.setIsDragging(true);
        result.current.chrome.setDockHeight(410);
      });
      act(() => result.current.chrome.setIsDragging(false));
      expect(result.current.model.regions.bottom.size).toBe(410);
      expect(result.current.model.regions.right.size).toBe(400);
    } finally {
      if (innerWidth) Object.defineProperty(window, 'innerWidth', innerWidth);
    }
  });
});
