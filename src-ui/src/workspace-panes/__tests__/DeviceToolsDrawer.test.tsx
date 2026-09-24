// @vitest-environment jsdom

/**
 * #1971 (D10): the Device pane's Tools drawer and accessibility overlay,
 * mounted inside the real Device pane over a real QueryClient and a
 * stubbed fetch (the harness). What is proved: the drawer shows what the
 * DEVICE reported (never what was asked), refusals are said plainly, the
 * drawer overlays below 560px of container width and docks above, and the
 * overlay reads the tree only while it is on and the stream is live,
 * drawing each frame through the canvas geometry (rotation included).
 */

import type {
  DeviceAccessibilityTree,
  DeviceToolsSnapshot,
} from '@kontourai/station-contracts/device-tools';
import type { LiveSurfaceRecord } from '@kontourai/station-contracts/live-surface';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../hooks/useActiveProject', () => ({
  useActiveProject: () => ({
    projectSlug: 'app',
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
import {
  DEVICE_TOOLS_DOCK_MIN_WIDTH,
  DeviceWorkspacePane,
  deviceToolsLayout,
} from '../DeviceWorkspacePane';
import {
  authorizeScope,
  click,
  type DeviceFetchPlan,
  frameRecord,
  IOS_DEVICE,
  readyInventory,
  renderInQueryClient,
  stateRecord,
  stubDeviceFetch,
} from './deviceWorkspacePaneHarness';

/** A width for every `.device-pane__workspace`, and a way to change it. */
let workspaceWidth = 900;
const observers = new Set<() => void>();

beforeEach(() => {
  authorizeScope();
  workspaceWidth = 900;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains('device-pane__workspace'))
        return { width: workspaceWidth, height: 600 } as DOMRect;
      return original.call(this);
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe() {
        observers.add(this.callback);
      }
      disconnect() {
        observers.delete(this.callback);
      }
      unobserve() {}
    },
  );
});
afterEach(() => {
  cleanup();
  observers.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setClientCredentialResolver();
  localStorage.clear();
});

function resize(width: number) {
  workspaceWidth = width;
  act(() => {
    for (const callback of observers) callback();
  });
}

function snapshot(
  overrides: Partial<DeviceToolsSnapshot> = {},
): DeviceToolsSnapshot {
  return {
    hostId: 'local',
    platform: 'ios',
    deviceId: IOS_DEVICE.deviceId,
    readAt: '2026-09-23T10:00:00.000Z',
    foregroundApp: { state: 'read', value: { appId: 'com.apple.Preferences' } },
    appearance: { state: 'read', value: 'dark' },
    location: { state: 'unreadable', reason: 'unsupported' },
    capabilities: {
      appearance: true,
      location: true,
      clearLocation: true,
      push: true,
      permissions: ['photos', 'location'],
      permissionDecisions: ['grant', 'revoke', 'reset'],
      accessibility: true,
    },
    ...overrides,
  };
}

const TREE: DeviceAccessibilityTree = {
  space: { width: 400, height: 800 },
  elements: [
    {
      id: 'settings',
      label: 'Settings',
      role: 'Button',
      x: 0.1,
      y: 0.1,
      width: 0.5,
      height: 0.05,
    },
  ],
  truncated: false,
  readAt: '2026-09-23T10:00:00.000Z',
};

type ToolsHandler = NonNullable<DeviceFetchPlan['tools']>;

async function openDevice(tools: ToolsHandler) {
  const log = stubDeviceFetch({
    inventory: readyInventory([IOS_DEVICE]),
    tools,
  });
  renderInQueryClient(<DeviceWorkspacePane />);
  await click(
    await screen.findByRole('button', { name: 'Open iPhone 17 Pro' }),
  );
  await waitFor(() => expect(log.streams).toHaveLength(1));
  const surfaceId = decodeURIComponent(
    new URL(log.streams[0]!.url).pathname.split('/').at(-2)!,
  );
  const push = (record: LiveSurfaceRecord) => log.streams[0]!.push(record);
  await push(stateRecord(surfaceId, { inputChannel: 'connected' }));
  return { log, surfaceId, push };
}

