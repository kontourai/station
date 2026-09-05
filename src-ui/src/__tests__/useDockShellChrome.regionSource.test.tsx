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
import { type ReactNode, useEffect } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  settings: {
    chatDockHeight: 320,
    chatDockWidth: 400,
    dockSlotPlacement: 'bottom' as const,
    regionArrangement: undefined as unknown,
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
    harness.settings.chatDockWidth = 400;
    harness.settings.regionArrangement = undefined;
    harness.setDeviceSetting.mockReset();
  });

  // #928 D, closes #1380: a persisted region size renders. The record says
  // 517 and the legacy key says 400; the shell for that region must show 517.
  test('an Activity shell seeds its width from the persisted region size, not the legacy chatDockWidth', () => {
    harness.settings.regionArrangement = {
      version: 1,
      regions: {
        main: {
          visible: true,
          size: 0,
          occupant: { kind: 'surface', id: 'home' },
        },
        left: { visible: false, size: 400, occupant: null },
        right: {
          visible: true,
          size: 517,
          occupant: { kind: 'surface', id: 'activity' },
        },
        bottom: {
          visible: false,
          size: 320,
          occupant: { kind: 'surface', id: 'chat' },
        },
      },
    };
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
    expect(result.current.model.regions.right.size).toBe(517);
    expect(result.current.chrome.dockWidth).toBe(517);
    // Reading the record never wrote the legacy key.
    expect(harness.setDeviceSetting).not.toHaveBeenCalledWith(
      'chatDockWidth',
      expect.anything(),
    );
  });

  test('without a region model the shell still seeds from the legacy keys', () => {
    harness.settings.chatDockWidth = 444;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useDockShellChrome({
          publishesDockSlotClearance: false,
          registersDockShortcuts: false,
        }),
      { wrapper },
    );
    expect(result.current.dockWidth).toBe(444);
    expect(result.current.dockHeight).toBe(320);
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

  test('an inbound navigation update preserves a second occupied region', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <RegionModelProvider>{children}</RegionModelProvider>
      </QueryClientProvider>
    );
    const { result, rerender } = renderHook(() => useRegionModel(), {
      wrapper,
    });

    act(() =>
      result.current.setRegion('right', {
        occupant: 'fixture',
        visible: true,
      }),
    );
    harness.isDockOpen = false;
    rerender();

    expect(result.current.regions.right.occupant).toBe('fixture');
    expect(result.current.regions.right.visible).toBe(true);
    expect(result.current.regions.bottom.visible).toBe(false);
  });

  test('an inbound dockMode naming Activity does not evict it or move Chat over it', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <RegionModelProvider>{children}</RegionModelProvider>
      </QueryClientProvider>
    );
    const { result, rerender } = renderHook(() => useRegionModel(), {
      wrapper,
    });
    act(() => result.current.placeSurface('activity', 'right'));
    harness.dockMode = 'right';
    rerender();

    expect(result.current.regions.right.occupant).toBe('activity');
    expect(result.current.regions.bottom.occupant).toBe('chat');
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

  // A shell places ITS occupant; a fixture surface's drag-to-edge must move
  // the fixture and leave chat where it is.
  test('a non-chat shell places its own occupant', () => {
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
    act(() =>
      result.current.model.setRegion('right', {
        occupant: 'fixture',
        visible: true,
      }),
    );
    act(() => result.current.chrome.commitDockPlacement('left'));
    expect(result.current.model.regions.left.occupant).toBe('fixture');
    expect(result.current.model.regions.right.occupant).toBeNull();
    expect(result.current.model.regions.bottom.occupant).toBe('chat');
  });

  test('a desktop side shell persists its drag as its own width', () => {
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
    expect(result.current.chrome.effectiveDockSlotPlacement).toBe('right');
    act(() => {
      result.current.chrome.setIsDragging(true);
      result.current.chrome.setDockWidth(410);
    });
    act(() => result.current.chrome.setIsDragging(false));
    expect(result.current.model.regions.right.size).toBe(410);
    expect(result.current.model.regions.left.size).toBe(400);
    expect(result.current.model.regions.bottom.size).toBe(320);
  });

  test('dragging an Activity region never mirrors its width into Chat settings', () => {
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
    act(() => result.current.model.placeSurface('activity', 'right'));
    harness.setDeviceSetting.mockClear();
    act(() => {
      result.current.chrome.setIsDragging(true);
      result.current.chrome.setDockWidth(517);
    });
    act(() => result.current.chrome.setIsDragging(false));

    expect(result.current.model.regions.right.size).toBe(517);
    expect(harness.setDeviceSetting).not.toHaveBeenCalledWith(
      'chatDockWidth',
      517,
    );
  });

  test("Activity collapse and expand never rewrite Chat's persisted snap", () => {
    localStorage.setItem('station.chatDock.snap', 'half');
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
          publishesDockSlotClearance: true,
          registersDockShortcuts: false,
          regionId: 'right',
        }),
        model: useRegionModel(),
      }),
      { wrapper },
    );
    act(() => result.current.model.placeSurface('activity', 'right'));
    expect(result.current.chrome.canMaximize).toBe(false);

    act(() => result.current.chrome.applyDockSnap('collapsed'));
    expect(result.current.chrome.dockSnap).toBe('collapsed');
    expect(localStorage.getItem('station.chatDock.snap')).toBe('half');
    act(() => result.current.chrome.applyDockSnap('half'));
    expect(localStorage.getItem('station.chatDock.snap')).toBe('half');
  });

  test("an Activity shell mounts from the default snap, not Chat's persisted one", () => {
    localStorage.setItem('station.chatDock.snap', 'collapsed');
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // The shell mounts only once Activity holds the region, as RegionShells
    // renders a shell per occupied region.
    function ActivityInRight({ children }: { children: ReactNode }) {
      const model = useRegionModel();
      useEffect(() => {
        if (model.regions.right.occupant !== 'activity')
          model.placeSurface('activity', 'right');
      }, [model]);
      return model.regions.right.occupant === 'activity' ? children : null;
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <RegionModelProvider>
          <ActivityInRight>{children}</ActivityInRight>
        </RegionModelProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useDockShellChrome({
          publishesDockSlotClearance: true,
          registersDockShortcuts: false,
          regionId: 'right',
        }),
      { wrapper },
    );
    expect(result.current.canMaximize).toBe(false);
    expect(result.current.dockSnap).toBe('half');
    expect(localStorage.getItem('station.chatDock.snap')).toBe('collapsed');
  });

  test('a Chat shell folded to bottom persists no drag size: the height belongs to neither region', () => {
    // ≤768px folds every placement to bottom (useIsMobile.ts
    // `availablePlacements`); the dragged value is a height, so it must not
    // land in Activity's bottom region nor in Chat's side region, whose
    // `size` is a width that mirrors to `chatDockWidth`.
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
      act(() => result.current.model.placeSurface('activity', 'right'));
      act(() => result.current.model.placeSurface('activity', 'bottom'));
      expect(result.current.model.regions.bottom.occupant).toBe('activity');
      expect(result.current.model.regions.right.occupant).toBe('chat');
      expect(result.current.chrome.effectiveDockSlotPlacement).toBe('bottom');
      const rightWidthBefore = result.current.model.regions.right.size;
      expect(rightWidthBefore).not.toBe(410);
      act(() => {
        result.current.chrome.setIsDragging(true);
        result.current.chrome.setDockHeight(410);
      });
      act(() => result.current.chrome.setIsDragging(false));
      expect(result.current.model.regions.bottom.size).toBe(320);
      expect(result.current.model.regions.right.size).toBe(rightWidthBefore);
    } finally {
      if (innerWidth) Object.defineProperty(window, 'innerWidth', innerWidth);
    }
  });
});
