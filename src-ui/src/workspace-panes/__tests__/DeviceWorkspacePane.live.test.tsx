// @vitest-environment jsdom

/**
 * #1970: opening a device into the live stage — the two-step loading, the
 * platform toolbar, the input-vs-video liveness line, and the session's end.
 */

import type { MobileDeviceSession } from '@kontourai/station-contracts/mobile-device';
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const activeProject: { slug: string | null } = vi.hoisted(() => ({
  slug: null,
}));
vi.mock('../../hooks/useActiveProject', () => ({
  useActiveProject: () => ({
    projectSlug: activeProject.slug,
    projectName: null,
    workingDirectory: null,
  }),
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
    isCurrent: () => true,
  }),
}));
vi.mock('../../contexts/ProjectsContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/ProjectsContext')>()),
  useScopedProjectsQuery: () => ({
    data: [{ id: 'project-id', slug: 'project-one', name: 'Project' }],
    isLoading: false,
    isSuccess: true,
    error: null,
    refetch: vi.fn(),
  }),
}));

import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { deviceFloatSourceKey } from '../../float-over-chat/floatSource';
import {
  promoteClosedDevicePane,
  registerFloatHost,
  resetFloatStoreForTests,
  takeFloatRequest,
} from '../../float-over-chat/floatStore';
import { isSourceShown } from '../../float-over-chat/shownSources';
import {
  DEVICE_SELECTION_WAIT_MS,
  DeviceWorkspacePane,
} from '../DeviceWorkspacePane';
import { selectDeviceInPane } from '../device/devicePaneSelection';
import { deviceOsLabel } from '../device/deviceScreen';
import { writeDevicePaneState } from '../devicePaneStateStorage';
import {
  ANDROID_DEVICE,
  authorizeScope,
  chooseDeviceMenuItem,
  click,
  frameRecord,
  IOS_DEVICE,
  openDeviceMenu,
  readyInventory,
  renderInQueryClient,
  STOPPED_AVD,
  sessionFor,
  stateRecord,
  stubDeviceFetch,
} from './deviceWorkspacePaneHarness';

