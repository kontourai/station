import {
  encodeLiveSurfaceRecord,
  type LiveSurfaceProducerStatus,
  type LiveSurfaceRecord,
} from '@kontourai/station-contracts/live-surface';
import type {
  DeviceHostSummary,
  MobileDeviceHostFailure,
  MobileDeviceInventory,
  MobileDeviceSession,
  MobileDeviceSummary,
} from '@kontourai/station-contracts/mobile-device';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

/**
 * The Device pane's test harness (#1969, #1970).
 *
 * Deliberately NOT a mock of the SDK query hooks: the pane is mounted over a
 * real `QueryClient` and a stubbed `fetch`, so every fixture below goes
 * through the SDK client's own parser (inventory, sessions, start, open,
 * close, power off) and through the live-surface record decoder (the frame
 * stream). A fixture either parser refuses fails here instead of being
 * quietly believed.
 *
 * Fixtures copy what the service ACCEPTS
 * (`src-server/services/mobile-device/mobile-device-host.ts`): every iOS id
 * is a UDID, a booted Android id is an `emulator-<n>` serial, and a stopped
 * Android row is listed under its AVD name.
 */

const IOS_DEVICE_ID = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
export const ANDROID_DEVICE_ID = 'emulator-5584';

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

export const STOPPED_AVD: MobileDeviceSummary = {
  hostId: 'local',
  platform: 'android',
  deviceId: 'station-test',
  name: 'station-test',
  runtime: 'Android 16',
  booted: false,
};

const OBSERVED_AT = '2026-09-14T10:00:00.000Z';

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

