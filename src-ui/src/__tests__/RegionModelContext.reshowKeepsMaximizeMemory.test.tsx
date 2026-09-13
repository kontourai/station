/**
 * @vitest-environment jsdom
 *
 * #1563: hiding a maximized Chat keeps `lastDockMaximized` (archive#945) so a
 * later `focusSession` restore can reopen it at Full — and the NEXT show must
 * not discard that memory. The defect was in the Chat mirror: a plain re-show
 * forwarded the hidden region's `maximized` (always false, `updateRegion`
 * clears it with the hide) into `setDockState`, whose defined argument
 * overwrites the memory.
 *
 * These drive the real navigation singleton through `window.history` (the
 * surface production code uses) under the real `RegionModelProvider`, so the
 * assertion is on the memory itself rather than on a spy's argument list.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  settings: {
    chatDockHeight: 320,
    chatDockWidth: 400,
    dockSlotPlacement: 'bottom' as const,
    regionArrangement: undefined as unknown,
  },
  setDeviceSetting: vi.fn(),
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

const { NavigationProvider, navigationStore } = await import(
  '../contexts/NavigationContext'
);
const { RegionModelProvider, useRegionModel } = await import(
  '../contexts/RegionModelContext'
);

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <NavigationProvider>
        <RegionModelProvider>{children}</RegionModelProvider>
      </NavigationProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useRegionModel(), { wrapper });
}

const snapshot = () => navigationStore.getSnapshot();

describe('re-showing a hidden Chat region keeps lastDockMaximized (#1563)', () => {
  beforeEach(() => {
    harness.settings.regionArrangement = undefined;
    harness.setDeviceSetting.mockReset();
    window.history.replaceState({}, '', '/?dock=open');
    // The singleton persists across tests and `lastDockMaximized` only ever
    // moves back to false through `setDockState` (its field doc): an explicit
    // docked open is the reset.
    navigationStore.navigate('/', { dock: 'open', maximize: null });
    navigationStore.setDockState(true, false);
    expect(navigationStore.lastDockMaximized).toBe(false);
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  test('hide from Full, then show: the show leaves the memory alone and the restore reopens at Full', () => {
    const { result } = mount();
    expect(result.current.regions.bottom.occupant).toBe('chat');
    expect(result.current.regions.bottom.visible).toBe(true);

    act(() => result.current.setRegion('bottom', { maximized: true }));
    expect(snapshot().isDockMaximized).toBe(true);
    expect(navigationStore.lastDockMaximized).toBe(true);

    // The close forwards the maximize it closes FROM (archive#945).
    act(() => result.current.setRegion('bottom', { visible: false }));
    expect(snapshot().isDockOpen).toBe(false);
    expect(snapshot().isDockMaximized).toBe(false);
    expect(result.current.regions.bottom.maximized).toBe(false);
    expect(navigationStore.lastDockMaximized).toBe(true);

    // The very next show opens docked (the region's flag was cleared by the
    // hide and the show forwards nothing), and the memory the close kept is
    // still there for a restore.
    act(() => result.current.setRegion('bottom', { visible: true }));
    expect(snapshot().isDockOpen).toBe(true);
    expect(snapshot().isDockMaximized).toBe(false);
    expect(result.current.regions.bottom.maximized).toBe(false);
    expect(navigationStore.lastDockMaximized).toBe(true);

    // `focusSession`'s restore (`useChatDockActions`) speaks navigation; the
    // region follows it.
    act(() =>
      navigationStore.setDockState(true, navigationStore.lastDockMaximized),
    );
    expect(snapshot().isDockMaximized).toBe(true);
    expect(result.current.regions.bottom.maximized).toBe(true);
  });

  test('a close from Docked still forgets: the memory tracks the state the user last closed', () => {
    const { result } = mount();
    act(() => result.current.setRegion('bottom', { maximized: true }));
    act(() => result.current.setRegion('bottom', { visible: false }));
    act(() => result.current.setRegion('bottom', { visible: true }));
    expect(navigationStore.lastDockMaximized).toBe(true);

    // Re-shown docked and closed docked: the close forwards false.
    act(() => result.current.setRegion('bottom', { visible: false }));
    expect(navigationStore.lastDockMaximized).toBe(false);
  });

  test('a maximize param present without dock=open is re-seeded on the show, so Chat opens at Full', () => {
    // A hand-typed or shared `?maximize=true` link with no `dock=open`:
    // `parseUrl` reads the param independently of `dock`, so the state
    // arrives already formed rather than through a write. #1613 closed the
    // write routes into it (a `dock: null` write through `updateParams` or
    // `navigate` now deletes `maximize`), which is why this sets the URL
    // directly. The show forwards nothing, the param stays, and the inbound
    // effect re-seeds the region from it.
    window.history.replaceState({}, '', '/?maximize=true');
    navigationStore.navigate('/', {});
    expect(snapshot().isDockOpen).toBe(false);
    expect(snapshot().isDockMaximized).toBe(true);
    const { result } = mount();
    expect(result.current.regions.bottom.visible).toBe(false);
    expect(result.current.regions.bottom.maximized).toBe(false);

    act(() => result.current.setRegion('bottom', { visible: true }));
    expect(snapshot().isDockOpen).toBe(true);
    expect(snapshot().isDockMaximized).toBe(true);
    expect(result.current.regions.bottom.maximized).toBe(true);
    expect(navigationStore.lastDockMaximized).toBe(true);
  });

  test('a show that is also a maximize forwards it', () => {
    const { result } = mount();
    act(() => result.current.setRegion('bottom', { visible: false }));
    expect(snapshot().isDockOpen).toBe(false);

    act(() =>
      result.current.setRegion('bottom', { visible: true, maximized: true }),
    );
    expect(snapshot().isDockOpen).toBe(true);
    expect(snapshot().isDockMaximized).toBe(true);
    expect(navigationStore.lastDockMaximized).toBe(true);
  });
});
