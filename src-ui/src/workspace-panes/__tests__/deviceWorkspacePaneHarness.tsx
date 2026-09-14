import type {
  MobileDeviceHostFailure,
  MobileDeviceInventory,
  MobileDeviceSummary,
} from '@kontourai/station-contracts/mobile-device';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

/**
 * The Device pane's test harness (#1969).
 *
 * Deliberately NOT a mock of the SDK query hooks: the pane is mounted over a
 * real `QueryClient` and a stubbed `fetch`, so every fixture below goes
 * through the SDK client's own parser, and a fixture it refuses fails here as
 * a `MobileDeviceRequestError(200)` rather than being quietly believed.
 *
 * What that parser checks is exactly the ENVELOPE and each row's TYPES
 * (`packages/sdk/src/mobile-device.ts`): `hostId === 'local'`, one of the
 * three states, a parseable `observedAt`, at most 256 devices, a `failure`
 * iff `unavailable`, and per row a `platform` literal plus a non-empty,
 * control-character-free `deviceId` / `name` / `runtime` and a boolean
 * `booted`. It does NOT look at id SPELLINGS — `summary` never applies the
 * UDID or `emulator-<n>` rules — so a `deviceId` no real helper would emit
 * passes it silently.
 *
 * Fidelity past that is this file's own job, not something a parser enforces.
 * The fixtures are copied from what the service ACCEPTS
 * (`src-server/services/mobile-device/mobile-device-host.ts`, and the rows in
 * its own test): `runtime` is the helper's `version`, `deviceId` is the
 * helper's `id`, every iOS id is a UDID, and an Android id must be an
 * `emulator-<n>` serial when the row is `booted` — the host applies that rule
 * only to a booted row, so an unbooted Android row under an AVD name is a
 * shape it lists. A fixture that contradicts those rules describes an
 * inventory the server answers `invalid-response` for, so a test built on it
 * proves nothing about a state a reader can reach.
 *
 * That is a statement about which ENVELOPES the server admits, which is all
 * that was probed here (flipping `booted` on a fixed id). It is not a claim
 * about what a real helper emits when a device starts: whether
 * `expo-device-hub` reports a different id once an emulator is booted is not
 * recorded anywhere in this repository and cannot be settled from it.
 */

export const IOS_DEVICE_ID = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
export const ANDROID_DEVICE_ID = 'emulator-5584';

/** A 1x1 PNG — the same bytes the service test captures. */
export const ONE_BY_ONE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDWQAAAAASUVORK5CYII=';

export const IOS_DEVICE: MobileDeviceSummary = {
  hostId: 'local',
  platform: 'ios',
  deviceId: IOS_DEVICE_ID,
  name: 'iPhone 17 Pro',
  runtime: 'iOS 26.5',
  booted: true,
};

export const ANDROID_DEVICE: MobileDeviceSummary = {
  hostId: 'local',
  platform: 'android',
  deviceId: ANDROID_DEVICE_ID,
  name: 'Pixel 10 Pro XL',
  runtime: 'Android 16',
  booted: true,
};

export const OBSERVED_AT = '2026-09-14T10:00:00.000Z';

export function readyInventory(
  devices: MobileDeviceSummary[] = [IOS_DEVICE, ANDROID_DEVICE],
): MobileDeviceInventory {
  return { hostId: 'local', state: 'ready', observedAt: OBSERVED_AT, devices };
}

export function partialInventory(
  devices: MobileDeviceSummary[] = [IOS_DEVICE],
): MobileDeviceInventory {
  return {
    hostId: 'local',
    state: 'partial',
    observedAt: OBSERVED_AT,
    devices,
  };
}

/** Exactly the envelope the service returns from its own catch arm. */
export function unavailableInventory(
  failure: MobileDeviceHostFailure,
): MobileDeviceInventory {
  return {
    hostId: 'local',
    state: 'unavailable',
    observedAt: OBSERVED_AT,
    devices: [],
    failure,
  };
}

