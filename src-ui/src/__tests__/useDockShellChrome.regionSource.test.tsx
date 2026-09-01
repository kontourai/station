/**
 * @vitest-environment jsdom
 *
 * #928 step 3a moves the dock's render path onto the region model. While the
 * model still derives from the legacy dock the two agree, so an end-to-end
 * "click the control, the dock collapses" test passes whether the chrome reads
 * the model or navigation — it cannot tell the two apart.
 *
 * The discriminating case is a DIVERGENCE: write region state directly, leave
 * navigation alone, and assert the chrome follows the region model. That is
 * the property this step actually establishes, and the one the next step (the
 * writer flip) depends on.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  settings: {
    chatDockHeight: 320,
    chatDockWidth: 400,
    dockSlotPlacement: 'bottom' as const,
  },
  isDockOpen: true,
  setDeviceSetting: vi.fn(),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    isDockOpen: harness.isDockOpen,
    isDockMaximized: false,
    dockMode: 'bottom' as const,
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
        chrome: useDockShellChrome({}),
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
});