const toolsRequests = (log: ReturnType<typeof stubDeviceFetch>, leaf = '') =>
  log.requests.filter((request) =>
    new URL(request.url).pathname.endsWith(`/tools${leaf}`),
  );

describe('the Tools drawer', () => {
  test('the toolbar Tools button opens it, and it shows what the device reported', async () => {
    const { log } = await openDevice(({ method, path }) =>
      method === 'GET' && path.endsWith('/tools')
        ? { body: { success: true, data: snapshot() } }
        : undefined,
    );
    const tools = screen.getByRole('button', { name: 'Tools' });
    expect(tools.getAttribute('aria-expanded')).toBe('false');
    await click(tools);
    expect(tools.getAttribute('aria-expanded')).toBe('true');
    const drawer = await screen.findByRole('complementary', { name: 'Tools' });
    // The toggle names the region it controls.
    expect(drawer.id).not.toBe('');
    expect(tools.getAttribute('aria-controls')).toBe(drawer.id);
    expect(
      await within(drawer).findByText('com.apple.Preferences'),
    ).toBeTruthy();
    expect(
      within(drawer).getByText('The device reports dark mode.'),
    ).toBeTruthy();
    expect(
      within(drawer)
        .getByRole('button', { name: 'Dark' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    // iOS cannot report location: said, not guessed.
    expect(
      within(drawer).getByText('This device cannot report it.'),
    ).toBeTruthy();
    // The Project the pane is in is named on every tools request (D12).
    expect(
      new URL(toolsRequests(log)[0]!.url).searchParams.get('projectSlug'),
    ).toBe('app');
  });

  test('after an action it shows the device’s READ-BACK, not the value asked for', async () => {
    const { log } = await openDevice(({ method, path, body }) => {
      if (method === 'GET' && path.endsWith('/tools'))
        return { body: { success: true, data: snapshot() } };
      if (method === 'POST' && path.endsWith('/tools/actions'))
        return {
          body: {
            success: true,
            data: {
              action: (body as { type: string }).type,
              // The device refused to change: it still reports dark.
              snapshot: snapshot(),
            },
          },
        };
      return undefined;
    });
    await click(screen.getByRole('button', { name: 'Tools' }));
    const drawer = await screen.findByRole('complementary', { name: 'Tools' });
    await within(drawer).findByText('The device reports dark mode.');
    await click(within(drawer).getByRole('button', { name: 'Light' }));
    await waitFor(() => expect(toolsRequests(log, '/actions')).toHaveLength(1));
    expect(toolsRequests(log, '/actions')[0]!.body).toEqual({
      type: 'set-appearance',
      appearance: 'light',
    });
    await waitFor(() =>
      expect(
        within(drawer)
          .getByRole('button', { name: 'Light' })
          .getAttribute('aria-pressed'),
      ).toBe('false'),
    );
    expect(
      within(drawer).getByText('The device reports dark mode.'),
    ).toBeTruthy();
  });

  test('iOS location after a set is labelled as last set from Station', async () => {
    await openDevice(({ method, path }) => {
      if (method === 'GET' && path.endsWith('/tools'))
        return { body: { success: true, data: snapshot() } };
      if (method === 'POST' && path.endsWith('/tools/actions'))
        return {
          body: {
            success: true,
            data: {
              action: 'set-location',
              snapshot: snapshot({
                location: {
                  state: 'last-set',
                  value: { latitude: 51.5074, longitude: -0.1278 },
                  setAt: '2026-09-23T10:00:00.000Z',
                },
              }),
            },
          },
        };
      return undefined;
    });
    await click(screen.getByRole('button', { name: 'Tools' }));
    const drawer = await screen.findByRole('complementary', { name: 'Tools' });
    await within(drawer).findByText('com.apple.Preferences');
    await click(within(drawer).getByRole('button', { name: 'London' }));
    expect(
      await within(drawer).findByText(
        /Last set from Station at .*: 51\.5074, -0\.1278\. This device cannot report its location back\./,
      ),
    ).toBeTruthy();
  });

  test('someone else controlling the device is said plainly', async () => {
    await openDevice(({ method, path }) => {
      if (method === 'GET' && path.endsWith('/tools'))
        return { body: { success: true, data: snapshot() } };
      if (method === 'POST')
        return {
          status: 409,
          body: { success: false, code: 'device-controlled-by-other' },
        };
      return undefined;
    });
    await click(screen.getByRole('button', { name: 'Tools' }));
    const drawer = await screen.findByRole('complementary', { name: 'Tools' });
    await within(drawer).findByText('com.apple.Preferences');
    await click(within(drawer).getByRole('button', { name: 'Light' }));
    expect((await within(drawer).findByRole('alert')).textContent).toContain(
      'Someone else is controlling this device',
    );
  });

  test('a push over 4 KB cannot be sent from the drawer', async () => {
    await openDevice(({ method, path }) =>
      method === 'GET' && path.endsWith('/tools')
        ? { body: { success: true, data: snapshot() } }
        : undefined,
    );
    await click(screen.getByRole('button', { name: 'Tools' }));
    const drawer = await screen.findByRole('complementary', { name: 'Tools' });
    await within(drawer).findByText('com.apple.Preferences');
    const payload = within(drawer).getByLabelText('Payload (JSON)');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(payload, {
      target: {
        value: JSON.stringify({ aps: { alert: 'x'.repeat(4100) } }),
      },
    });
    expect(
      within(drawer).getByRole('button', { name: 'Send push' }),
    ).toHaveProperty('disabled', true);
    expect(within(drawer).getByText(/allows 4096/)).toBeTruthy();
  });
});

describe('drawer layout (container width)', () => {
  test('the boundary: overlay below 560px, docked at 560px and above', () => {
    expect(DEVICE_TOOLS_DOCK_MIN_WIDTH).toBe(560);
    expect(deviceToolsLayout(0)).toBe('overlay');
    expect(deviceToolsLayout(559.5)).toBe('overlay');
    expect(deviceToolsLayout(560)).toBe('docked');
    expect(deviceToolsLayout(1200)).toBe('docked');
  });

  test('the drawer follows the measured width of the pane as it is resized', async () => {
    await openDevice(({ method, path }) =>
      method === 'GET' && path.endsWith('/tools')
        ? { body: { success: true, data: snapshot() } }
        : undefined,
    );
    await click(screen.getByRole('button', { name: 'Tools' }));
    const drawer = await screen.findByRole('complementary', { name: 'Tools' });
    expect(drawer.getAttribute('data-layout')).toBe('docked');
    expect(drawer.className).toContain('device-tools--docked');
    resize(559);
    expect(drawer.getAttribute('data-layout')).toBe('overlay');
    expect(drawer.className).toContain('device-tools--overlay');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Tools' })).toBeNull(),
    );
    resize(560);
    await click(screen.getByRole('button', { name: 'Tools' }));
    expect(
      (
        await screen.findByRole('complementary', { name: 'Tools' })
      ).getAttribute('data-layout'),
    ).toBe('docked');
  });
});

describe('drawer focus (S5)', () => {
  const handler: ToolsHandler = ({ method, path }) =>
    method === 'GET' && path.endsWith('/tools')
      ? { body: { success: true, data: snapshot() } }
      : undefined;

  test('opening moves focus into the drawer; Close and Escape return it to the Tools button', async () => {
    const { fireEvent } = await import('@testing-library/react');
    await openDevice(handler);
    const tools = screen.getByRole('button', { name: 'Tools' });
    await click(tools);
    const drawer = await screen.findByRole('complementary', { name: 'Tools' });
    await waitFor(() => expect(document.activeElement).toBe(drawer));
    await click(within(drawer).getByRole('button', { name: 'Close tools' }));
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Tools' })).toBeNull(),
    );
    expect(document.activeElement).toBe(tools);

    await click(tools);
    const again = await screen.findByRole('complementary', { name: 'Tools' });
    await waitFor(() => expect(document.activeElement).toBe(again));
    fireEvent.keyDown(again, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Tools' })).toBeNull(),
    );
    expect(document.activeElement).toBe(tools);
  });

  test('a docked↔overlay flip (a resize) does not move focus', async () => {
    await openDevice(handler);
    await click(screen.getByRole('button', { name: 'Tools' }));
    const drawer = await screen.findByRole('complementary', { name: 'Tools' });
    await within(drawer).findByText('com.apple.Preferences');
    const light = within(drawer).getByRole('button', { name: 'Light' });
    light.focus();
    resize(559);
    expect(drawer.getAttribute('data-layout')).toBe('overlay');
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.activeElement).toBe(light);
    resize(900);
    expect(drawer.getAttribute('data-layout')).toBe('docked');
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.activeElement).toBe(light);
  });
});

