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
  }),
}));

import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { deviceFloatSourceKey } from '../../float-over-chat/floatSource';
import {
  registerFloatHost,
  resetFloatStoreForTests,
  takeFloatRequest,
} from '../../float-over-chat/floatStore';
import { isSourceShown } from '../../float-over-chat/shownSources';
import {
  DEVICE_PLACEHOLDER_ASPECT,
  DEVICE_SELECTION_WAIT_MS,
  DeviceWorkspacePane,
  deviceCornerRadius,
} from '../DeviceWorkspacePane';
import { selectDeviceInPane } from '../device/devicePaneSelection';
import { deviceOsLabel } from '../device/deviceScreen';
import { writeDevicePaneState } from '../devicePaneStateStorage';
import {
  ANDROID_DEVICE,
  authorizeScope,
  click,
  frameRecord,
  IOS_DEVICE,
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

describe('opening a device', () => {
  test('Open shows step 1 (open device), then step 2 (connect video) until the first frame', async () => {
    const answer = deferred<MobileDeviceSession>();
    const log = stubDeviceFetch({
      inventory: readyInventory([IOS_DEVICE]),
      open: () => answer.promise,
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await openFirst('Open iPhone 17 Pro');
    expect(
      screen.getAllByText('Step 1 of 2: open device').length,
    ).toBeGreaterThan(0);
    const session = sessionFor(IOS_DEVICE);
    await act(async () => answer.resolve(session));
    expect(await screen.findByText('Step 2 of 2: connect video')).toBeTruthy();
    await waitFor(() => expect(log.streams).toHaveLength(1));
    expect(log.streams[0]!.url).toContain(
      encodeURIComponent(session.surfaceId),
    );
    await log.streams[0]!.push(
      stateRecord(session.surfaceId, { inputChannel: 'connected' }),
    );
    await log.streams[0]!.push(frameRecord(session.surfaceId));
    await waitFor(() =>
      expect(screen.queryByText('Step 2 of 2: connect video')).toBeNull(),
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
      screen.getAllByText('Starting station-test… This can take a minute.')
        .length,
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
        screen.getAllByText('Starting station-test… This can take a minute.')
          .length,
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
    expect(screen.queryByRole('button', { name: 'Recents' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Power off' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  test('Android: Home, Back and Recents — no Rotate', async () => {
    const { stream, surfaceId } = await live({
      ...ANDROID_DEVICE,
      name: 'station-test',
    });
    await stream.push(stateRecord(surfaceId, { inputChannel: 'connected' }));
    for (const name of ['Home', 'Back', 'Recents'])
      expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
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
        /still screenshot about once a second: live video needs a video decoder \(ffmpeg\)/,
      ),
    ).toBeTruthy();
  });

  test('Close only detaches this viewer; End for everyone ends it; Power off shuts it down', async () => {
    const { log } = await live(IOS_DEVICE);
    await click(screen.getByRole('button', { name: 'Close' }));
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    expect(
      log.requests.some((request) => request.method === 'DELETE'),
      'Close must not end the session for other viewers',
    ).toBe(false);

    await openFirst('Open iPhone 17 Pro');
    await click(
      await screen.findByRole('button', { name: 'End for everyone' }),
    );
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
    await click(await screen.findByRole('button', { name: 'Power off' }));
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
    expect(screen.queryByRole('button', { name: 'Power off' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'End for everyone' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Close' }));
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
    // Home and Rotate are disabled with input down; Tools (#1971) is the
    // first control that works without input.
    expect(stops[0]!.getAttribute('aria-label')).toBe('Tools');
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
    // No chat can float it yet: the action says so rather than doing nothing.
    const disabled = screen.getByRole('button', { name: 'Float over chat' });
    expect(disabled).toHaveProperty('disabled', true);
    expect(disabled.getAttribute('title')).toBe(
      'Open a chat in a Project to float this device',
    );
    let release!: () => void;
    act(() => {
      release = registerFloatHost();
    });
    await click(screen.getByRole('button', { name: 'Float over chat' }));
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
    await click(screen.getByRole('button', { name: 'Float over chat' }));
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
    expect(
      await screen.findByText('This device session has ended'),
    ).toBeTruthy();
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
  test('placeholder aspects and corner radii follow the platform', () => {
    expect(DEVICE_PLACEHOLDER_ASPECT.ios).toBeCloseTo(9 / 19.5);
    expect(DEVICE_PLACEHOLDER_ASPECT.android).toBeCloseTo(9 / 20);
    expect(deviceCornerRadius('ios', { width: 300, height: 650 })).toBe(12);
    expect(deviceCornerRadius('android', { width: 300, height: 650 })).toBe(42);
  });

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
