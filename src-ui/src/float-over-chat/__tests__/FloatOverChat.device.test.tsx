// @vitest-environment jsdom

/**
 * #90 D9, the Device source: a device session floated over the chat by a
 * person ("Float over chat" in the Device pane — no agent can open or drive
 * a device surface today, so nothing auto-floats one). Through the REAL
 * shell and live view: the request, the host-scoped and access-filtered
 * session read, hiding while a pane shows the same device, the pill's
 * control indicator and Take control through the surface's own lease, and
 * "Open in right panel".
 */

import {
  encodeLiveSurfaceRecord,
  type LiveSurfaceControlLease,
} from '@kontourai/station-contracts/live-surface';
import type { MobileDeviceSession } from '@kontourai/station-contracts/mobile-device';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const SCOPE = { apiBase: 'http://station.test', authorityKey: 'authority-1' };
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
  }),
}));
vi.mock('../../hooks/useFeatureSettings', () => ({
  useFeatureSettings: () => ({ settings: {} }),
}));
const openDevice = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/useOpenInRegion', () => ({
  useOpenBrowserSessionInRegion: () => null,
  describeOpenInRegionRefusal: (reason: string) => reason,
}));
vi.mock('../../contexts/useOpenDeviceInRegion', () => ({
  useOpenDeviceInRegion: () => openDevice,
}));

import FloatOverChat from '../FloatOverChat';
import { deviceFloatSourceKey } from '../floatSource';
import {
  getFloatingSource,
  isFloatHostAvailable,
  requestFloat,
  resetFloatStoreForTests,
} from '../floatStore';
import { announceShownSource } from '../shownSources';

const HOST = 'ssh-0123456789ab';
const DEVICE_ID = '5A1C2E3F-0B1D-4C6E-8F9A-0123456789AB';
const SURFACE = 'device:ios:00000001-aaaa-4bbb-8ccc-dddddddddddd';
const FRAMES = `/api/live-surfaces/${encodeURIComponent(SURFACE)}/frames`;
const LEASE = `/api/live-surfaces/${encodeURIComponent(SURFACE)}/lease`;
const INPUT = `/api/live-surfaces/${encodeURIComponent(SURFACE)}/input`;
const SESSIONS = `/api/mobile-devices/hosts/${HOST}/sessions`;

const SESSION: MobileDeviceSession = {
  sessionId: '00000001-aaaa-4bbb-8ccc-dddddddddddd',
  surfaceId: SURFACE,
  hostId: HOST,
  platform: 'ios',
  deviceId: DEVICE_ID,
  name: 'iPhone 17 Pro',
  runtime: 'iOS 26.5',
  openedAt: '2026-09-23T12:00:00.000Z',
};

const SOURCE = {
  kind: 'device' as const,
  hostId: HOST,
  platform: 'ios' as const,
  deviceId: DEVICE_ID,
  surfaceId: SURFACE,
  projectSlug: 'alpha',
  name: 'iPhone 17 Pro',
};

const ME = { principal: 'human:local:me', device: 'device:mine' };
const SOMEONE = { principal: 'human:local:other', device: 'device:theirs' };

function lease(
  holder: LiveSurfaceControlLease['holder'],
): LiveSurfaceControlLease {
  return {
    surfaceId: SURFACE,
    epoch: 3,
    holder,
    expiresAt: holder ? 9e12 : null,
  };
}

let push: (holder: LiveSurfaceControlLease['holder']) => Promise<void>;
let pushFrame: () => Promise<void>;
let calls: string[] = [];
/** What the host's session route answers: the rows this viewer may view. */
let listed: unknown[] = [SESSION];
/** Overrides the session route (a refusal, a busy host, a Project rule). */
let sessionsAnswer: ((url: URL) => Response | undefined) | null = null;
/** Whether this Station has a browser with an agent driving it here. */
let browserOn = false;
const BROWSER_SESSION = 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77';