export interface CaptureFixture {
  captureId?: string;
  platform?: 'ios' | 'android';
  deviceId?: string;
  capturedAt?: string;
  width?: number;
  height?: number;
}

/**
 * A capture answer. `capturedAt` defaults to the CLOCK, not to a written-down
 * instant: the pane decorates a frame past a 30-second threshold and adds a
 * date once the frame is not from the pane's own day, so any literal here is
 * a fixture that changes meaning on a calendar date — it was "from today"
 * when it was written and is a dated, stale frame from the next day on. A
 * case that needs a specific age passes its own `capturedAt`; the default is
 * a frame that has just been taken.
 */
export function captureBody(fixture: CaptureFixture = {}) {
  const platform = fixture.platform ?? 'ios';
  return {
    captureId: fixture.captureId ?? 'a0ea1f6e-0000-4000-8000-000000000001',
    target: {
      hostId: 'local',
      platform,
      deviceId:
        fixture.deviceId ??
        (platform === 'ios' ? IOS_DEVICE_ID : ANDROID_DEVICE_ID),
    },
    capturedAt: fixture.capturedAt ?? new Date().toISOString(),
    mimeType: 'image/png',
    width: fixture.width ?? 1179,
    height: fixture.height ?? 2556,
    pngBase64: ONE_BY_ONE_PNG,
  };
}

export const SCOPE = {
  apiBase: 'http://station.test',
  authorityKey: 'authority-1',
};

export interface DeviceFetchPlan {
  inventory?: MobileDeviceInventory | (() => MobileDeviceInventory);
  /** A thrown transport failure for the inventory read. */
  inventoryThrows?: Error;
  inventoryStatus?: number;
  /** Successive capture answers; the last one repeats. */
  captures?: ({ status: number } | ReturnType<typeof captureBody>)[];
}

export interface DeviceFetchLog {
  inventoryReads: number;
  captureRequests: string[];
}

export function stubDeviceFetch(plan: DeviceFetchPlan): DeviceFetchLog {
  const log: DeviceFetchLog = { inventoryReads: 0, captureRequests: [] };
  let captureIndex = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/hosts/local/devices')) {
        log.inventoryReads += 1;
        if (plan.inventoryThrows) throw plan.inventoryThrows;
        if (plan.inventoryStatus && plan.inventoryStatus >= 400)
          return new Response('{}', { status: plan.inventoryStatus });
        const body =
          typeof plan.inventory === 'function'
            ? plan.inventory()
            : (plan.inventory ?? readyInventory());
        return new Response(JSON.stringify({ success: true, data: body }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/capture')) {
        log.captureRequests.push(url);
        const answers = plan.captures ?? [captureBody()];
        const answer =
          answers[Math.min(captureIndex, answers.length - 1)] ?? captureBody();
        captureIndex += 1;
        if ('status' in answer)
          return new Response('{}', { status: answer.status });
        return new Response(JSON.stringify({ success: true, data: answer }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  return log;
}

export function authorizeScope(scope = SCOPE) {
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: { ...scope, isCurrent: () => true },
  }));
}

/**
 * A click, awaited to the next flush. `fireEvent` rather than `user-event`:
 * this repository does not ship that package, and every interaction here is
 * an ordinary click on an enabled control.
 */
export async function click(element: Element) {
  fireEvent.click(element);
  await act(async () => {
    await Promise.resolve();
  });
}

export function renderInQueryClient(element: ReactElement) {
  const client = new QueryClient({
    // `retryDelay: 0` as well as `retry: false`: `useApiQuery` passes an
    // explicit `retry: undefined`, which wins over the client default, so a
    // refused read still runs React Query's three retries — just instantly.
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
  );
  // RTL's own `rerender` replaces the ROOT, which would drop the provider and
  // throw "No QueryClient set". This one keeps the same client, which is what
  // a re-render under a changed authority actually looks like.
  const rerenderWrapped = (next: ReactElement) =>
    utils.rerender(
      <QueryClientProvider client={client}>{next}</QueryClientProvider>,
    );
  return { ...utils, client, rerenderWrapped };
}