let sessionCounter = 0;
/** A session answer, as the open route returns it. */
export function sessionFor(device: {
  hostId?: string;
  platform: 'ios' | 'android';
  deviceId: string;
  name: string;
  runtime: string;
}): MobileDeviceSession {
  sessionCounter += 1;
  const sessionId = `${String(sessionCounter).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;
  return {
    sessionId,
    surfaceId: `device:${device.platform}:${sessionId}`,
    hostId: device.hostId ?? 'local',
    platform: device.platform,
    deviceId: device.deviceId,
    name: device.name,
    runtime: device.runtime,
    openedAt: new Date().toISOString(),
  };
}

const SCOPE = {
  apiBase: 'http://station.test',
  authorityKey: 'authority-1',
};

export interface DeviceFetchPlan {
  inventory?: MobileDeviceInventory | (() => MobileDeviceInventory);
  inventoryThrows?: Error;
  inventoryStatus?: number;
  /** The open sessions list (the harness keeps it current on open/close). */
  sessions?: MobileDeviceSession[];
  /** A failing answer for the session list reads (read per request). */
  sessionsStatus?: () => number | undefined;
  /** Answer for POST …/start; defaults to an already-running device. */
  start?: () => Promise<
    { deviceId: string; state: 'running' | 'starting' } | { status: number }
  >;
  /** Answer for POST …/sessions; defaults to a fresh session. */
  open?: (target: {
    platform: 'ios' | 'android';
    deviceId: string;
  }) => Promise<MobileDeviceSession | { status: number; code?: string }>;
  /** A non-200 answer for the frames stream (404: the surface is gone). */
  framesStatus?: number;
  /**
   * The Tools drawer's routes (#1971, `…/tools…`): return the answer, or
   * undefined for a request this plan does not model (which then fails).
   */
  tools?: (request: {
    method: string;
    path: string;
    search: URLSearchParams;
    body: unknown;
  }) => { status?: number; body: unknown } | undefined;
  /** The host picker's list (#1973); `local` only by default. */
  hosts?: DeviceHostSummary[];
  /** An SSH device host's inventory, by host id. */
  remoteInventory?: Record<string, MobileDeviceInventory>;
}

export interface OpenFrameStream {
  url: string;
  push(record: LiveSurfaceRecord): Promise<void>;
}

export interface DeviceFetchLog {
  inventoryReads: number;
  requests: { method: string; url: string; body: unknown }[];
  streams: OpenFrameStream[];
  inputs: { epoch: number; events: unknown[] }[];
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const HOST = '(local|ssh-[0-9a-f]{12})';
const DEVICE_ACTION = new RegExp(
  `/hosts/${HOST}/devices/(ios|android)/([^/]+)/([a-z-]+)$`,
);

export function stubDeviceFetch(plan: DeviceFetchPlan = {}): DeviceFetchLog {
  const log: DeviceFetchLog = {
    inventoryReads: 0,
    requests: [],
    streams: [],
    inputs: [],
  };
  const sessions: MobileDeviceSession[] = plan.sessions ?? [];
  const remove = (keep: (session: MobileDeviceSession) => boolean) =>
    sessions.splice(0, sessions.length, ...sessions.filter(keep));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // Route on the PATH: a Project's requests carry `?projectSlug=`.
      const path = new URL(url).pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      log.requests.push({ method, url, body });
      if (path.endsWith('/api/mobile-devices/hosts') && method === 'GET')
        return json({
          success: true,
          data: {
            hosts: plan.hosts ?? [
              { hostId: 'local', label: 'This Station', kind: 'local' },
            ],
          },
        });
      const remote = /\/hosts\/(ssh-[0-9a-f]{12})\/devices$/.exec(path);
      if (remote) {
        log.inventoryReads += 1;
        const data = plan.remoteInventory?.[remote[1]!];
        return data
          ? json({ success: true, data })
          : json({ success: false }, 404);
      }
      if (/\/hosts\/ssh-[0-9a-f]{12}\/sessions$/.test(path) && method === 'GET')
        return json({
          success: true,
          data: {
            sessions: sessions.filter((session) =>
              path.includes(`/hosts/${session.hostId}/`),
            ),
          },
        });
      if (path.endsWith('/hosts/local/devices')) {
        log.inventoryReads += 1;
        if (plan.inventoryThrows) throw plan.inventoryThrows;
        if (plan.inventoryStatus && plan.inventoryStatus >= 400)
          return json({}, plan.inventoryStatus);
        const data =
          typeof plan.inventory === 'function'
            ? plan.inventory()
            : (plan.inventory ?? readyInventory());
        return json({ success: true, data });
      }
      if (
        path.endsWith('/sessions') &&
        method === 'GET' &&
        (plan.sessionsStatus?.() ?? 200) >= 400
      )
        return json(
          { success: false, code: 'hub-unavailable' },
          plan.sessionsStatus?.(),
        );
      if (path.endsWith('/hosts/local/sessions') && method === 'GET')
        return json({
          success: true,
          data: {
            sessions: sessions.filter((session) => session.hostId === 'local'),
          },
        });
      if (plan.tools && /\/devices\/(ios|android)\/[^/]+\/tools/.test(path)) {
        const answer = plan.tools({
          method,
          path,
          search: new URL(url).searchParams,
          body,
        });
        if (answer) return json(answer.body, answer.status ?? 200);
      }
      const device = DEVICE_ACTION.exec(path);
      if (device && method === 'POST') {
        const hostId = device[1]!;
        const platform = device[2] as 'ios' | 'android';
        const deviceId = decodeURIComponent(device[3]!);
        const action = device[4];
        if (action === 'start') {
          const answer = plan.start
            ? await plan.start()
            : { deviceId: 'emulator-5554', state: 'running' as const };
          if ('status' in answer)
            return json({ success: false }, answer.status);
          return json(
            { success: true, data: answer },
            answer.state === 'starting' ? 202 : 200,
          );
        }
        if (action === 'sessions') {
          const answer = plan.open
            ? await plan.open({ platform, deviceId })
            : sessionFor({
                hostId,
                platform,
                deviceId,
                name: platform === 'ios' ? 'iPhone 17 Pro' : 'station-test',
                runtime: platform === 'ios' ? 'iOS 26.5' : 'Android 16',
              });
          if ('status' in answer)
            return json({ success: false, code: answer.code }, answer.status);
          sessions.push(answer);
          return json({ success: true, data: answer });
        }
        if (action === 'power-off') {
          remove((session) => session.deviceId !== deviceId);
          return json({ success: true, data: { poweredOff: true } });
        }
      }
      const closed = new RegExp(`/hosts/${HOST}/sessions/([0-9a-f-]+)$`).exec(
        path,
      );
      if (closed && method === 'DELETE') {
        remove((session) => session.sessionId !== closed[2]);
        return json({ success: true, data: { closed: true } });
      }
      if (path.includes('/api/live-surfaces/') && path.endsWith('/frames')) {
        if (plan.framesStatus)
          return json({ success: false }, plan.framesStatus);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        init?.signal?.addEventListener('abort', () => {
          try {
            controller.error(new DOMException('aborted', 'AbortError'));
          } catch {}
        });
        log.streams.push({
          url,
          push: async (record) => {
            await act(async () => {
              controller.enqueue(encodeLiveSurfaceRecord(record));
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
          },
        });
        return new Response(stream, { status: 200 });
      }
      if (path.includes('/api/live-surfaces/') && path.endsWith('/input')) {
        log.inputs.push(body);
        const surfaceId = decodeURIComponent(path.split('/').at(-2)!);
        return json({
          success: true,
          data: {
            ok: true,
            accepted: body.events.length,
            lease: {
              surfaceId,
              epoch: 1,
              holder: { kind: 'human', principal: 'me', device: 'd' },
              expiresAt: 9e12,
            },
          },
        });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    }),
  );
  return log;
}

/** A state record for `surfaceId`, with the producer status given. */
export function stateRecord(
  surfaceId: string,
  status: LiveSurfaceProducerStatus = {},
): LiveSurfaceRecord {
  return {
    kind: 'state',
    state: {
      surfaceId,
      lease: { surfaceId, epoch: 0, holder: null, expiresAt: null, fence: 0 },
      effectiveParams: {
        maxFps: 15,
        quality: 70,
        maxWidth: 1600,
        maxHeight: 1600,
      },
      viewer: { principal: 'me', device: 'd' },
      wedged: false,
      wedgedSince: null,
      ...status,
    },
  };
}

export function frameRecord(
  surfaceId: string,
  seq = 1,
  size = { width: 390, height: 844 },
): LiveSurfaceRecord {
  return {
    kind: 'frame',
    header: {
      surfaceId,
      seq,
      epoch: 0,
      codec: 'jpeg',
      ...size,
      deviceScaleFactor: 1,
      capturedAt: 1,
    },
    body: new Uint8Array([seq]),
  };
}

export function authorizeScope(scope = SCOPE) {
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: { ...scope, isCurrent: () => true },
  }));
}

/** A click, awaited to the next flush (the repository ships no user-event). */
export async function click(element: Element) {
  fireEvent.click(element);
  await act(async () => {
    await Promise.resolve();
  });
}

export function renderInQueryClient(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
  const utils = render(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
  );
  const rerenderWrapped = (next: ReactElement) =>
    utils.rerender(
      <QueryClientProvider client={client}>{next}</QueryClientProvider>,
    );
  return { ...utils, client, rerenderWrapped };
}
