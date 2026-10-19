/** @vitest-environment jsdom */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  supervisesBundledServer: false,
  bundled: null as null | {
    apiBase: string | null;
    canRunInBackground: boolean;
  },
  apiBase: 'http://127.0.0.1:4100',
}));

vi.mock('../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({
    supervisesBundledServer: platform.supervisesBundledServer,
  }),
}));
vi.mock('../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: (enabled: boolean) =>
    enabled ? platform.bundled : null,
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: platform.apiBase }),
}));

import { useStationOutlivesApp } from '../useStationOutlivesApp';

describe('useStationOutlivesApp', () => {
  afterEach(() => {
    platform.supervisesBundledServer = false;
    platform.bundled = null;
  });

  test('a Station reached over the network (web, mobile) outlives the app', () => {
    expect(renderHook(() => useStationOutlivesApp()).result.current).toBe(true);
  });

  test("the desktop's own Station that stops with the app does not", () => {
    platform.supervisesBundledServer = true;
    platform.bundled = {
      apiBase: 'http://127.0.0.1:4100/',
      canRunInBackground: false,
    };
    expect(renderHook(() => useStationOutlivesApp()).result.current).toBe(
      false,
    );
  });

  test('a desktop Station service that keeps running does', () => {
    platform.supervisesBundledServer = true;
    platform.bundled = {
      apiBase: 'http://127.0.0.1:4100',
      canRunInBackground: true,
    };
    expect(renderHook(() => useStationOutlivesApp()).result.current).toBe(true);
  });

  test('a desktop talking to another Station is not bound by its own', () => {
    platform.supervisesBundledServer = true;
    platform.bundled = {
      apiBase: 'http://127.0.0.1:9999',
      canRunInBackground: false,
    };
    expect(renderHook(() => useStationOutlivesApp()).result.current).toBe(true);
  });

  test('a supervised Station with no address (starting, restarting or crashed) is unknown, never safe', () => {
    platform.supervisesBundledServer = true;
    platform.bundled = { apiBase: null, canRunInBackground: false };
    expect(
      renderHook(() => useStationOutlivesApp()).result.current,
    ).toBeUndefined();
  });

  test('not yet reported: unknown, never assumed safe', () => {
    platform.supervisesBundledServer = true;
    platform.bundled = null;
    expect(
      renderHook(() => useStationOutlivesApp()).result.current,
    ).toBeUndefined();
  });
});