describe('drawer controls (review nits)', () => {
  async function openDrawer(tools: ToolsHandler) {
    const env = await openDevice(tools);
    await click(screen.getByRole('button', { name: 'Tools' }));
    const drawer = await screen.findByRole('complementary', { name: 'Tools' });
    await within(drawer).findByText('com.apple.Preferences');
    return { ...env, drawer };
  }

  test('a decimal comma is accepted for coordinates; a bad value says what is needed', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const { log, drawer } = await openDrawer(({ method, path }) => {
      if (method === 'GET' && path.endsWith('/tools'))
        return { body: { success: true, data: snapshot() } };
      if (method === 'POST')
        return {
          body: {
            success: true,
            data: { action: 'set-location', snapshot: snapshot() },
          },
        };
      return undefined;
    });
    const latitude = within(drawer).getByLabelText('Latitude');
    const longitude = within(drawer).getByLabelText('Longitude');
    const set = within(drawer).getByRole('button', { name: 'Set location' });
    fireEvent.change(latitude, { target: { value: '51,5074' } });
    fireEvent.change(longitude, { target: { value: 'west' } });
    expect(set).toHaveProperty('disabled', true);
    expect(
      within(drawer).getByText(/Enter a latitude from -90 to 90/),
    ).toBeTruthy();
    fireEvent.change(longitude, { target: { value: '-0,1278' } });
    expect(set).toHaveProperty('disabled', false);
    await click(set);
    await waitFor(() => expect(toolsRequests(log, '/actions')).toHaveLength(1));
    expect(toolsRequests(log, '/actions')[0]!.body).toEqual({
      type: 'set-location',
      latitude: 51.5074,
      longitude: -0.1278,
    });
  });

  test('a permission decision in flight disables every decision (no double send)', async () => {
    const { fireEvent } = await import('@testing-library/react');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const log = stubDeviceFetch({
      inventory: readyInventory([IOS_DEVICE]),
      tools: ({ method, path }) =>
        method === 'GET' && path.endsWith('/tools')
          ? { body: { success: true, data: snapshot() } }
          : undefined,
    });
    // Hold the action open: wrap fetch so POST …/actions waits.
    const inner = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/tools/actions')) {
          log.requests.push({
            method: 'POST',
            url: String(input),
            body: JSON.parse(String(init?.body)),
          });
          await held;
          return new Response(
            JSON.stringify({
              success: true,
              data: { action: 'set-permission', snapshot: snapshot() },
            }),
            { status: 200 },
          );
        }
        return inner(input, init);
      }),
    );
    renderInQueryClient(<DeviceWorkspacePane />);
    await click(
      await screen.findByRole('button', { name: 'Open iPhone 17 Pro' }),
    );
    await click(await screen.findByRole('button', { name: 'Tools' }));
    const drawer = await screen.findByRole('complementary', { name: 'Tools' });
    await within(drawer).findByText('com.apple.Preferences');
    const read = within(drawer).getByRole('button', {
      name: 'Read permissions',
    });
    // No app id: nothing can be read (and nothing is requested).
    expect(read).toHaveProperty('disabled', true);
    fireEvent.change(
      within(drawer).getByLabelText('App (bundle id or package)'),
      {
        target: { value: 'com.example.app' },
      },
    );
    const decisions = within(drawer).getByRole('group', {
      name: 'Permission decision',
    });
    await click(within(decisions).getByRole('button', { name: 'Grant' }));
    for (const name of ['Grant', 'Revoke', 'Reset'])
      expect(
        within(decisions).getByRole('button', { name }),
        name,
      ).toHaveProperty('disabled', true);
    await click(within(decisions).getByRole('button', { name: 'Revoke' }));
    expect(toolsRequests(log, '/actions')).toHaveLength(1);
    await act(async () => release());
  });

  test('Read permissions asks only for the typed app id, never an empty or stale one', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const { log, drawer } = await openDrawer(({ method, path, search }) => {
      if (method === 'GET' && path.endsWith('/tools'))
        return { body: { success: true, data: snapshot() } };
      if (method === 'GET' && path.endsWith('/tools/permissions'))
        return {
          body: {
            success: true,
            data: {
              appId: search.get('appId'),
              permissions: { state: 'unreadable', reason: 'unsupported' },
            },
          },
        };
      return undefined;
    });
    fireEvent.change(
      within(drawer).getByLabelText('App (bundle id or package)'),
      { target: { value: 'com.example.app' } },
    );
    await click(
      within(drawer).getByRole('button', { name: 'Read permissions' }),
    );
    await within(drawer).findByText(/cannot report permission state/);
    const asked = toolsRequests(log, '/permissions').map((request) =>
      new URL(request.url).searchParams.get('appId'),
    );
    expect(asked).toEqual(['com.example.app']);
  });

  test('a 409 held by the same person elsewhere says so', async () => {
    const { drawer } = await openDrawer(({ method, path }) => {
      if (method === 'GET' && path.endsWith('/tools'))
        return { body: { success: true, data: snapshot() } };
      if (method === 'POST')
        return {
          status: 409,
          body: {
            success: false,
            code: 'device-controlled-by-other',
            heldBy: 'same-person-elsewhere',
          },
        };
      return undefined;
    });
    await click(within(drawer).getByRole('button', { name: 'Light' }));
    expect((await within(drawer).findByRole('alert')).textContent).toContain(
      'Control is held on another device or browser',
    );
  });
});