beforeEach(() => {
  authorizeScope();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.useRealTimers();
  activeProject.slug = null;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setClientCredentialResolver();
  localStorage.clear();
  resetFloatStoreForTests();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function openFirst(name: string) {
  await click(await screen.findByRole('button', { name }));
}

/** Wait until the ⋯ menu offers `name` (e.g. once a preview loads), then shut it. */
async function waitForMenuItem(name: string) {
  const { trigger, menu } = await openDeviceMenu();
  await within(menu).findByRole('menuitem', { name });
  await click(trigger);
  expect(screen.queryByRole('menu')).toBeNull();
}

/**
 * Task and device-recording routes over the device harness: one Task in
 * `project-one`; a recording starts `starting`, reads `recording`, and a
 * stop answers `completed`. Returns the recording requests in order.
 */
function stubRecordingRoutes() {
  const jobId = '11111111-2222-4333-8444-555555555555';
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/tasks' && method === 'GET')
        return Response.json({
          success: true,
          data:
            url.searchParams.get('projectId') === 'project-one'
              ? [{ id: 'task-a', title: 'Test Task', status: 'ready' }]
              : [],
        });
      if (url.pathname.includes('/review/device-recordings')) {
        requests.push({
          path: url.pathname,
          method,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (url.pathname.endsWith('/stop'))
          return Response.json({
            success: true,
            data: {
              id: jobId,
              state: 'completed',
              result: { walkthroughId: 'clip', commit: 'a'.repeat(40) },
            },
          });
        return Response.json({
          success: true,
          data: {
            id: jobId,
            state: method === 'POST' ? 'starting' : 'recording',
          },
        });
      }
      return originalFetch(input, init);
    },
  );
  return requests;
}

async function startRecording() {
  await waitForMenuItem('Record to Task');
  await chooseDeviceMenuItem('Record to Task');
  const dialog = await screen.findByRole('dialog', { name: 'Record to Task' });
  await click(await within(dialog).findByRole('button', { name: /Test Task/ }));
  await click(within(dialog).getByRole('button', { name: 'Start recording' }));
  await screen.findByText('Recording to Task…');
}

describe('opening a device', () => {
  test('a closed Device pane requests its host-qualified source as a float when the preview is on', async () => {
    activeProject.slug = 'project-one';
    stubDeviceFetch({
      inventory: readyInventory([ANDROID_DEVICE]),
      deviceLoopPreview: true,
    });
    const release = registerFloatHost();
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open Pixel 10 Pro XL');
    await waitForMenuItem('Record to Task');
    act(() => promoteClosedDevicePane());
    expect(takeFloatRequest()?.source).toMatchObject({
      kind: 'device',
      hostId: 'local',
      deviceId: ANDROID_DEVICE.deviceId,
      projectSlug: 'project-one',
    });
    release();
  });
  test('closing the device stage promotes its session to a floater with preview enabled', async () => {
    activeProject.slug = 'project-one';
    stubDeviceFetch({
      inventory: readyInventory([ANDROID_DEVICE]),
      deviceLoopPreview: true,
    });
    const release = registerFloatHost();
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open Pixel 10 Pro XL');
    await waitForMenuItem('Record to Task');
    await chooseDeviceMenuItem('Close');
    expect(takeFloatRequest()?.source).toMatchObject({
      kind: 'device',
      hostId: 'local',
      deviceId: ANDROID_DEVICE.deviceId,
      projectSlug: 'project-one',
    });
    release();
  });

  test('closing the device stage does not auto-float with the preview off', async () => {
    activeProject.slug = 'project-one';
    stubDeviceFetch({ inventory: readyInventory([ANDROID_DEVICE]) });
    const release = registerFloatHost();
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open Pixel 10 Pro XL');
    await chooseDeviceMenuItem('Close');
    await screen.findByRole('heading', { name: 'Android Emulators' });
    expect(takeFloatRequest()).toBeNull();
    release();
  });

  test('subscribes the Device canvas to the shared agent overlay when its preview is enabled', async () => {
    const log = stubDeviceFetch({
      inventory: readyInventory([IOS_DEVICE]),
      browserExperiencePreview: true,
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open iPhone 17 Pro');
    await waitFor(() =>
      expect(
        log.streams.some(
          (stream) =>
            new URL(stream.url).searchParams.get('agentActions') === '1',
        ),
      ).toBe(true),
    );
  });

  test('starts and stops a Task recording for the selected host-qualified session', async () => {
    activeProject.slug = 'project-one';
    const log = stubDeviceFetch({
      inventory: readyInventory([ANDROID_DEVICE]),
      deviceLoopPreview: true,
    });
    const originalFetch = globalThis.fetch;
    const jobId = '11111111-2222-4333-8444-555555555555';
    const requests: Array<{ path: string; method: string; body?: unknown }> =
      [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        if (url.pathname === '/api/tasks' && method === 'GET')
          return Response.json({
            success: true,
            data:
              url.searchParams.get('projectId') === 'project-one'
                ? [{ id: 'task-a', title: 'Test Task', status: 'ready' }]
                : [],
          });
        if (url.pathname.includes('/review/device-recordings')) {
          requests.push({
            path: url.pathname,
            method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          });
          if (url.pathname.endsWith('/stop'))
            return Response.json({
              success: true,
              data: {
                id: jobId,
                state: 'completed',
                result: { walkthroughId: 'clip', commit: 'a'.repeat(40) },
              },
            });
          return Response.json({
            success: true,
            data: {
              id: jobId,
              state: method === 'POST' ? 'starting' : 'recording',
            },
          });
        }
        return originalFetch(input, init);
      },
    );
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open Pixel 10 Pro XL');
    await waitForMenuItem('Record to Task');
    await chooseDeviceMenuItem('Record to Task');
    const dialog = await screen.findByRole('dialog', {
      name: 'Record to Task',
    });
    await click(
      await within(dialog).findByRole('button', { name: /Test Task/ }),
    );
    await click(
      within(dialog).getByRole('button', { name: 'Start recording' }),
    );
    await screen.findByText('Recording to Task…');
    const opened = log.requests.find(
      (request) =>
        request.url.includes('/sessions') && request.method === 'POST',
    );
    expect(opened).toBeDefined();
    expect(requests[0]).toMatchObject({
      method: 'POST',
      body: {
        sourceSessionId: expect.stringMatching(/^local:/),
        durationMs: 30000,
      },
    });
    await click(screen.getByRole('button', { name: 'Stop recording' }));
    await screen.findByText('Recording saved to Task.');
  });
  test('while recording, the stage shows its status and a visible Stop recording button that stops it', async () => {
    activeProject.slug = 'project-one';
    stubDeviceFetch({
      inventory: readyInventory([ANDROID_DEVICE]),
      deviceLoopPreview: true,
    });
    const requests = stubRecordingRoutes();
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open Pixel 10 Pro XL');
    await startRecording();
    // Visible on the stage, outside the ⋯ menu.
    expect(screen.queryByRole('menu')).toBeNull();
    const stop = screen.getByRole('button', { name: 'Stop recording' });
    expect(stop.closest('.device-pane__stage')).not.toBeNull();
    expect(screen.getByText('Recording to Task…')).toBeTruthy();
    await click(stop);
    await screen.findByText('Recording saved to Task.');
    expect(
      requests.filter(
        (request) =>
          request.method === 'POST' && request.path.endsWith('/stop'),
      ),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Stop recording' })).toBeNull();
  });

  test('the ⋯ menu offers Stop recording instead of Record to Task while recording, and it stops the recording', async () => {
    activeProject.slug = 'project-one';
    stubDeviceFetch({
      inventory: readyInventory([ANDROID_DEVICE]),
      deviceLoopPreview: true,
    });
    const requests = stubRecordingRoutes();
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open Pixel 10 Pro XL');
    await startRecording();
    const { menu } = await openDeviceMenu();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Record to Task' }),
    ).toBeNull();
    await chooseDeviceMenuItem('Stop recording');
    expect(screen.queryByRole('menu')).toBeNull();
    await screen.findByText('Recording saved to Task.');
    const stops = requests.filter(
      (request) => request.method === 'POST' && request.path.endsWith('/stop'),
    );
    expect(stops).toHaveLength(1);
    expect(stops[0]!.path).toContain('11111111-2222-4333-8444-555555555555');
    // Stopped: the row offers a new recording again.
    await waitForMenuItem('Record to Task');
  });

  test('Record to Task is not in the ⋯ menu without a Project', async () => {
    stubDeviceFetch({
      inventory: readyInventory([ANDROID_DEVICE]),
      deviceLoopPreview: true,
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open Pixel 10 Pro XL');
    // The preview has loaded (Logs needs it), yet recording needs a Project.
    await waitForMenuItem('Logs');
    const { menu } = await openDeviceMenu();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Record to Task' }),
    ).toBeNull();
  });

  test('the recording picker shows a capacity refusal', async () => {
    activeProject.slug = 'project-one';
    stubDeviceFetch({
      inventory: readyInventory([ANDROID_DEVICE]),
      deviceLoopPreview: true,
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/tasks')
          return Response.json({
            success: true,
            data: [{ id: 'task-a', title: 'Test Task', status: 'ready' }],
          });
        if (url.pathname.includes('/review/device-recordings'))
          return Response.json(
            {
              success: false,
              code: 'recording-unavailable',
              error: 'Recording capacity is exhausted.',
            },
            { status: 503 },
          );
        return originalFetch(input, init);
      },
    );
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open Pixel 10 Pro XL');
    await waitForMenuItem('Record to Task');
    await chooseDeviceMenuItem('Record to Task');
    const dialog = await screen.findByRole('dialog', {
      name: 'Record to Task',
    });
    await click(
      await within(dialog).findByRole('button', { name: /Test Task/ }),
    );
    await click(
      within(dialog).getByRole('button', { name: 'Start recording' }),
    );
    expect(
      await within(dialog).findByText('Recording capacity is exhausted.'),
    ).toBeTruthy();
    expect(screen.queryByText('Recording to Task…')).toBeNull();
  });

  test('captures a reproduction bundle into a selected Task', async () => {
    activeProject.slug = 'project-one';
    stubDeviceFetch({
      inventory: readyInventory([ANDROID_DEVICE]),
      deviceLoopPreview: true,
      tools: ({ method, path }) =>
        method === 'GET' && path.endsWith('/tools')
          ? {
              body: {
                success: true,
                data: {
                  hostId: 'local',
                  platform: 'android',
                  deviceId: ANDROID_DEVICE.deviceId,
                  readAt: '2026-11-01T00:00:00Z',
                  foregroundApp: { state: 'read', value: null },
                  appearance: { state: 'read', value: 'dark' },
                  location: { state: 'unreadable', reason: 'unsupported' },
                  capabilities: {
                    appearance: true,
                    location: false,
                    clearLocation: false,
                    push: false,
                    permissions: [],
                    permissionDecisions: [],
                    accessibility: false,
                  },
                },
              },
            }
          : undefined,
    });
    const originalFetch = globalThis.fetch;
    const captures: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/tasks' && (init?.method ?? 'GET') === 'GET')
          return Response.json({
            success: true,
            data: [{ id: 'task-a', title: 'Test Task', status: 'ready' }],
          });
        if (url.pathname.endsWith('/review/device-repro-bundles')) {
          captures.push(JSON.parse(String(init?.body)));
          return Response.json({
            success: true,
            data: { attachment: { id: 'attachment' } },
          });
        }
        return originalFetch(input, init);
      },
    );
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open Pixel 10 Pro XL');
    await waitForMenuItem('Apps');
    await chooseDeviceMenuItem('Apps');
    await screen.findByRole('complementary', { name: 'Apps' });
    fireEvent.change(await screen.findByLabelText('App to control'), {
      target: { value: 'com.example.app' },
    });
    await click(
      screen.getByRole('button', { name: 'Save reproduction to Task' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Save reproduction to Task',
    });
    expect(
      within(dialog).getByText('Includes a screenshot and app logs'),
    ).toBeTruthy();
    await click(
      await within(dialog).findByRole('button', { name: /Test Task/ }),
    );
    await click(within(dialog).getByRole('button', { name: 'Save bundle' }));
    await screen.findByText('Reproduction saved to “Test Task”.');
    await waitFor(() =>
      expect(captures).toEqual([
        {
          sourceSessionId: expect.stringMatching(/^local:/),
          appId: 'com.example.app',
        },
      ]),
    );
  });

  test('saves a screenshot from the selected device and Project', async () => {
    activeProject.slug = 'project-one';
    stubDeviceFetch({ inventory: readyInventory([ANDROID_DEVICE]) });
    const originalFetch = globalThis.fetch;
    const capture = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/capture?')) {
          return Response.json({
            success: true,
            data: {
              captureId: 'capture-1',
              target: {
                hostId: 'local',
                platform: 'android',
                deviceId: ANDROID_DEVICE.deviceId,
              },
              capturedAt: '2026-09-12T00:00:00.000Z',
              width: 1,
              height: 1,
              mimeType: 'image/png',
              pngBase64:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDWQAAAAASUVORK5CYII=',
            },
          });
        }
        return originalFetch(input, init);
      },
    );
    vi.stubGlobal('fetch', capture);
    const create = vi.fn(() => 'blob:device-screenshot');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const download = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open Pixel 10 Pro XL');
    await chooseDeviceMenuItem('Save screenshot');
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledOnce();
    expect(
      capture.mock.calls.some(([url]) =>
        String(url).includes(
          `/hosts/local/devices/android/${ANDROID_DEVICE.deviceId}/capture?projectSlug=project-one`,
        ),
      ),
    ).toBe(true);
  });

  test('reports a screenshot refusal without downloading', async () => {
    stubDeviceFetch({ inventory: readyInventory([ANDROID_DEVICE]) });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes('/capture')
          ? Promise.resolve(Response.json({ success: false }, { status: 403 }))
          : originalFetch(input, init),
      ),
    );
    const download = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open Pixel 10 Pro XL');
    await chooseDeviceMenuItem('Save screenshot');
    expect(
      await screen.findByText('Screenshot could not be saved'),
    ).toBeTruthy();
    expect(download).not.toHaveBeenCalled();
  });

  test('Open shows step 1 (open device), then step 2 (connect video) until the first frame', async () => {
    const answer = deferred<MobileDeviceSession>();
    const log = stubDeviceFetch({
      inventory: readyInventory([IOS_DEVICE]),
      open: () => answer.promise,
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open iPhone 17 Pro');
    expect(screen.getAllByText('Opening device…').length).toBeGreaterThan(0);
    const session = sessionFor(IOS_DEVICE);
    await act(async () => answer.resolve(session));
    expect(await screen.findByText('Connecting video…')).toBeTruthy();
    await waitFor(() => expect(log.streams).toHaveLength(1));
    expect(log.streams[0]!.url).toContain(
      encodeURIComponent(session.surfaceId),
    );
    await log.streams[0]!.push(
      stateRecord(session.surfaceId, { inputChannel: 'connected' }),
    );
    await log.streams[0]!.push(frameRecord(session.surfaceId));
    await waitFor(() =>
      expect(screen.queryByText('Connecting video…')).toBeNull(),
    );
  });

  test('Start answers at once; the pane polls until the device runs, then opens it by its new id', async () => {
    const booted = deferred<{ deviceId: string; state: 'starting' }>();
    let running = false;
    const log = stubDeviceFetch({
      // The hub lists a running emulator under its serial, not its AVD name.
      inventory: () =>
        readyInventory([
          running
            ? {
                ...STOPPED_AVD,
                deviceId: 'emulator-5554',
                booted: true,
              }
            : STOPPED_AVD,
        ]),
      start: () => booted.promise,
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Start station-test');
    expect(
      screen.getAllByText('Starting station-test…').length,
    ).toBeGreaterThan(0);
    // The row keeps its own spinner while the device boots.
    expect(
      screen.getByRole('button', { name: 'Start station-test' }),
    ).toHaveProperty('disabled', true);
    running = true;
    await act(async () =>
      booted.resolve({ deviceId: 'station-test', state: 'starting' }),
    );
    await waitFor(() =>
      expect(
        log.requests.some(
          (request) =>
            request.method === 'POST' &&
            new URL(request.url).pathname.endsWith(
              '/hosts/local/devices/android/emulator-5554/sessions',
            ),
        ),
      ).toBe(true),
    );
  });

  test('an iOS Start opens THAT simulator, not another running one with the same name (D3)', async () => {
    const OTHER = '11111111-2222-4333-8444-555555555555';
    let bootedB = false;
    const log = stubDeviceFetch({
      inventory: () =>
        readyInventory([
          // Same name, different runtime, already running.
          { ...IOS_DEVICE, deviceId: OTHER, runtime: 'iOS 18.0', booted: true },
          { ...IOS_DEVICE, booted: bootedB },
        ]),
      start: async () => ({ deviceId: IOS_DEVICE.deviceId, state: 'starting' }),
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst(`Start ${IOS_DEVICE.name}`);
    // Several reads while it boots: the other, same-named simulator is
    // running the whole time and must not be opened.
    await waitFor(() => expect(log.inventoryReads).toBeGreaterThan(1));
    const opens = () =>
      log.requests.filter(
        (request) =>
          new URL(request.url).pathname.endsWith('/sessions') &&
          request.method === 'POST',
      );
    expect(opens()).toHaveLength(0);
    bootedB = true;
    await click(screen.getByRole('button', { name: 'Refresh devices' }));
    await waitFor(() => expect(opens()).toHaveLength(1));
    expect(new URL(opens()[0]!.url).pathname).toContain(
      `/devices/ios/${IOS_DEVICE.deviceId}/sessions`,
    );
  });

  test('a Start that fails is reported as soon as the list says so (D4)', async () => {
    let phase: 'stopped' | 'failed' = 'stopped';
    stubDeviceFetch({
      inventory: () =>
        readyInventory([
          phase === 'failed'
            ? { ...STOPPED_AVD, startError: 'device-unavailable' as const }
            : STOPPED_AVD,
        ]),
      start: async () => {
        phase = 'failed'; // the boot fails before the next read
        return { deviceId: 'station-test', state: 'starting' };
      },
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Start station-test');
    expect(await screen.findByText('station-test did not start')).toBeTruthy();
  });

  test('a Start seen booting that is no longer booting, and not running, failed (D4)', async () => {
    let phase: 'stopped' | 'starting' | 'gone' = 'stopped';
    stubDeviceFetch({
      inventory: () =>
        readyInventory([
          phase === 'starting'
            ? { ...STOPPED_AVD, starting: true }
            : STOPPED_AVD,
        ]),
      start: async () => {
        phase = 'starting';
        return { deviceId: 'station-test', state: 'starting' };
      },
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Start station-test');
    // The next read shows it booting; then it silently stops booting.
    await waitFor(() =>
      expect(
        screen.getAllByText('Starting station-test…').length,
      ).toBeGreaterThan(0),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    phase = 'gone';
    expect(
      await screen.findByText('station-test did not start', undefined, {
        timeout: 4_000,
      }),
    ).toBeTruthy();
  });

  test('a refused open says why, keeping the picker', async () => {
    stubDeviceFetch({
      inventory: readyInventory([IOS_DEVICE]),
      open: async () => ({ status: 409, code: 'device-not-running' }),
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open iPhone 17 Pro');
    expect(
      await screen.findByText('iPhone 17 Pro is not running'),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'iOS Simulators' }),
    ).toBeTruthy();
  });
});

describe('the device toolbar', () => {
  async function live(device = IOS_DEVICE) {
    const log = stubDeviceFetch({ inventory: readyInventory([device]) });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst(`Open ${device.name}`);
    await waitFor(() => expect(log.streams).toHaveLength(1));
    const surfaceId = decodeURIComponent(
      new URL(log.streams[0]!.url).pathname
        .split('/live-surfaces/')[1]!
        .split('/')[0]!,
    );
    return { log, surfaceId, stream: log.streams[0]! };
  }

  test('iOS: identity, Home and Rotate — no Back or Recents', async () => {
    const { stream, surfaceId } = await live(IOS_DEVICE);
    await stream.push(stateRecord(surfaceId, { inputChannel: 'connected' }));
    expect(screen.getByText('Local · iOS 26.5')).toBeTruthy();
    screen.getByRole('toolbar', { name: 'iPhone 17 Pro controls' });
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    const { menu } = await openDeviceMenu();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Recents' }),
    ).toBeNull();
    expect(
      within(menu).getByRole('menuitem', { name: 'Power off' }),
    ).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Close' })).toBeTruthy();
  });

  test('Android: Home, Back and Recents — no Rotate', async () => {
    const { stream, surfaceId } = await live({
      ...ANDROID_DEVICE,
      name: 'station-test',
    });
    await stream.push(stateRecord(surfaceId, { inputChannel: 'connected' }));
    for (const name of ['Home', 'Back'])
      expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
    const { menu } = await openDeviceMenu();
    expect(
      within(menu).getByRole('menuitem', { name: 'Recents' }),
    ).toHaveProperty('disabled', false);
  });

  test('the toolbar holds exactly Home, Rotate and ⋯ on iOS, and Home, Back and ⋯ on Android', async () => {
    const ios = await live(IOS_DEVICE);
    await ios.stream.push(
      stateRecord(ios.surfaceId, { inputChannel: 'connected' }),
    );
    expect(
      within(screen.getByRole('toolbar', { name: 'iPhone 17 Pro controls' }))
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Home', 'Rotate', 'More iPhone 17 Pro actions']);
    cleanup();
    vi.unstubAllGlobals();

    const android = await live(ANDROID_DEVICE);
    await android.stream.push(
      stateRecord(android.surfaceId, { inputChannel: 'connected' }),
    );
    const toolbar = await screen.findByRole('toolbar', {
      name: 'station-test controls',
    });
    expect(
      within(toolbar)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Home', 'Back', 'More station-test actions']);
  });

  test('the ⋯ menu groups its rows under Capture, Tools and Session, with Power off and End last on their own', async () => {
    const { stream, surfaceId } = await live(ANDROID_DEVICE);
    await stream.push(stateRecord(surfaceId, { inputChannel: 'connected' }));
    const { trigger, menu } = await openDeviceMenu('station-test');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    const rows = (group: string) =>
      within(within(menu).getByRole('group', { name: group }))
        .getAllByRole('menuitem')
        .map((row) => row.getAttribute('aria-label'));
    // No Project and no preview: no Record to Task and no Logs.
    expect(rows('Capture')).toEqual(['Save screenshot']);
    expect(rows('Tools')).toEqual(['Apps', 'Device settings']);
    expect(rows('Session')).toEqual([
      'Recents',
      'Float in the next chat you open',
      'Close',
    ]);
    // The rows that stop the device for everyone stand apart, last.
    const groups = within(menu).getAllByRole('group');
    const last = groups.at(-1)!;
    expect(last.hasAttribute('aria-label')).toBe(false);
    expect(
      within(last)
        .getAllByRole('menuitem')
        .map((row) => row.getAttribute('aria-label')),
    ).toEqual(['Power off', 'End for everyone']);
    // Escape shuts it without running anything.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('Recents in the ⋯ menu (Android) sends the recents device button', async () => {
    const { stream, surfaceId, log } = await live(ANDROID_DEVICE);
    await stream.push(stateRecord(surfaceId, { inputChannel: 'connected' }));
    await stream.push(frameRecord(surfaceId));
    await chooseDeviceMenuItem('Recents');
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(log.inputs).toHaveLength(1));
    expect(log.inputs[0]!.events).toEqual([
      { kind: 'device-button', button: 'recents' },
    ]);
  });

  test('Recents in the ⋯ menu is disabled while input is down', async () => {
    const { stream, surfaceId, log } = await live(ANDROID_DEVICE);
    await stream.push(stateRecord(surfaceId, { inputChannel: 'down' }));
    const { menu } = await openDeviceMenu();
    const recents = within(menu).getByRole('menuitem', { name: 'Recents' });
    expect(recents).toHaveProperty('disabled', true);
    fireEvent.click(recents);
    expect(log.inputs).toHaveLength(0);
  });

  test('Logs is offered in the ⋯ menu only under the device developer loop preview, and opens the Logs view', async () => {
    const plain = await live(IOS_DEVICE);
    await plain.stream.push(
      stateRecord(plain.surfaceId, { inputChannel: 'connected' }),
    );
    const { menu } = await openDeviceMenu();
    expect(within(menu).queryByRole('menuitem', { name: 'Logs' })).toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    stubDeviceFetch({
      inventory: readyInventory([IOS_DEVICE]),
      deviceLoopPreview: true,
      tools: ({ method, path }) =>
        method === 'GET' && path.endsWith('/tools')
          ? {
              body: {
                success: true,
                data: {
                  hostId: 'local',
                  platform: 'ios',
                  deviceId: IOS_DEVICE.deviceId,
                  readAt: '2026-11-01T00:00:00Z',
                  foregroundApp: { state: 'read', value: null },
                  appearance: { state: 'read', value: 'dark' },
                  location: { state: 'unreadable', reason: 'unsupported' },
                  capabilities: {
                    appearance: true,
                    location: false,
                    clearLocation: false,
                    push: false,
                    permissions: [],
                    permissionDecisions: [],
                    accessibility: false,
                  },
                },
              },
            }
          : undefined,
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open iPhone 17 Pro');
    await waitForMenuItem('Logs');
    await chooseDeviceMenuItem('Logs');
    const drawer = await screen.findByRole('complementary', { name: 'Logs' });
    expect(await within(drawer).findByLabelText('App ID')).toBeTruthy();
    expect(
      within(drawer).getByRole('button', { name: 'Start logs' }),
    ).toBeTruthy();
    // Logs holds logs only: no app actions or settings here.
    expect(within(drawer).queryByLabelText('App to control')).toBeNull();
    expect(
      within(drawer).queryByRole('button', { name: 'Appearance' }),
    ).toBeNull();
    expect(
      within(drawer).getByRole('button', { name: 'Close logs' }),
    ).toBeTruthy();
  });

  test('buttons send typed device input through the surface, and pause while input is down', async () => {
    const { stream, surfaceId, log } = await live(IOS_DEVICE);
    await stream.push(
      stateRecord(surfaceId, {
        inputChannel: 'reconnecting',
        videoMode: 'live',
      }),
    );
    await stream.push(frameRecord(surfaceId));
    // Video continues; input is down — and the pane says which.
    expect(
      screen.getByText(
        'Input disconnected, reconnecting… The picture is still live.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Home' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Rotate' })).toHaveProperty(
      'disabled',
      true,
    );
    await stream.push(stateRecord(surfaceId, { inputChannel: 'connected' }));
    expect(screen.queryByText(/Input disconnected, reconnecting/)).toBeNull();
    await click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(log.inputs).toHaveLength(1));
    expect(log.inputs[0]!.events).toEqual([
      { kind: 'device-button', button: 'home' },
    ]);
    await click(screen.getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(log.inputs).toHaveLength(2));
    expect(log.inputs[1]!.events).toEqual([
      { kind: 'rotate', orientation: 'landscape-left' },
    ]);
  });

  test('with no recent frame, the liveness line makes no claim about the picture (S5)', async () => {
    const { stream, surfaceId } = await live(IOS_DEVICE);
    await stream.push(
      stateRecord(surfaceId, {
        inputChannel: 'reconnecting',
        videoMode: 'live',
      }),
    );
    expect(screen.getByText('Input disconnected, reconnecting…')).toBeTruthy();
    expect(screen.queryByText(/picture is still live/)).toBeNull();
  });

  test('a picture that stopped arriving is not called live (S5)', async () => {
    // Only the clock is faked (before render, so the canvas reads it);
    // timers stay real so the stream harness still flows.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { stream, surfaceId } = await live(IOS_DEVICE);
    await stream.push(stateRecord(surfaceId, { videoMode: 'live' }));
    await stream.push(frameRecord(surfaceId));
    // The last frame is now old: move the clock past the stall window.
    vi.setSystemTime(Date.now() + 60_000);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    await stream.push(
      stateRecord(surfaceId, {
        inputChannel: 'reconnecting',
        videoMode: 'live',
      }),
    );
    expect(screen.getByText('Input disconnected, reconnecting…')).toBeTruthy();
    expect(screen.queryByText(/picture is still live/)).toBeNull();
  });

  test('polled stills are not called a live picture (S5)', async () => {
    const { stream, surfaceId } = await live(ANDROID_DEVICE);
    await stream.push(
      stateRecord(surfaceId, {
        inputChannel: 'reconnecting',
        videoMode: 'snapshot-poll',
        videoDegradedReason: 'decoder-unavailable',
      }),
    );
    await stream.push(frameRecord(surfaceId));
    expect(screen.getByText('Input disconnected, reconnecting…')).toBeTruthy();
    expect(screen.queryByText(/picture is still live/)).toBeNull();
  });

  test('Rotate turns from the orientation the device reports', async () => {
    const { stream, surfaceId, log } = await live(IOS_DEVICE);
    await stream.push(
      stateRecord(surfaceId, {
        inputChannel: 'connected',
        orientation: 'landscape-left',
      }),
    );
    await stream.push(frameRecord(surfaceId));
    await click(screen.getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(log.inputs).toHaveLength(1));
    expect(log.inputs[0]!.events).toEqual([
      { kind: 'rotate', orientation: 'portrait-upside-down' },
    ]);
  });

  test('snapshot polling is named for what it is', async () => {
    const { stream, surfaceId } = await live(ANDROID_DEVICE);
    await stream.push(
      stateRecord(surfaceId, {
        inputChannel: 'connected',
        videoMode: 'snapshot-poll',
        videoDegradedReason: 'decoder-unavailable',
      }),
    );
    expect(
      screen.getByText(
        /Showing a screenshot each second\. Install ffmpeg on the computer running Station for live video\./,
      ),
    ).toBeTruthy();
  });

  test('Close only detaches this viewer; End for everyone ends it; Power off shuts it down', async () => {
    const { log } = await live(IOS_DEVICE);
    await chooseDeviceMenuItem('Close');
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    expect(
      log.requests.some((request) => request.method === 'DELETE'),
      'Close must not end the session for other viewers',
    ).toBe(false);

    await openFirst('Open iPhone 17 Pro');
    await chooseDeviceMenuItem('End for everyone');
    await waitFor(() =>
      expect(
        log.requests.some(
          (request) =>
            request.method === 'DELETE' &&
            /\/hosts\/local\/sessions\/[0-9a-f-]+$/.test(
              new URL(request.url).pathname,
            ),
        ),
      ).toBe(true),
    );
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    expect(
      log.requests.some((request) => request.url.includes('/power-off')),
    ).toBe(false);

    await openFirst('Open iPhone 17 Pro');
    await chooseDeviceMenuItem('Power off');
    await waitFor(() =>
      expect(
        log.requests.some(
          (request) =>
            request.method === 'POST' &&
            new URL(request.url).pathname.endsWith(
              `/devices/ios/${IOS_DEVICE.deviceId}/power-off`,
            ),
        ),
      ).toBe(true),
    );
    await screen.findByRole('heading', { name: 'iOS Simulators' });
  });

  test('a caller who may not manage devices may Start a shared device but sees no Power off or End for everyone', async () => {
    const log = stubDeviceFetch({
      inventory: {
        ...readyInventory([IOS_DEVICE, STOPPED_AVD]),
        canManageDevices: false,
      },
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open iPhone 17 Pro');
    await waitFor(() => expect(log.streams).toHaveLength(1));
    const { menu } = await openDeviceMenu();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Power off' }),
    ).toBeNull();
    expect(
      within(menu).queryByRole('menuitem', { name: 'End for everyone' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Power off' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'End for everyone' }),
    ).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Close' })).toBeTruthy();
    await chooseDeviceMenuItem('Close');
    await screen.findByRole('heading', { name: 'Android Emulators' });
    // D12: a device shared with the caller's Project may be started by them
    // (the hub's boot route is `drive`); only powering off is withheld.
    expect(
      screen.getByRole('button', { name: 'Start station-test' }),
    ).toBeTruthy();
  });

  test('with input down, the tab stop moves to the first ENABLED button (D5)', async () => {
    const { stream, surfaceId } = await live(IOS_DEVICE);
    await stream.push(stateRecord(surfaceId, { inputChannel: 'down' }));
    const toolbar = screen.getByRole('toolbar', {
      name: 'iPhone 17 Pro controls',
    });
    const buttons = within(toolbar).getAllByRole('button');
    const stops = buttons.filter((button) => button.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveProperty('disabled', false);
    // Home and Rotate are disabled with input down; the ⋯ menu is the
    // first control that works without input.
    expect(stops[0]!.getAttribute('aria-label')).toBe(
      'More iPhone 17 Pro actions',
    );
  });

  test('the toolbar is one tab stop; arrow keys move between its buttons', async () => {
    const { stream, surfaceId } = await live(IOS_DEVICE);
    await stream.push(stateRecord(surfaceId, { inputChannel: 'connected' }));
    await stream.push(frameRecord(surfaceId));
    const toolbar = screen.getByRole('toolbar', {
      name: 'iPhone 17 Pro controls',
    });
    const buttons = within(toolbar).getAllByRole('button');
    expect(buttons.map((button) => button.tabIndex)).toEqual([
      0,
      ...buttons.slice(1).map(() => -1),
    ]);
    buttons[0]!.focus();
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1]!.tabIndex).toBe(0);
    expect(buttons[0]!.tabIndex).toBe(-1);
    fireEvent.keyDown(toolbar, { key: 'End' });
    expect(document.activeElement).toBe(buttons.at(-1));
  });

  test('with no chat open (a phone shows one pane at a time), the device floats in the next chat opened', async () => {
    activeProject.slug = 'alpha';
    await live(IOS_DEVICE);
    await chooseDeviceMenuItem('Float in the next chat you open');
    const { menu } = await openDeviceMenu();
    within(menu).getByRole('menuitem', {
      name: 'Floats in the next chat you open',
    });
    // A chat opens: its floater takes the device.
    act(() => {
      registerFloatHost();
    });
    expect(takeFloatRequest()?.source).toMatchObject({
      kind: 'device',
      deviceId: IOS_DEVICE.deviceId,
      projectSlug: 'alpha',
    });
  });

  test('#90 D9: Float over chat waits for a chat, says why while it cannot, and lets go only once a chat has TAKEN the device (the session stays open)', async () => {
    activeProject.slug = 'alpha';
    const { log, surfaceId } = await live(IOS_DEVICE);
    const key = deviceFloatSourceKey({
      hostId: 'local',
      platform: 'ios',
      deviceId: IOS_DEVICE.deviceId,
    });
    // On screen here: the float-over-chat hides this device.
    expect(isSourceShown(key)).toBe(true);
    // No chat can float it yet: the action says it will float in the next
    // chat opened (a phone shows one pane at a time), not "Float over chat".
    const { menu } = await openDeviceMenu();
    within(menu).getByRole('menuitem', {
      name: 'Float in the next chat you open',
    });
    expect(
      within(menu).queryByRole('menuitem', { name: 'Float over chat' }),
    ).toBeNull();
    let release!: () => void;
    act(() => {
      release = registerFloatHost();
    });
    // The open menu follows: the row is enabled once a chat can take it.
    await chooseDeviceMenuItem('Float over chat');
    // Requested, not yet taken: the pane still shows the device.
    screen.getByRole('toolbar', { name: 'iPhone 17 Pro controls' });
    expect(isSourceShown(key)).toBe(true);
    const request = takeFloatRequest();
    // The source names the Project the device is being viewed under, so the
    // float reads it there whatever Project the chat is in.
    expect(request?.source).toEqual({
      kind: 'device',
      hostId: 'local',
      platform: 'ios',
      deviceId: IOS_DEVICE.deviceId,
      surfaceId,
      projectSlug: 'alpha',
      name: IOS_DEVICE.name,
    });
    // A chat took it: now this pane lets go (so the float shows), without
    // ending the session.
    act(() => request?.onTaken?.());
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    expect(isSourceShown(key)).toBe(false);
    expect(log.requests.some((request) => request.method === 'DELETE')).toBe(
      false,
    );
    act(() => release());
  });

  test('#90 D9: a mounted pane shows the device the float opened in it (Open in right panel)', async () => {
    const session = sessionFor(IOS_DEVICE);
    const log = stubDeviceFetch({
      inventory: readyInventory([IOS_DEVICE]),
      sessions: [session],
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    writeDevicePaneState(
      localStorage,
      { apiBase: 'http://station.test', authorityKey: 'authority-1' },
      session,
    );
    act(() =>
      selectDeviceInPane({
        hostId: 'local',
        platform: 'ios',
        deviceId: IOS_DEVICE.deviceId,
      }),
    );
    await screen.findByRole('toolbar', { name: 'iPhone 17 Pro controls' });
    await waitFor(() => expect(log.streams).toHaveLength(1));
    expect(log.streams[0]!.url).toContain(
      encodeURIComponent(session.surfaceId),
    );
  });

  test('#90 D9 (L5): a session the pane has not read yet is re-read until it appears', async () => {
    const listed: MobileDeviceSession[] = [];
    const log = stubDeviceFetch({
      inventory: readyInventory([IOS_DEVICE]),
      sessions: listed,
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    const reads = () =>
      log.requests.filter((request) =>
        new URL(request.url).pathname.endsWith('/hosts/local/sessions'),
      ).length;
    const before = reads();
    act(() =>
      selectDeviceInPane({
        hostId: 'local',
        platform: 'ios',
        deviceId: IOS_DEVICE.deviceId,
      }),
    );
    // Not listed on this read: the pane asks again rather than giving up.
    await waitFor(() => expect(reads()).toBeGreaterThan(before), {
      timeout: 3_000,
    });
    // The session opened elsewhere a moment ago lands in the next read.
    listed.push(sessionFor(IOS_DEVICE));
    await screen.findByRole(
      'toolbar',
      { name: 'iPhone 17 Pro controls' },
      { timeout: 4_000 },
    );
  });

  test('#90 D9 (L5): a session that never appears is reported, not waited on forever', async () => {
    const now = vi.spyOn(Date, 'now');
    const start = Date.now();
    now.mockReturnValue(start);
    stubDeviceFetch({ inventory: readyInventory([IOS_DEVICE]), sessions: [] });
    renderInQueryClient(<DeviceWorkspacePane />);
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    act(() =>
      selectDeviceInPane({
        hostId: 'local',
        platform: 'ios',
        deviceId: IOS_DEVICE.deviceId,
      }),
    );
    // Past the bound: the next re-read (a second later) gives up and says so.
    now.mockReturnValue(start + DEVICE_SELECTION_WAIT_MS + 1);
    expect(
      await screen.findByText(
        'That device is not open here',
        {},
        { timeout: 4_000 },
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('toolbar', { name: 'iPhone 17 Pro controls' }),
    ).toBeNull();
  });

  test('#90 D9 (L5): re-reads that FAIL keep going and still give up at the bound', async () => {
    const now = vi.spyOn(Date, 'now');
    const start = Date.now();
    now.mockReturnValue(start);
    let failing = false;
    const log = stubDeviceFetch({
      inventory: readyInventory([IOS_DEVICE]),
      sessions: [],
      sessionsStatus: () => (failing ? 503 : undefined),
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    const reads = () =>
      log.requests.filter((request) =>
        new URL(request.url).pathname.endsWith('/hosts/local/sessions'),
      ).length;
    failing = true;
    act(() =>
      selectDeviceInPane({
        hostId: 'local',
        platform: 'ios',
        deviceId: IOS_DEVICE.deviceId,
      }),
    );
    const before = reads();
    // A failed read changes no data: the re-reads must not stop on it.
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(before + 2), {
      timeout: 4_000,
    });
    now.mockReturnValue(start + DEVICE_SELECTION_WAIT_MS + 1);
    expect(
      await screen.findByText(
        'That device is not open here',
        {},
        { timeout: 3_000 },
      ),
    ).toBeTruthy();
  });

  test('#90 D9 (L5): moving to another host while waiting ends the wait quietly', async () => {
    const now = vi.spyOn(Date, 'now');
    const start = Date.now();
    now.mockReturnValue(start);
    const REMOTE = 'ssh-0123456789ab';
    stubDeviceFetch({
      inventory: readyInventory([IOS_DEVICE]),
      sessions: [],
      hosts: [
        { hostId: 'local', label: 'This Station', kind: 'local' },
        { hostId: REMOTE, label: 'Studio Mac', kind: 'ssh' },
      ],
      remoteInventory: {
        [REMOTE]: { ...readyInventory([]), hostId: REMOTE },
      },
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await screen.findByRole('group', { name: 'Device host' });
    act(() =>
      selectDeviceInPane({
        hostId: 'local',
        platform: 'ios',
        deviceId: IOS_DEVICE.deviceId,
      }),
    );
    await click(screen.getByRole('button', { name: 'Studio Mac' }));
    now.mockReturnValue(start + DEVICE_SELECTION_WAIT_MS + 1);
    // Two re-read ticks past the bound: nothing is reported about the host
    // the person left.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_200));
    });
    expect(screen.queryByText('That device is not open here')).toBeNull();
  });

  test('LIVE-1: a Start whose running read still carried `starting` does not leave the row on "Opening…" once the pane shows the list again', async () => {
    // What the server really answers for iOS: the hub lists the simulator
    // `booted` as soon as it is up, while the Start's own boot call has not
    // returned, so the route still marks it `starting` (isStarting). Only
    // after that call returns does `starting` go.
    let phase: 'stopped' | 'booted-starting' | 'booted' = 'stopped';
    stubDeviceFetch({
      inventory: () =>
        readyInventory([
          phase === 'stopped'
            ? { ...IOS_DEVICE, booted: false }
            : phase === 'booted-starting'
              ? { ...IOS_DEVICE, booted: true, starting: true }
              : { ...IOS_DEVICE, booted: true },
        ]),
      start: async () => {
        phase = 'booted-starting';
        return { deviceId: IOS_DEVICE.deviceId, state: 'starting' };
      },
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst(`Start ${IOS_DEVICE.name}`);
    // The boot poll sees it running and opens it.
    await screen.findByRole(
      'toolbar',
      { name: 'iPhone 17 Pro controls' },
      { timeout: 5_000 },
    );
    // The Start's boot call returns on the server.
    phase = 'booted';
    // The person floats it over a chat: the pane lets go and lists devices.
    let release!: () => void;
    act(() => {
      release = registerFloatHost();
    });
    await chooseDeviceMenuItem('Float over chat');
    act(() => takeFloatRequest()?.onTaken?.());
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    // The row must come back to a live Open, not stay on a disabled
    // "Opening…" spinner read from the last boot-poll answer.
    await waitFor(
      () =>
        expect(
          screen.getByRole('button', { name: `Open ${IOS_DEVICE.name}` }),
        ).toHaveProperty('disabled', false),
      { timeout: 5_000 },
    );
    act(() => release());
  });

  test('LOW-3: switching the active Project while waiting ends the wait quietly', async () => {
    const now = vi.spyOn(Date, 'now');
    const start = Date.now();
    now.mockReturnValue(start);
    activeProject.slug = 'alpha';
    stubDeviceFetch({ inventory: readyInventory([IOS_DEVICE]), sessions: [] });
    const view = renderInQueryClient(<DeviceWorkspacePane />);
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    act(() =>
      selectDeviceInPane({
        hostId: 'local',
        platform: 'ios',
        deviceId: IOS_DEVICE.deviceId,
      }),
    );
    activeProject.slug = 'bravo';
    view.rerenderWrapped(<DeviceWorkspacePane />);
    now.mockReturnValue(start + DEVICE_SELECTION_WAIT_MS + 1);
    // Two re-read ticks past the bound: nothing is said about the Project
    // the person left.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_200));
    });
    expect(screen.queryByText('That device is not open here')).toBeNull();
  });

  test('a session that is gone offers Reconnect', async () => {
    stubDeviceFetch({
      inventory: readyInventory([IOS_DEVICE]),
      framesStatus: 404,
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open iPhone 17 Pro');
    expect(await screen.findByText('This device session ended')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });
});

describe('D12: a Project admin reaches shared devices through the Project', () => {
  test('every device and surface request names the active Project', async () => {
    activeProject.slug = 'alpha';
    const log = stubDeviceFetch({ inventory: readyInventory([IOS_DEVICE]) });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open iPhone 17 Pro');
    await waitFor(() => expect(log.streams).toHaveLength(1));
    const { stream } = { stream: log.streams[0]! };
    const surfaceId = decodeURIComponent(
      new URL(stream.url).pathname.split('/live-surfaces/')[1]!.split('/')[0]!,
    );
    await stream.push(stateRecord(surfaceId, { inputChannel: 'connected' }));
    await stream.push(frameRecord(surfaceId));
    await click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(log.inputs).toHaveLength(1));
    const urls = log.requests.map((request) => new URL(request.url));
    const kinds = [
      '/hosts/local/devices',
      '/hosts/local/sessions',
      `/devices/ios/${IOS_DEVICE.deviceId}/sessions`,
      '/frames',
      '/input',
    ];
    for (const kind of kinds) {
      const hits = urls.filter((url) => url.pathname.endsWith(kind));
      expect(hits.length, kind).toBeGreaterThan(0);
      for (const url of hits)
        expect(url.searchParams.get('projectSlug'), kind).toBe('alpha');
    }
  });

  test('with no active Project, requests name none (the operator needs none)', async () => {
    const log = stubDeviceFetch({ inventory: readyInventory([IOS_DEVICE]) });
    renderInQueryClient(<DeviceWorkspacePane />);
    await screen.findByRole('button', { name: 'Open iPhone 17 Pro' });
    for (const request of log.requests)
      expect(new URL(request.url).searchParams.has('projectSlug')).toBe(false);
  });
});

describe('the phone stage', () => {
  test('the OS label says the platform once, as the hub reports it or bare', () => {
    // The hub reports `version` with its platform ("iOS 26.5", as the
    // server's host fixture has it); a bare version gets the platform.
    expect(deviceOsLabel({ platform: 'ios', runtime: 'iOS 26.5' })).toBe(
      'iOS 26.5',
    );
    expect(deviceOsLabel({ platform: 'android', runtime: '16' })).toBe(
      'Android 16',
    );
  });
});
