/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeStationProfileStorage } from '../stationProfileStorage';

const entry = vi.hoisted(() => ({
  tree: null as ReactNode,
  native: true,
  relay: true,
  operator: vi.fn(),
  auth: vi.fn(),
  recovery: vi.fn(),
  session: vi.fn(),
  version: 0,
  repository: null as NativeStationProfileStorage | null,
  launch: null as unknown,
  nativeHandlers: new Map<number, (event: { payload: unknown }) => void>(),
  retired: vi.fn(),
  listeners: new Set<() => void>(),
}));
function Through({ children }: { children: ReactNode }) {
  return children;
}
vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>();
  const createRoot: typeof actual.createRoot = (container, options) => {
    if (container instanceof Element && container.id === 'root')
      return {
        render: (tree) => {
          entry.tree = tree;
        },
        unmount: () => {},
      };
    return actual.createRoot(container, options);
  };
  return { ...actual, createRoot, default: { ...actual, createRoot } };
});
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  useConnections: () => {
    useSyncExternalStore(
      (listener) => {
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      () => entry.version,
    );
    return {
      activeConnection: entry.relay
        ? {
            id: 'native-route',
            nativeBrokerRoute: {
              routeVersion: 1,
              profileName: 'home',
              profileRevision: 7,
              brokerOrigin: 'https://broker.example.test',
              stationId: '11111111-1111-4111-8111-111111111111',
              enrollmentId: '22222222-2222-4222-8222-222222222222',
            },
          }
        : { id: 'direct-route' },
    };
  },
}));
vi.mock('../../PlatformProfileContext', () => ({
  PlatformBootstrap: Through,
  nativeProfileRepository: () => entry.repository,
  usePlatformProfile: () => ({
    isTauri: entry.native,
    isMobile: true,
    isDesktop: false,
    target: 'ios',
    channel: 'nightly',
    isDevBuild: false,
  }),
}));
vi.mock('../../PlatformSessionGate', () => ({
  PlatformSessionGate: ({ children }: { children: ReactNode }) => {
    entry.session();
    return children;
  },
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  ApiBaseProvider: Through,
}));
vi.mock('../../../contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => {
    entry.auth();
    return children;
  },
}));
vi.mock('../../../contexts/RecoveryQueryBoundary', () => ({
  RecoveryQueryBoundary: ({ children }: { children: ReactNode }) => {
    entry.recovery();
    return children;
  },
}));
vi.mock('../../../contexts/AuthorityQueryContext', () => ({
  AuthorityQueryProvider: Through,
}));
vi.mock('../../../contexts/ActiveChatsContext', () => ({
  ActiveChatsProvider: Through,
}));
vi.mock('../../../contexts/AnalyticsContext', () => ({
  AnalyticsProvider: Through,
}));
vi.mock('../../../contexts/ConversationsContext', () => ({
  ConversationsProvider: Through,
}));
vi.mock('../../../contexts/KeyboardShortcutsContext', () => ({
  KeyboardShortcutsProvider: Through,
}));
vi.mock('../../../contexts/MessageContextContext', () => ({
  MessageContextContext: Through,
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  NavigationProvider: Through,
}));
vi.mock('../../../contexts/PreviewContext', () => ({
  PreviewProvider: Through,
}));
vi.mock('../../../contexts/RegionModelContext', () => ({
  RegionModelProvider: Through,
}));
vi.mock('../../../contexts/SyntaxHighlighterContext', () => ({
  SyntaxHighlighterProvider: Through,
}));
vi.mock('../../../contexts/ToastContext', () => ({
  ToastProvider: Through,
}));
vi.mock('../../../contexts/VoiceProviderContext', () => ({
  VoiceProviderContext: Through,
}));
vi.mock('../../../core/PermissionManager', () => ({
  PermissionManager: Through,
}));
vi.mock('../../../components/DeferredCapabilityBoundary', () => ({
  DeferredCapabilityBoundary: () => null,
}));
vi.mock('../../../components/BrandingThemeBridge', () => ({
  BrandingThemeBridge: () => null,
}));
vi.mock('../../../components/notifications/NotificationContainer', () => ({
  NotificationContainer: () => null,
}));
vi.mock('../rendererLiveness', () => ({
  NativeRendererMountCommit: () => null,
}));
vi.mock('../../../core/pluginSharedRuntime', () => ({
  installPluginSharedRuntime: () => {},
}));
vi.mock('../../../hooks/useMobileVisualViewport', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../hooks/useMobileVisualViewport')
  >()),
  installVisualViewportInset: () => {},
}));
vi.mock('../../androidSafeArea', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../androidSafeArea')>()),
  installAndroidSafeArea: () => {},
}));
vi.mock('../../../providers/context/index', () => ({}));
vi.mock('../../../providers/voice/index', () => ({}));
vi.mock('../../../views/native-relay/NativeRelayMemberShell', () => ({
  NativeRelayMemberShell: () => {
    useEffect(() => () => entry.retired(), []);
    return <div>Native member entry</div>;
  },
}));
vi.mock('../../../App', () => ({
  default: () => {
    entry.operator();
    return <div>Operator workspace</div>;
  },
}));
afterEach(() => cleanup());
it('the actual main entry cuts native routes above operator providers through pending account and selection changes', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState({}, '', '/');
  Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
    configurable: true,
    value: { unregisterListener: () => {} },
  });
  const intent = {
    kind: 'route-intent',
    pendingId: '33333333-3333-4333-8333-333333333333',
    route: {
      applicationOrigin: 'https://station.example.test',
      brokerOrigin: 'https://broker.example.test',
      stationId: '11111111-1111-4111-8111-111111111111',
      enrollmentId: '22222222-2222-4222-8222-222222222222',
    },
  };
  entry.launch = intent;
  entry.repository = new NativeStationProfileStorage();
  let callbackId = 0;
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      transformCallback: (handler: (event: { payload: unknown }) => void) => {
        entry.nativeHandlers.set(++callbackId, handler);
        return callbackId;
      },
      unregisterCallback: () => {},
      invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === 'plugin:event|listen') return args.handler;
        if (command === 'plugin:event|unlisten') {
          entry.nativeHandlers.delete(Number(args.eventId));
          return;
        }
        if (command === 'station_native_relay_link_take') return entry.launch;
        if (command === 'station_native_relay_link_cancel') {
          entry.launch = null;
          return;
        }
        throw new Error('Unexpected native command');
      },
    },
  });
  await import('../../../main');
  if (!entry.tree) throw new Error('main did not construct its actual root');
  const mounted = render(entry.tree);
  await screen.findByRole('dialog', { name: /Connect to /u });
  expect(screen.queryByText('Native member entry')).toBeNull();
  expect(entry.auth).not.toHaveBeenCalled();
  expect(entry.operator).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await screen.findByText('Native member entry');
  expect(entry.auth).not.toHaveBeenCalled();
  expect(entry.recovery).not.toHaveBeenCalled();
  expect(entry.session).not.toHaveBeenCalled();
  expect(entry.operator).not.toHaveBeenCalled();
  entry.retired.mockClear();
  await act(async () => {
    for (const handler of entry.nativeHandlers.values())
      handler({
        payload: {
          ...intent,
          pendingId: '44444444-4444-4444-8444-444444444444',
        },
      });
  });
  await screen.findByRole('dialog', { name: /Connect to /u });
  expect(
    screen.getByText('Native member entry').closest('[inert]'),
  ).not.toBeNull();
  expect(entry.retired).not.toHaveBeenCalled();
  expect(entry.auth).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(entry.retired).not.toHaveBeenCalled();
  // Native classification does not consult an account-ready or login result.
  mounted.rerender(entry.tree);
  expect(screen.getByText('Native member entry')).toBeDefined();
  expect(entry.auth).not.toHaveBeenCalled();
  expect(entry.operator).not.toHaveBeenCalled();
  act(() => {
    entry.relay = false;
    entry.version++;
    for (const listener of entry.listeners) listener();
  });
  await screen.findByText('Operator workspace');
  expect(entry.auth).toHaveBeenCalled();
  expect(entry.recovery).toHaveBeenCalled();
  expect(entry.session).toHaveBeenCalled();
  const operatorCalls = entry.operator.mock.calls.length;
  const authCalls = entry.auth.mock.calls.length;
  await act(async () => {
    for (const handler of entry.nativeHandlers.values())
      handler({
        payload: {
          ...intent,
          pendingId: '55555555-5555-4555-8555-555555555555',
        },
      });
  });
  await screen.findByRole('dialog', { name: /Connect to /u });
  expect(
    screen.getByText('Operator workspace').closest('[inert]'),
  ).not.toBeNull();
  expect(entry.operator).toHaveBeenCalledTimes(operatorCalls);
  expect(entry.auth).toHaveBeenCalledTimes(authCalls);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  entry.operator.mockClear();
  entry.auth.mockClear();
  entry.recovery.mockClear();
  entry.session.mockClear();
  act(() => {
    entry.relay = true;
    entry.version++;
    for (const listener of entry.listeners) listener();
  });
  await screen.findByText('Native member entry');
  expect(entry.auth).not.toHaveBeenCalled();
  expect(entry.recovery).not.toHaveBeenCalled();
  expect(entry.session).not.toHaveBeenCalled();
  expect(entry.operator).not.toHaveBeenCalled();
  act(() => {
    entry.native = false;
    entry.version++;
    for (const listener of entry.listeners) listener();
  });
  await screen.findByText('Operator workspace');
  expect(entry.auth).toHaveBeenCalled();
});