describe('the accessibility overlay', () => {
  function treeHandler(tree = TREE): ToolsHandler {
    return ({ method, path }) => {
      if (method === 'GET' && path.endsWith('/tools'))
        return { body: { success: true, data: snapshot() } };
      if (method === 'GET' && path.endsWith('/tools/accessibility'))
        return { body: { success: true, data: tree } };
      return undefined;
    };
  }

  test('off: the tree is never requested', async () => {
    const { log, surfaceId, push } = await openDevice(treeHandler());
    await push(frameRecord(surfaceId, 1, { width: 400, height: 800 }));
    await click(screen.getByRole('button', { name: 'Tools' }));
    await screen.findByText('com.apple.Preferences');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(toolsRequests(log, '/accessibility')).toHaveLength(0);
    expect(screen.queryByTestId('device-ax-overlay')).toBeNull();
  });

  test('on and live: frames are drawn where the tree says, labelled', async () => {
    const { log, surfaceId, push } = await openDevice(treeHandler());
    await push(frameRecord(surfaceId, 1, { width: 400, height: 800 }));
    await click(screen.getByRole('button', { name: 'Tools' }));
    await click(
      await screen.findByRole('button', { name: 'Show accessibility frames' }),
    );
    const overlay = await screen.findByTestId('device-ax-overlay');
    const frame = overlay.querySelector<HTMLElement>(
      '[data-ax-id="settings"]',
    )!;
    expect(frame.style.left).toBe('10%');
    expect(frame.style.top).toBe('10%');
    expect(frame.style.width).toBe('50%');
    expect(frame.style.height).toBe('5%');
    expect(frame.textContent).toBe('Settings');
    expect(toolsRequests(log, '/accessibility').length).toBeGreaterThan(0);
    expect(
      await screen.findByText(/1 element outlined, re-read every 2 seconds/),
    ).toBeTruthy();
  });

  test('a quarter-turned frame with a tree in the raw panel orientation is turned too', async () => {
    const { surfaceId, push } = await openDevice(treeHandler());
    // The raw frame is portrait (400x800) and drawn turned 90° clockwise.
    await push({
      kind: 'frame',
      header: {
        surfaceId,
        seq: 1,
        epoch: 0,
        codec: 'jpeg',
        width: 400,
        height: 800,
        deviceScaleFactor: 1,
        capturedAt: 1,
        rotation: 90,
      },
      body: new Uint8Array([1]),
    });
    await click(screen.getByRole('button', { name: 'Tools' }));
    await click(
      await screen.findByRole('button', { name: 'Show accessibility frames' }),
    );
    const overlay = await screen.findByTestId('device-ax-overlay');
    const frame = overlay.querySelector<HTMLElement>(
      '[data-ax-id="settings"]',
    )!;
    // (x, y, w, h) = (0.1, 0.1, 0.5, 0.05) turned 90° → (0.85, 0.1, 0.05, 0.5).
    expect(Number.parseFloat(frame.style.left)).toBeCloseTo(85);
    expect(Number.parseFloat(frame.style.top)).toBeCloseTo(10);
    expect(Number.parseFloat(frame.style.width)).toBeCloseTo(5);
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(50);
  });

  test('a tree cut by the byte cap says how many are drawn, not a fixed 500 (D3)', async () => {
    // What the server sends when the RESPONSE byte cap (not the element
    // cap) cut the tree: 116 elements, truncated.
    const cut: DeviceAccessibilityTree = {
      ...TREE,
      elements: Array.from({ length: 116 }, (_, index) => ({
        ...TREE.elements[0]!,
        id: `e${index}`,
      })),
      truncated: true,
    };
    const { surfaceId, push } = await openDevice(treeHandler(cut));
    await push(frameRecord(surfaceId, 1, { width: 400, height: 800 }));
    await click(screen.getByRole('button', { name: 'Tools' }));
    await click(
      await screen.findByRole('button', { name: 'Show accessibility frames' }),
    );
    const line = await screen.findByText(/116 elements outlined/);
    expect(line.textContent).toBe(
      '116 elements outlined, re-read every 2 seconds. The tree was larger; only these 116 are shown.',
    );
    expect(line.textContent).not.toContain('500');
  });

  test('polled every 2 s while on, and not at all once turned off', async () => {
    const { log, surfaceId, push } = await openDevice(treeHandler());
    await push(frameRecord(surfaceId, 1, { width: 400, height: 800 }));
    await click(screen.getByRole('button', { name: 'Tools' }));
    await click(
      await screen.findByRole('button', { name: 'Show accessibility frames' }),
    );
    await screen.findByTestId('device-ax-overlay');
    const first = toolsRequests(log, '/accessibility').length;
    await act(() => new Promise((resolve) => setTimeout(resolve, 2_300)));
    const second = toolsRequests(log, '/accessibility').length;
    expect(second).toBeGreaterThan(first);
    await click(
      screen.getByRole('button', { name: 'Hide accessibility frames' }),
    );
    expect(screen.queryByTestId('device-ax-overlay')).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 2_300)));
    expect(toolsRequests(log, '/accessibility').length).toBe(second);
  }, 15_000);

  test('on, but no frame drawn yet: nothing is read', async () => {
    const { log } = await openDevice(treeHandler());
    await click(screen.getByRole('button', { name: 'Tools' }));
    await click(
      await screen.findByRole('button', { name: 'Show accessibility frames' }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(toolsRequests(log, '/accessibility')).toHaveLength(0);
  });

  test('the overlay reads the tree only while the stream is visible', async () => {
    const { DeviceAccessibilityOverlay } = await import(
      '../device/DeviceToolsDrawer'
    );
    const log = stubDeviceFetch({ tools: treeHandler() });
    const props = {
      requestScope: {
        apiBase: 'http://station.test',
        authorityKey: 'authority-1',
      },
      projectSlug: 'app',
      target: {
        hostId: 'local',
        platform: 'ios' as const,
        deviceId: IOS_DEVICE.deviceId,
      },
      shown: { width: 400, height: 800 },
      rotation: 0 as const,
    };
    const view = renderInQueryClient(
      <DeviceAccessibilityOverlay {...props} visible={false} />,
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(toolsRequests(log, '/accessibility')).toHaveLength(0);
    expect(screen.queryByTestId('device-ax-overlay')).toBeNull();
    view.rerenderWrapped(<DeviceAccessibilityOverlay {...props} visible />);
    expect(await screen.findByTestId('device-ax-overlay')).toBeTruthy();
    expect(toolsRequests(log, '/accessibility')).toHaveLength(1);
    // Hidden again: the frames go and polling stops.
    view.rerenderWrapped(
      <DeviceAccessibilityOverlay {...props} visible={false} />,
    );
    expect(screen.queryByTestId('device-ax-overlay')).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 2_300)));
    expect(toolsRequests(log, '/accessibility')).toHaveLength(1);
  }, 10_000);
});

