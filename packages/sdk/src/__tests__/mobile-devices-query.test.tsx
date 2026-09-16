/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { isCaptureableMobileDeviceTarget } from '../mobile-device';
import {
  mobileDeviceInventoryQueryKey,
  useCaptureMobileDeviceMutation,
  useMobileDeviceInventoryQuery,
} from '../query-domains/mobileDevices';

afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver();
});

const IOS_ID = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';

/** Exactly the envelope `LocalMobileDeviceHost.inventory()` produces. */
function inventoryBody(observedAt = '2026-09-14T10:00:00.000Z') {
  return {
    success: true,
    data: {
      hostId: 'local',
      state: 'ready',
      observedAt,
      devices: [
        {
          hostId: 'local',
          platform: 'ios',
          deviceId: IOS_ID,
          name: 'iPhone 17 Pro',
          runtime: 'iOS 26.5',
          booted: true,
        },
      ],
    },
  };
}

const SCOPE = {
  apiBase: 'http://station.test',
  authorityKey: 'authority-1',
};

/**
 * `requestScope` is enforced, not decorative: the transport refuses a scoped
 * request whose resolver cannot name the authority that settled it. Every
 * test here therefore installs one, which is also what makes the
 * partitioning assertions above mean something at runtime.
 */
function authorizeScope() {
  setClientCredentialResolver(() => ({
    origin: SCOPE.apiBase,
    requestAuthority: { ...SCOPE, isCurrent: () => true },
  }));
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('the mobile-device query domain (#1969)', () => {
  /**
   * Dropping either scope member from `mobileDeviceInventoryQueryKey` reds
   * this: two Stations, or one Station under two principals, would then share
   * a cache entry and one would be served the other's device list.
   */
  test('the inventory key is partitioned by api base AND authority', () => {
    const a = mobileDeviceInventoryQueryKey({
      apiBase: 'http://a.test',
      authorityKey: 'authority-1',
    });
    const b = mobileDeviceInventoryQueryKey({
      apiBase: 'http://b.test',
      authorityKey: 'authority-1',
    });
    const c = mobileDeviceInventoryQueryKey({
      apiBase: 'http://a.test',
      authorityKey: 'authority-2',
    });
    expect(a).toEqual([
      'mobile-device-inventory',
      'http://a.test',
      'authority-1',
    ]);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });

  test('the inventory query reads the scope-bound host and returns the parsed inventory', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        'http://station.test/api/mobile-devices/hosts/local/devices',
      );
      return new Response(JSON.stringify(inventoryBody()), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    authorizeScope();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result, unmount } = renderHook(
      () => useMobileDeviceInventoryQuery(SCOPE),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.devices).toHaveLength(1);
    expect(result.current.data?.devices[0]?.deviceId).toBe(IOS_ID);
    unmount();
  });

  /**
   * The read-only POST rule: a capture changes no server state, so the
   * mutation must not broadcast a data-change invalidation. Adding
   * `invalidateKeys: [mobileDeviceInventoryQueryKey(scope)]` to the mutation
   * makes the settled inventory query refetch and reds the request count
   * here.
   */
  test('a capture does not invalidate the inventory query', async () => {
    let inventoryReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/hosts/local/devices')) {
          inventoryReads += 1;
          return new Response(JSON.stringify(inventoryBody()), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              captureId: 'capture-1',
              target: { hostId: 'local', platform: 'ios', deviceId: IOS_ID },
              capturedAt: '2026-09-14T10:00:05.000Z',
              mimeType: 'image/png',
              width: 1,
              height: 1,
              pngBase64:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDWQAAAAASUVORK5CYII=',
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    authorizeScope();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const scope = SCOPE;
    const { result, unmount } = renderHook(
      () => ({
        inventory: useMobileDeviceInventoryQuery(scope),
        capture: useCaptureMobileDeviceMutation(scope),
      }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.inventory.isSuccess).toBe(true));
    expect(inventoryReads).toBe(1);

    await result.current.capture.mutateAsync({
      hostId: 'local',
      platform: 'ios',
      deviceId: IOS_ID,
    });
    await waitFor(() => expect(result.current.capture.isSuccess).toBe(true));
    // Give an invalidation, if one existed, a turn to land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inventoryReads).toBe(1);
    unmount();
  });
});

describe('isCaptureableMobileDeviceTarget (#1969)', () => {
  /**
   * The predicate the pane asks BEFORE offering the press. Loosening the
   * Android arm to the host's wider listing rule would make the third case
   * true — which is a change to this validator and its own review, not
   * something a consumer may decide.
   */
  test('accepts the spellings the client will send and refuses the rest', () => {
    expect(
      isCaptureableMobileDeviceTarget({
        hostId: 'local',
        platform: 'ios',
        deviceId: IOS_ID,
      }),
    ).toBe(true);
    expect(
      isCaptureableMobileDeviceTarget({
        hostId: 'local',
        platform: 'android',
        deviceId: 'emulator-5584',
      }),
    ).toBe(true);
    // A host may legitimately LIST this (the emulator-serial spelling is
    // enforced only for a booted Android device) and this client will not
    // send it.
    expect(
      isCaptureableMobileDeviceTarget({
        hostId: 'local',
        platform: 'android',
        deviceId: 'Pixel_9_API_36',
      }),
    ).toBe(false);
    expect(
      isCaptureableMobileDeviceTarget({
        hostId: 'local',
        platform: 'ios',
        deviceId: 'not-a-udid',
      }),
    ).toBe(false);
    expect(
      isCaptureableMobileDeviceTarget({
        hostId: 'remote',
        platform: 'ios',
        deviceId: IOS_ID,
      }),
    ).toBe(false);
  });
});
