/** @vitest-environment jsdom */

import { renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

/**
 * station#3794: these facts are a dependency of the resolved pane catalog's
 * memo, so a fresh object literal here rebuilt `catalog.entries` — and every
 * availability object inside it — on every render of every consumer. That is
 * what made `useCallback(..., [catalog.entries])` inert at the pane-host call
 * site, which is where the cost actually landed.
 */
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ activeConnection: null }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useServerCapabilitiesQuery: () => ({ data: undefined }),
  getDeploymentCapabilityState: () => 'unknown',
}));
vi.mock('../../platform/native', () => ({
  nativePlatformPromise: new Promise(() => {}),
}));
vi.mock('../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => undefined,
}));

import { useWorkspacePaneAvailabilityFacts } from '../workspacePaneAvailabilityAdapters';

describe('workspace pane availability facts', () => {
  test('keeps one identity while the facts themselves are unchanged', () => {
    const { result, rerender } = renderHook(() =>
      useWorkspacePaneAvailabilityFacts(),
    );
    const first = result.current;

    rerender();
    rerender();

    expect(result.current).toBe(first);
  });
});