function transport() {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname === SESSIONS) {
      const answer = sessionsAnswer?.(url);
      if (answer) return answer;
      return Response.json({ success: true, data: { sessions: listed } });
    }
    if (browserOn && url.pathname === '/api/browser/projects/alpha/access')
      return Response.json({
        success: true,
        data: {
          projectId: 'p-alpha',
          role: 'operator',
          principalKey: 'operator',
          operator: true,
          browser: 'ready',
        },
      });
    if (browserOn && url.pathname === '/api/browser/sessions')
      return Response.json({
        success: true,
        data: [
          {
            browserSessionId: BROWSER_SESSION,
            projectId: 'p-alpha',
            projectSlug: 'alpha',
            principalKey: 'operator',
            reach: 'operator',
            threadId: 'conversation-1',
            url: 'https://example.com/',
            viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
            generation: 1,
            state: 'live',
            createdAt: '2026-09-22T12:00:00.000Z',
            updatedAt: '2026-09-22T12:00:00.000Z',
            history: { entries: [], total: 0 },
            activity: {
              agentDriven: true,
              lastDriver: { kind: 'agent', sessionId: 'agent-1' },
            },
            surfaceId: 'browser:0f8f7c1e:g1',
          },
        ],
      });
    if (url.pathname === INPUT)
      return Response.json({
        success: true,
        data: { ok: true, accepted: 1, lease: lease({ kind: 'human', ...ME }) },
      });
    if (url.pathname === LEASE)
      return Response.json({
        success: true,
        data: { ok: true, lease: lease({ kind: 'human', ...ME }) },
      });
    if (url.pathname === FRAMES) {
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
      push = async (holder) => {
        await act(async () => {
          controller.enqueue(
            encodeLiveSurfaceRecord({
              kind: 'state',
              state: {
                surfaceId: SURFACE,
                lease: lease(holder),
                effectiveParams: {
                  maxFps: 10,
                  quality: 70,
                  maxWidth: 1280,
                  maxHeight: 1280,
                },
                viewer: ME,
              },
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
      pushFrame = async () => {
        await act(async () => {
          controller.enqueue(
            encodeLiveSurfaceRecord({
              kind: 'frame',
              header: {
                surfaceId: SURFACE,
                seq: 1,
                epoch: 3,
                codec: 'jpeg',
                width: 1206,
                height: 2622,
                deviceScaleFactor: 1,
                capturedAt: 1,
              },
              body: new Uint8Array([1]),
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
      return new Response(stream, { status: 200 });
    }
    // The browser routes: no browser on this Station.
    return Response.json({ success: false }, { status: 404 });
  });
}

function chatArea() {
  const area = document.createElement('div');
  document.body.appendChild(area);
  area.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 900,
      height: 700,
      right: 900,
      bottom: 700,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return area;
}

function renderChat(projectSlug = 'alpha') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FloatOverChat
        session={{
          id: 'tab-1',
          conversationId: 'conversation-1',
          projectSlug,
        }}
        transport={transport() as never}
      />
    </QueryClientProvider>,
    { container: chatArea() },
  );
}

/** The chat's floater mounts lazily; wait until it can take a request. */
async function floatDevice(source: typeof SOURCE = SOURCE) {
  await waitFor(() => expect(isFloatHostAvailable()).toBe(true));
  await act(async () => {
    expect(requestFloat(source)).toBe(true);
  });
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1206, height: 2622, close() {} })),
  );
  vi.spyOn(
    HTMLCanvasElement.prototype,
    'getBoundingClientRect',
  ).mockReturnValue({
    left: 0,
    top: 0,
    width: 150,
    height: 320,
    right: 150,
    bottom: 320,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  window.localStorage.clear();
  resetFloatStoreForTests();
  calls = [];
  listed = [SESSION];
  sessionsAnswer = null;
  browserOn = false;
  openDevice.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('no chat mounted: a Float over chat request is refused, not queued', () => {
  expect(isFloatHostAvailable()).toBe(false);
  expect(requestFloat(SOURCE)).toBe(false);
});

test('a requested device floats, read from ITS host with the chat’s Project, and the pill claims through the surface’s lease', async () => {
  renderChat();
  await floatDevice();
  await screen.findByTestId('live-surface-canvas');
  // Host-scoped: the session read names the device's host (and the Project,
  // for D12 shares); nothing is read from any other host.
  expect(calls).toContain(`GET ${SESSIONS}?projectSlug=alpha`);
  expect(calls.filter((call) => call.includes('/api/mobile-devices/'))).toEqual(
    calls.filter((call) =>
      call.startsWith(`GET /api/mobile-devices/hosts/${HOST}/sessions`),
    ),
  );
  // The live view asks for the surface as the chat's Project.
  expect(calls.some((call) => call.startsWith(`GET ${FRAMES}?`))).toBe(true);
  expect(calls.find((call) => call.startsWith(`GET ${FRAMES}`))).toContain(
    'projectSlug=alpha',
  );
  screen.getByRole('region', { name: 'Floating device: iPhone 17 Pro' });

  // Who is driving is DERIVED from the lease the live view reads: another
  // person holds it here.
  await push({ kind: 'human', ...SOMEONE });
  await pushFrame();
  const dot = await screen.findByRole('button', {
    name: 'Floating device controls. Someone else is in control.',
  });
  // Nothing reaches the device before Take control (no bypass by a tap).
  const canvas = screen.getByTestId('live-surface-canvas');
  fireEvent.pointerDown(canvas, {
    clientX: 5,
    clientY: 5,
    button: 0,
    pointerId: 1,
  });
  fireEvent.pointerUp(canvas, {
    clientX: 5,
    clientY: 5,
    button: 0,
    pointerId: 1,
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls.some((call) => call.startsWith(`POST ${INPUT}`))).toBe(false);

  fireEvent.click(dot);
  const pill = screen.getByRole('toolbar', { name: 'Floating device' });
  within(pill).getByText('Someone else is in control');
  const take = within(pill).getByRole('button', { name: 'Take control' });
  // One Take control on the page: the canvas's own is not drawn too.
  expect(screen.getAllByRole('button', { name: 'Take control' })).toHaveLength(
    1,
  );
  await act(async () => {
    fireEvent.click(take);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls.some((call) => call.startsWith(`POST ${LEASE}`))).toBe(true);
  expect(
    screen.getByRole('button', {
      name: 'Floating device controls. You are in control.',
    }).dataset.tone,
  ).toBe('you');
  // One stream for the surface: the pill read the canvas's, it opened none.
  expect(calls.filter((call) => call.startsWith(`GET ${FRAMES}`))).toHaveLength(
    1,
  );
  // Now a tap reaches the device.
  fireEvent.pointerDown(canvas, {
    clientX: 5,
    clientY: 5,
    button: 0,
    pointerId: 1,
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls.some((call) => call.startsWith(`POST ${INPUT}`))).toBe(true);
});

test('hidden while a pane shows the SAME device, and back when it stops; another device does not hide it', async () => {
  renderChat();
  await floatDevice();
  await screen.findByTestId('live-surface-canvas');
  let release!: () => void;
  act(() => {
    release = announceShownSource(deviceFloatSourceKey(SOURCE));
  });
  expect(screen.queryByTestId('live-surface-canvas')).toBeNull();
  expect(
    screen.queryByRole('region', { name: /^Floating device:/ }),
  ).toBeNull();
  // Still the conversation's floater: hidden, not closed.
  expect(getFloatingSource('conversation-1')).toEqual(SOURCE);
  act(() => release());
  await screen.findByTestId('live-surface-canvas');
  // The same device id on ANOTHER host (or platform) is another device.
  act(() => {
    release = announceShownSource(
      deviceFloatSourceKey({ ...SOURCE, hostId: 'local' }),
    );
  });
  expect(screen.getByTestId('live-surface-canvas')).toBeTruthy();
  act(() => release());
});

test('a device this viewer may not view (absent from its host’s filtered list) is never shown, and the floater goes', async () => {
  listed = [];
  renderChat();
  await floatDevice();
  await waitFor(() => expect(getFloatingSource('conversation-1')).toBeNull());
  expect(screen.queryByTestId('live-surface-canvas')).toBeNull();
  expect(calls.some((call) => call.startsWith(`GET ${FRAMES}`))).toBe(false);
});

test('a row claiming another host is not trusted: nothing is shown', async () => {
  listed = [{ ...SESSION, hostId: 'local' }];
  renderChat();
  await floatDevice();
  await waitFor(() =>
    expect(calls).toContain(`GET ${SESSIONS}?projectSlug=alpha`),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.queryByTestId('live-surface-canvas')).toBeNull();
  expect(calls.some((call) => call.startsWith(`GET ${FRAMES}`))).toBe(false);
});

test('Open in right panel opens the Device pane on this device and hands the float off', async () => {
  openDevice.mockReturnValue({ ok: true });
  renderChat();
  await floatDevice();
  await screen.findByTestId('live-surface-canvas');
  fireEvent.click(
    screen.getByRole('button', {
      name: /^Floating device controls\./,
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open in right panel' }));
  expect(openDevice).toHaveBeenCalledWith(
    SCOPE,
    { hostId: HOST, platform: 'ios', deviceId: DEVICE_ID },
    { region: 'right' },
  );
  expect(getFloatingSource('conversation-1')).toBeNull();
});

const refusal = (status: number, code: string) => () =>
  Response.json({ success: false, code }, { status });

test.each([
  [
    '403 (not viewable under that Project)',
    refusal(403, 'access-denied'),
    'You cannot view iPhone 17 Pro from here, so it is not floating.',
  ],
  [
    '404',
    refusal(404, 'unknown-session'),
    'The device host for iPhone 17 Pro is not available, so it is not floating.',
  ],
  [
    '503 unavailable (a removed or unknown host)',
    refusal(503, 'unavailable'),
    'The device host for iPhone 17 Pro is not available, so it is not floating.',
  ],
  [
    'a row naming another host',
    () =>
      Response.json({
        success: true,
        data: { sessions: [{ ...SESSION, hostId: 'local' }] },
      }),
    'The device host for iPhone 17 Pro answered with sessions Station could not trust, so it is not floating.',
  ],
])(
  'M1: %s closes the floater, says why, and browser auto-float resumes',
  async (_name, answer, notice) => {
    browserOn = true;
    sessionsAnswer = answer;
    renderChat();
    await floatDevice();
    expect(await screen.findByText(notice)).toBeTruthy();
    // Not this conversation's floater any more (nothing invisible lingers)…
    expect(
      screen.queryByRole('region', { name: /^Floating device:/ }),
    ).toBeNull();
    // …and the chat's browser auto-float runs again: the agent's browser
    // session floats here.
    await waitFor(() =>
      expect(getFloatingSource('conversation-1')).toMatchObject({
        kind: 'browser',
        browserSessionId: BROWSER_SESSION,
      }),
    );
  },
);

test('M1: a BUSY host (503 device-host-busy) keeps the floater, visibly waiting and closable', async () => {
  sessionsAnswer = refusal(503, 'device-host-busy');
  renderChat();
  await floatDevice();
  const player = await screen.findByRole('region', {
    name: 'Floating device: iPhone 17 Pro',
  });
  within(player).getByText('Waiting for the device host to answer…');
  expect(getFloatingSource('conversation-1')).toEqual(SOURCE);
  fireEvent.click(
    within(player).getByRole('button', { name: /^Floating device controls\./ }),
  );
  fireEvent.click(
    within(player).getByRole('button', { name: 'Close floating device' }),
  );
  expect(getFloatingSource('conversation-1')).toBeNull();
});

test('M2: a device shared with Project A floats and shows in a chat in Project B (read under A)', async () => {
  // A non-operator whose share is in alpha only: the route answers alpha,
  // refuses any other Project.
  sessionsAnswer = (url) =>
    url.searchParams.get('projectSlug') === 'alpha'
      ? undefined
      : Response.json(
          { success: false, code: 'access-denied' },
          { status: 403 },
        );
  renderChat('bravo');
  await floatDevice();
  await screen.findByTestId('live-surface-canvas');
  expect(calls).toContain(`GET ${SESSIONS}?projectSlug=alpha`);
  expect(
    calls.some(
      (call) =>
        call.includes('projectSlug=bravo') && call.includes('/mobile-devices/'),
    ),
  ).toBe(false);
  expect(calls.find((call) => call.startsWith(`GET ${FRAMES}`))).toContain(
    'projectSlug=alpha',
  );
});

test('M2: a device its Project cannot view here is not lost silently: the chat says so', async () => {
  sessionsAnswer = refusal(403, 'access-denied');
  renderChat('bravo');
  await floatDevice({ ...SOURCE, projectSlug: 'charlie' });
  expect(
    await screen.findByText(
      'You cannot view iPhone 17 Pro from here, so it is not floating.',
    ),
  ).toBeTruthy();
  expect(screen.queryByTestId('live-surface-canvas')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(
    screen.queryByText(
      'You cannot view iPhone 17 Pro from here, so it is not floating.',
    ),
  ).toBeNull();
});

test('M2: the float acknowledges only once a chat has TAKEN the request', async () => {
  const taken = vi.fn();
  renderChat();
  await waitFor(() => expect(isFloatHostAvailable()).toBe(true));
  await act(async () => {
    expect(requestFloat(SOURCE, taken)).toBe(true);
  });
  expect(taken).toHaveBeenCalledTimes(1);
  expect(getFloatingSource('conversation-1')).toEqual(SOURCE);
});

test('a person’s float is not replaced by an auto-float decided in the same commit', async () => {
  browserOn = true;
  // The agent's browser session is listed, but a pane shows it, so nothing
  // auto-floats and this conversation has no floater yet.
  let releaseBrowser!: () => void;
  act(() => {
    releaseBrowser = announceShownSource(`browser:${BROWSER_SESSION}`);
  });
  renderChat();
  await waitFor(() =>
    expect(calls).toContain('GET /api/browser/sessions?projectSlug=alpha'),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(getFloatingSource('conversation-1')).toBeNull();
  // In ONE commit: the pane stops showing the browser (auto-float would now
  // pick it) and the person asks for the device. The person's float wins.
  await act(async () => {
    releaseBrowser();
    expect(requestFloat(SOURCE)).toBe(true);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(getFloatingSource('conversation-1')).toEqual(SOURCE);
});

const DEVICE_E = '7B2C3D4E-1F2A-4B3C-9D8E-0123456789CD';
const SURFACE_E = 'device:ios:00000002-aaaa-4bbb-8ccc-dddddddddddd';
const SESSION_E: MobileDeviceSession = {
  ...SESSION,
  sessionId: '00000002-aaaa-4bbb-8ccc-dddddddddddd',
  surfaceId: SURFACE_E,
  deviceId: DEVICE_E,
  name: 'iPhone Air',
};
const SOURCE_E = {
  ...SOURCE,
  deviceId: DEVICE_E,
  surfaceId: SURFACE_E,
  name: 'iPhone Air',
};

async function closeTheFloat() {
  fireEvent.click(
    screen.getByRole('button', { name: /^Floating device controls\./ }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Close floating device' }),
  );
  expect(getFloatingSource('conversation-1')).toBeNull();
}

test('A: a second device floated from the same host and Project is judged by a fresh read, not the first float’s cached list', async () => {
  renderChat();
  await floatDevice();
  await screen.findByTestId('live-surface-canvas');
  await closeTheFloat();
  // A second device opened on the same host a moment ago: the server lists it.
  listed = [SESSION, SESSION_E];
  const taken = vi.fn();
  await act(async () => {
    expect(requestFloat(SOURCE_E, taken)).toBe(true);
  });
  expect(taken).toHaveBeenCalledTimes(1);
  expect(
    await screen.findByRole('region', { name: 'Floating device: iPhone Air' }),
  ).toBeTruthy();
  expect(getFloatingSource('conversation-1')).toEqual(SOURCE_E);
  expect(screen.queryByText(/is no longer open for you/)).toBeNull();
});

test('A2: a device whose host went unavailable mid-float, floated again, is read afresh — not closed on the old query’s error and data', async () => {
  renderChat();
  await floatDevice();
  await screen.findByTestId('live-surface-canvas');
  // The next poll: the host is gone. That read keeps the old rows as data
  // and records the error, and the float closes on it.
  sessionsAnswer = refusal(503, 'unavailable');
  await screen.findByText(
    'The device host for iPhone 17 Pro is not available, so it is not floating.',
    {},
    { timeout: 8_000 },
  );
  expect(getFloatingSource('conversation-1')).toBeNull();
  // The host is back, and the person floats the same device again. On a
  // query shared with the old float it would reopen as `status: error`
  // (with the old data) while fetching, and close on that at once.
  sessionsAnswer = null;
  await floatDevice();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(getFloatingSource('conversation-1')).toEqual(SOURCE);
  await screen.findByRole('region', { name: 'Floating device: iPhone 17 Pro' });
  expect(
    screen.queryByText(/is not available, so it is not floating/),
  ).toBeNull();
});

test('C/E: an ended session’s notice is named for its subject, and its Open in right panel opens the Device pane on that device', async () => {
  openDevice.mockReturnValue({ ok: true });
  // The host answers, and no longer lists the device's session.
  listed = [];
  renderChat();
  await floatDevice();
  const notice = await screen.findByRole('region', {
    name: 'Floating device notice',
  });
  within(notice).getByText(
    'iPhone 17 Pro is no longer open for you, so it is not floating.',
  );
  fireEvent.click(
    within(notice).getByRole('button', { name: 'Open in right panel' }),
  );
  expect(openDevice).toHaveBeenCalledWith(
    SCOPE,
    { hostId: HOST, platform: 'ios', deviceId: DEVICE_ID },
    { region: 'right' },
  );
  expect(
    screen.queryByRole('region', { name: 'Floating device notice' }),
  ).toBeNull();
});

test.each([
  ['a refusal (403)', refusal(403, 'access-denied')],
  ['an unavailable host (503)', refusal(503, 'unavailable')],
])(
  'LOW-2: %s offers no Open in right panel — the pane could not show it either',
  async (_name, answer) => {
    sessionsAnswer = answer;
    renderChat();
    await floatDevice();
    const notice = await screen.findByRole('region', {
      name: 'Floating device notice',
    });
    expect(
      within(notice).queryByRole('button', { name: 'Open in right panel' }),
    ).toBeNull();
    within(notice).getByRole('button', { name: 'Dismiss' });
  },
);

const SURFACE_2 = 'device:ios:00000003-aaaa-4bbb-8ccc-dddddddddddd';

test('LOW-1: floating the same device again as a NEW session, while its old one floats, attaches to the new surface, never the dead one', async () => {
  renderChat();
  await floatDevice();
  await screen.findByTestId('live-surface-canvas');
  // "End for everyone", reopened as a new session: the server lists s2.
  listed = [{ ...SESSION, surfaceId: SURFACE_2 }];
  const framesOf = (surface: string) =>
    calls.filter((call) =>
      call.startsWith(
        `GET /api/live-surfaces/${encodeURIComponent(surface)}/frames`,
      ),
    ).length;
  const deadBefore = framesOf(SURFACE);
  await act(async () => {
    expect(requestFloat({ ...SOURCE, surfaceId: SURFACE_2 })).toBe(true);
  });
  await waitFor(() => expect(framesOf(SURFACE_2)).toBeGreaterThan(0));
  expect(getFloatingSource('conversation-1')?.surfaceId).toBe(SURFACE_2);
  // Never re-attached to the ended s1 from the old float's cached list.
  expect(framesOf(SURFACE)).toBe(deadBefore);
});