/**
 * #1973: the tools run on THIS Station. A device on an SSH device host gets
 * a clear notice, and neither the drawer nor the overlay asks anything.
 */
describe('a device on an SSH device host (#1973)', () => {
  const REMOTE_TARGET = {
    hostId: 'ssh-0123456789ab',
    platform: 'ios' as const,
    deviceId: IOS_DEVICE.deviceId,
  };
  const scope = { apiBase: 'http://station.test', authorityKey: 'authority-1' };

  test('the drawer says tools are for this Station only and requests nothing', async () => {
    const { DeviceToolsDrawer } = await import('../device/DeviceToolsDrawer');
    const log = stubDeviceFetch({
      tools: () => ({ body: { success: true, data: snapshot() } }),
    });
    renderInQueryClient(
      <DeviceToolsDrawer
        axOverlay={false}
        deviceName="Studio iPhone"
        id="tools"
        layout="docked"
        onAxOverlayChange={() => {}}
        onClose={() => {}}
        projectSlug="app"
        requestScope={scope}
        streamVisible
        target={REMOTE_TARGET}
      />,
    );
    const drawer = await screen.findByRole('complementary', { name: 'Tools' });
    expect(within(drawer).getByRole('status').textContent).toMatch(
      /only for simulators and emulators on this Station/,
    );
    expect(
      within(drawer).queryByRole('button', { name: /Refresh/ }),
    ).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(
      log.requests.filter((request) => request.url.includes('/tools')),
    ).toEqual([]);
  });

  test('the overlay never polls an SSH-host device', async () => {
    const { DeviceAccessibilityOverlay } = await import(
      '../device/DeviceToolsDrawer'
    );
    const log = stubDeviceFetch({
      tools: () => ({ body: { success: true, data: { elements: [] } } }),
    });
    renderInQueryClient(
      <DeviceAccessibilityOverlay
        projectSlug="app"
        requestScope={scope}
        rotation={0}
        shown={{ width: 400, height: 800 }}
        target={REMOTE_TARGET}
        visible
      />,
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(toolsRequests(log, '/accessibility')).toHaveLength(0);
  });
});
