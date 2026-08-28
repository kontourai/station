/** @vitest-environment jsdom */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  previews: {
    data: undefined as Array<{ id: string; enabled: boolean }> | undefined,
    isLoading: false,
    error: null as Error | null,
  },
  developerToolsEnabled: false,
  appConfig: {} as Record<string, unknown>,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useFeaturePreviewsQuery: () => state.previews,
  useConfigQuery: () => ({
    data: state.appConfig,
    error: null,
    dataUpdatedAt: 1,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({
    developerToolsEnabled: state.developerToolsEnabled,
  }),
}));

import { DEVELOPER_TOOLS_FLAG } from '../../app-shell/surface-registry';
import { useSurfaceVisibilityFlags } from '../useSurfaceVisibilityFlags';

// archive#3313: the one enabled-flags set the sidebar and palette filter
// previewFlag-gated surfaces against — enabled server previews plus the
// developer-tools device setting.
describe('useSurfaceVisibilityFlags', () => {
  beforeEach(() => {
    state.previews = { data: undefined, isLoading: true, error: null };
    state.developerToolsEnabled = false;
    state.appConfig = {};
  });

  test('is empty (fail-closed) while previews are unresolved and developer tools are off', () => {
    const { result } = renderHook(() => useSurfaceVisibilityFlags());
    expect([...result.current]).toEqual([]);
  });

  test('contributes exactly the ENABLED preview ids', () => {
    state.previews = {
      data: [
        { id: 'preview-on', enabled: true },
        { id: 'preview-off', enabled: false },
      ],
      isLoading: false,
      error: null,
    };
    const { result } = renderHook(() => useSurfaceVisibilityFlags());
    expect([...result.current]).toEqual(['preview-on']);
  });

  test('contributes the developer-tools flag from the device setting', () => {
    state.developerToolsEnabled = true;
    const { result } = renderHook(() => useSurfaceVisibilityFlags());
    expect(result.current.has(DEVELOPER_TOOLS_FLAG)).toBe(true);
  });

  // The two sources land in ONE set, so a server preview id that matched the
  // device flag would let an operator enabling a preview turn on a
  // device-scoped surface. The `device:` prefix is what makes that
  // impossible for a bare-slug preview id — this is the assertion that keeps
  // it, and it fails the moment the flag loses its namespace.
  test('a server preview cannot satisfy the device-scoped flag', () => {
    expect(DEVELOPER_TOOLS_FLAG).toMatch(/^device:/);
    state.previews = {
      data: [{ id: 'developer-tools', enabled: true }],
      isLoading: false,
      error: null,
    };
    const { result } = renderHook(() => useSurfaceVisibilityFlags());
    expect(result.current.has(DEVELOPER_TOOLS_FLAG)).toBe(false);
  });
});
