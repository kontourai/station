// @vitest-environment jsdom
/**
 * Desktop notification-alert clicks through the app's real overlay mount:
 * DeferredAppOverlays' listener takes the native host's record and hands it
 * to the mounted notification opener, only in the desktop main window.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NOTIFICATION_OPEN_EVENT } from '../../lib/notificationOpen';
import { setNotificationOpenNotice } from '../../lib/notificationStationOpen';

const A = {
  id: 'conn-a',
  name: 'Studio Mac',
  url: 'https://a.example',
  endpoints: [{ url: 'https://a.example' }],
  environmentId: 'env-a',
};

const host = vi.hoisted(() => ({
  profile: {} as Record<string, unknown>,
  taken: [] as unknown[],
  listeners: new Map<string, Set<() => void>>(),
  listens: [] as string[],
  takes: 0,
}));
const navigate = vi.hoisted(() => vi.fn());

// The Tauri event and command bridge the listener uses.
vi.mock('../../platform/native/tauriInvoke', () => ({
  listenTauri: async (event: string, handler: () => void) => {
    host.listens.push(event);
    const handlers = host.listeners.get(event) ?? new Set();
    handlers.add(handler);
    host.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  },
  invokeTauri: async (command: string) => {
    if (command !== 'take_notification_open_link')
      throw new Error(`unexpected native command ${command}`);
    host.takes += 1;
    return host.taken.shift() ?? null;
  },
}));
// The adapter the tray and launch-route listeners read: no tray click and no
// recorded phone tap (a phone's answer when nothing was tapped).
vi.mock('../../platform/native', () => ({
  nativePlatformPromise: Promise.resolve({
    subscribeToTrayNavigation: () => ({ dispose() {} }),
    subscribeToAgentActivityLaunchRoutes: () => ({
      dispose() {},
      ready: Promise.resolve(),
    }),
    takeAgentActivityLaunchRoute: async () => ({
      status: 'ok',
      value: { route: null },
    }),
  }),
}));
vi.mock('../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => host.profile,
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    connections: [A],
    activeConnection: A,
    setActiveConnection: vi.fn(),
    captureCredentialEvidence: () => ({ connectionId: A.id }),
  }),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate }),
}));
// Siblings with their own owners and no notification edge.
// AgentActivityLaunchRoutes opens notifications, so it stays real.
vi.mock('../CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../first-run/FirstRunFlow', () => ({ FirstRunFlow: () => null }));
vi.mock('../report-problem/ReportProblemHost', () => ({
  ReportProblemHost: () => null,
}));
vi.mock('../troubleshoot/TroubleshootHost', () => ({
  TroubleshootHost: () => null,
}));
vi.mock('../scheduler/SchedulerJobDialogHost', () => ({
  SchedulerJobDialogHost: () => null,
}));
vi.mock('../remote-session/RemoteSessionReaderHost', () => ({
  RemoteSessionReaderHost: () => null,
}));
vi.mock('../notifications/HomeRecoveryBannerSource', () => ({
  HomeRecoveryBannerSource: () => null,
}));
vi.mock('../AgentActivityRefresher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../AgentActivityRefresher')>()),
  AgentActivityRefresher: () => null,
}));

const { default: DeferredAppOverlays } = await import('../DeferredAppOverlays');

// The shapes resolvePlatformProfile builds.
const native = { supervisesBundledServer: false, isDevBuild: false };
const MACOS = {
  ...native,
  isTauri: true,
  target: 'macos',
  isMobile: false,
  isDesktop: true,
};
const ANDROID = {
  ...native,
  isTauri: true,
  target: 'android',
  isMobile: true,
  isDesktop: false,
};
const UNREAD = {
  ...native,
  isTauri: true,
  target: 'unknown',
  isMobile: false,
  isDesktop: false,
};
const WEB = {
  ...native,
  isTauri: false,
  target: 'web',
  isMobile: false,
  isDesktop: false,
};

const originalInternals = Object.getOwnPropertyDescriptor(
  window,
  '__TAURI_INTERNALS__',
);
const setWindowLabel = (label: string) =>
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { metadata: { currentWindow: { label } } },
  });

const listening = () => host.listeners.get(NOTIFICATION_OPEN_EVENT)?.size ?? 0;
const emit = () => {
  for (const handler of host.listeners.get(NOTIFICATION_OPEN_EVENT) ?? [])
    handler();
};

beforeEach(() => {
  host.profile = MACOS;
  host.taken = [];
  host.listeners.clear();
  host.listens = [];
  host.takes = 0;
  navigate.mockClear();
});

afterEach(() => {
  cleanup();
  act(() => setNotificationOpenNotice(null));
  if (originalInternals)
    Object.defineProperty(window, '__TAURI_INTERNALS__', originalInternals);
  else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('desktop notification clicks through DeferredAppOverlays', () => {
  test('a click kept before the overlays mounted opens once on its Station', async () => {
    host.taken.push({
      link: '/?chat=thread-a&dock=open&openedNotification=n-1&station=env-a',
      origin: 'https://a.example',
    });
    render(<DeferredAppOverlays />);
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/', {
      chat: 'thread-a',
      dock: 'open',
      openedNotification: 'n-1',
    });
    expect(
      host.listens.filter((event) => event === NOTIFICATION_OPEN_EVENT),
    ).toHaveLength(1);
  });

  test('a later click from a Station not saved here is refused, not opened', async () => {
    render(<DeferredAppOverlays />);
    await waitFor(() => expect(host.takes).toBe(1));
    host.taken.push({
      link: '/?chat=thread-c&dock=open&station=env-c',
      origin: 'https://c.example',
    });
    act(emit);
    expect(await screen.findByText('Station not on this device')).toBeTruthy();
    expect(host.takes).toBe(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  test.each([
    ['the browser', WEB, undefined],
    ['a native shell whose platform could not be read', UNREAD, undefined],
    ['the mobile app', ANDROID, undefined],
    ['a desktop pop-out window', MACOS, 'workspace-pane-pop-out-1'],
  ])('%s never takes alert clicks', async (_label, profile, label) => {
    host.profile = profile;
    if (label) setWindowLabel(label);
    host.taken.push({ link: '/notifications', origin: 'https://a.example' });
    render(<DeferredAppOverlays />);
    // Long enough for a subscription to register; the gate's negative
    // controls prove it.
    await act(async () => {
      await import('../../platform/native/tauriInvoke');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.listens).not.toContain(NOTIFICATION_OPEN_EVENT);
    expect(host.takes).toBe(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  test('after unmounting, a click is neither taken nor opened', async () => {
    const view = render(<DeferredAppOverlays />);
    await waitFor(() => expect(host.takes).toBe(1));
    expect(listening()).toBe(1);
    view.unmount();
    expect(listening()).toBe(0);
    host.taken.push({ link: '/notifications', origin: 'https://a.example' });
    emit();
    expect(host.takes).toBe(1);
    expect(host.taken).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});
