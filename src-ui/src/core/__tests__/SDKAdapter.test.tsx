/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activeLayoutQuery: vi.fn(),
  layoutsQuery: vi.fn(),
  setApiBase: vi.fn(),
  setProviderFunctions: vi.fn(),
  shellToast: vi.fn(),
  useShellToast: vi.fn(),
  mountTelemetryPane: vi.fn(),
}));

const ambientNavigation = {
  selectedProject: 'ambient-project',
  selectedProjectLayout: 'ambient-layout',
  isDockOpen: false,
  setDockState: vi.fn(),
};

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  _setApiBase: mocks.setApiBase,
  _setProviderFunctions: mocks.setProviderFunctions,
  useProjectLayoutsQuery: mocks.layoutsQuery,
  useProjectLayoutQuery: mocks.activeLayoutQuery,
}));

vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  mountPluginTelemetryPane: mocks.mountTelemetryPane,
}));

const queryClients: QueryClient[] = [];
function render(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClients.push(client);
  return renderView(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

vi.mock('../../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({}),
  useActiveChatState: () => null,
}));
vi.mock('../../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://station.test' }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('../../contexts/ConversationsContext', () => ({
  useConversations: () => [],
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: (selector?: (state: typeof ambientNavigation) => unknown) =>
    selector ? selector(ambientNavigation) : ambientNavigation,
  useNavigationActions: () => ({
    setDockState: ambientNavigation.setDockState,
  }),
}));
vi.mock('../../contexts/ToastContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../contexts/ToastContext')>();
  return {
    ...actual,
    useToast: mocks.useShellToast,
  };
});
vi.mock('../../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
  useCreateChatSession: () => vi.fn(),
  useOpenConversation: () => vi.fn(),
  useLaunchChat: () => vi.fn(),
}));

import {
  useDockState,
  useLayout,
  useNavigation,
  useSDK,
  useTelemetry,
  useToast,
} from '@kontourai/station-sdk';
import { ToastProvider, toastStore } from '../../contexts/ToastContext';
import { SDKAdapter } from '../SDKAdapter';

const paneLayout = {
  name: 'Bound Pane',
  slug: 'pane-instance',
  tabs: [],
};

function Probe() {
  const navigation = useNavigation();
  const layout = useLayout('ambient-layout');
  const { showToast } = useToast();
  return (
    <>
      <output data-testid="project">{navigation.selectedProject}</output>
      <output data-testid="selected-layout">
        {navigation.selectedProjectLayout ?? 'none'}
      </output>
      <output data-testid="layout">{layout.data?.slug}</output>
      <button
        type="button"
        onClick={() =>
          showToast({
            type: 'success',
            message: 'Bound toast',
            duration: 123,
          })
        }
      >
        Object toast
      </button>
      <button
        type="button"
        onClick={() => showToast('String warning', 'warning', 321)}
      >
        String toast
      </button>
    </>
  );
}

function IdentityProbe({
  label,
  onCall,
}: {
  label: string;
  onCall: (value: { pluginName: string; header: string }) => void;
}) {
  const sdk = useSDK();
  return (
    <button
      type="button"
      onClick={() =>
        onCall({
          pluginName: sdk.pluginName,
          header: sdk.getPluginHeaders()['x-station-plugin'],
        })
      }
    >
      {label}
    </button>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  let occurrence = 0;
  mocks.mountTelemetryPane.mockImplementation(
    async (_apiBase: string, plugin: string) => ({
      token: `${plugin}-${++occurrence}`,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    }),
  );
  mocks.useShellToast.mockImplementation(() => ({
    showToast: mocks.shellToast,
  }));
  mocks.layoutsQuery.mockReturnValue({ data: [] });
  mocks.activeLayoutQuery.mockReturnValue({ data: undefined });
});

afterEach(() => {
  cleanup();
  for (const client of queryClients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  toastStore.dismissAll();
  toastStore.clearHistory();
});

function ActionToastProbe({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const { showToast } = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        showToast({
          message: 'Saved',
          type: 'success',
          duration: 0,
          action: { label, onClick },
        })
      }
    >
      {label}
    </button>
  );
}

test('identical toast copy from separate Pane actions retains each exact callback', async () => {
  const actual = await vi.importActual<
    typeof import('../../contexts/ToastContext')
  >('../../contexts/ToastContext');
  mocks.useShellToast.mockImplementation(actual.useToast);
  const first = vi.fn();
  const second = vi.fn();
  render(
    <ToastProvider>
      <SDKAdapter
        layout={paneLayout}
        boundProjectSlug="project-alpha"
        boundPluginName="plugin-alpha"
      >
        <ActionToastProbe label="Open A" onClick={first} />
      </SDKAdapter>
      <SDKAdapter
        layout={paneLayout}
        boundProjectSlug="project-beta"
        boundPluginName="plugin-beta"
      >
        <ActionToastProbe label="Open B" onClick={second} />
      </SDKAdapter>
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open A' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
  const toasts = toastStore.getSnapshot();
  expect(toasts).toHaveLength(2);
  expect(toasts[0].id).not.toBe(toasts[1].id);
  expect(toasts.map((t) => t.actions?.[0].label)).toEqual(['Open A', 'Open B']);
  toasts[1].actions?.[0].onClick();
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
  const plainId = toastStore.show(
    'Saved',
    undefined,
    0,
    undefined,
    undefined,
    'success',
  );
  expect(toastStore.getSnapshot()).toHaveLength(3);
  expect(
    toastStore.getSnapshot().find((t) => t.id === plainId)?.actions,
  ).toBeUndefined();
  expect(
    toastStore.show('Saved', undefined, 0, undefined, undefined, 'success'),
  ).toBe(plainId);
});

test('binds SDK navigation and layout reads to the admitted Pane Project', () => {
  const { rerender } = render(
    <SDKAdapter
      layout={paneLayout}
      boundProjectSlug="project-alpha"
      boundPluginName="plugin-alpha"
    >
      <Probe />
    </SDKAdapter>,
  );

  expect(screen.getByTestId('project').textContent).toBe('project-alpha');
  expect(screen.getByTestId('selected-layout').textContent).toBe('none');
  expect(screen.getByTestId('layout').textContent).toBe('pane-instance');
  expect(mocks.layoutsQuery).toHaveBeenCalledWith('project-alpha', {
    enabled: true,
  });
  expect(mocks.activeLayoutQuery).toHaveBeenCalledWith('project-alpha', '', {
    enabled: false,
  });
  expect(ambientNavigation).toMatchObject({
    selectedProject: 'ambient-project',
    selectedProjectLayout: 'ambient-layout',
  });

  rerender(
    <SDKAdapter
      layout={paneLayout}
      boundProjectSlug="project-beta"
      boundPluginName="plugin-beta"
    >
      <Probe />
    </SDKAdapter>,
  );
  expect(screen.getByTestId('project').textContent).toBe('project-beta');
  expect(ambientNavigation.selectedProject).toBe('ambient-project');
});

test('normalizes the documented object-form plugin toast at the shell seam', () => {
  render(
    <SDKAdapter
      layout={paneLayout}
      boundProjectSlug="project-alpha"
      boundPluginName="plugin-alpha"
    >
      <Probe />
    </SDKAdapter>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Object toast' }));
  expect(mocks.shellToast).toHaveBeenCalledWith(
    'Bound toast',
    undefined,
    123,
    undefined,
    'success',
  );
  fireEvent.click(screen.getByRole('button', { name: 'String toast' }));
  expect(mocks.shellToast).toHaveBeenCalledWith(
    'String warning',
    undefined,
    321,
    undefined,
    'warning',
  );
});

test('keeps simultaneous Pane API identities owner-correct across interleaved calls and unmount', () => {
  const calls: Array<{
    pane: string;
    pluginName: string;
    header: string;
  }> = [];
  const record =
    (pane: string) => (value: { pluginName: string; header: string }) =>
      calls.push({ pane, ...value });
  const first = (
    <SDKAdapter
      key="first"
      layout={{ ...paneLayout, slug: 'first-occurrence' }}
      boundProjectSlug="project-alpha"
      boundPluginName="plugin-alpha"
    >
      <IdentityProbe label="Call first" onCall={record('first')} />
    </SDKAdapter>
  );
  const second = (
    <SDKAdapter
      key="second"
      layout={{ ...paneLayout, slug: 'second-occurrence' }}
      boundProjectSlug="project-alpha"
      boundPluginName="plugin-beta"
    >
      <IdentityProbe label="Call second" onCall={record('second')} />
    </SDKAdapter>
  );
  const view = render(
    <>
      {first}
      {second}
    </>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Call second' }));
  fireEvent.click(screen.getByRole('button', { name: 'Call first' }));
  view.rerender(first);
  fireEvent.click(screen.getByRole('button', { name: 'Call first' }));

  expect(calls).toEqual([
    { pane: 'second', pluginName: 'plugin-beta', header: 'plugin-beta' },
    { pane: 'first', pluginName: 'plugin-alpha', header: 'plugin-alpha' },
    { pane: 'first', pluginName: 'plugin-alpha', header: 'plugin-alpha' },
  ]);
});

function DockProbe() {
  const { isOpen, toggle } = useDockState();
  return (
    <button type="button" onClick={toggle}>
      {isOpen ? 'Dock open' : 'Dock closed'}
    </button>
  );
}

// #2399: `useDockState` read `navigation.dockState`, a field the host's
// navigation never had, so a plugin always saw a closed dock and `toggle`
// always asked to open it. The host publishes `isDockOpen`.
test('reads and toggles the host dock through useDockState', () => {
  ambientNavigation.isDockOpen = true;
  try {
    render(
      <SDKAdapter layout={paneLayout}>
        <DockProbe />
      </SDKAdapter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dock open' }));
    expect(ambientNavigation.setDockState).toHaveBeenCalledWith(false);
  } finally {
    ambientNavigation.isDockOpen = false;
  }
});

function ActionsToastProbe({
  first,
  second,
}: {
  first: () => void;
  second: () => void;
}) {
  const { showToast } = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        showToast({
          message: 'Notes saved',
          duration: 0,
          action: { label: 'Undo', onClick: first },
          actions: [{ label: 'View', variant: 'primary', onClick: second }],
        })
      }
    >
      Save notes
    </button>
  );
}

// #2399: the host renders several toast buttons, and the enterprise-layout
// example passed them as a fourth positional argument the SDK form never
// carried, so they were dropped. The object form carries them.
test('renders every button an object-form toast names, in order', async () => {
  const actual = await vi.importActual<
    typeof import('../../contexts/ToastContext')
  >('../../contexts/ToastContext');
  mocks.useShellToast.mockImplementation(actual.useToast);
  const first = vi.fn();
  const second = vi.fn();
  render(
    <ToastProvider>
      <SDKAdapter layout={paneLayout}>
        <ActionsToastProbe first={first} second={second} />
      </SDKAdapter>
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  const [toast] = toastStore.getSnapshot();
  expect(toast.actions?.map((action) => action.label)).toEqual([
    'Undo',
    'View',
  ]);
  toast.actions?.[1].onClick();
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
});

test('two mounted Panes of one plugin obtain separate capabilities and count using their own token', async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}'),
  );
  vi.stubGlobal('fetch', fetch);
  function TelemetryProbe({ label }: { label: string }) {
    const sdk = useSDK();
    const telemetry = useTelemetry();
    return (
      <>
        <output data-testid={`token-${label}`}>
          {sdk.telemetryCapability?.() ?? 'pending'}
        </output>
        <button type="button" onClick={() => telemetry.count('closed')}>
          Count {label}
        </button>
      </>
    );
  }
  render(
    <>
      <SDKAdapter
        layout={paneLayout}
        boundProjectSlug="project-alpha"
        boundPluginName="plugin-alpha"
      >
        <TelemetryProbe label="first" />
      </SDKAdapter>
      <SDKAdapter
        layout={paneLayout}
        boundProjectSlug="project-alpha"
        boundPluginName="plugin-alpha"
      >
        <TelemetryProbe label="second" />
      </SDKAdapter>
    </>,
  );
  await waitFor(() => {
    expect(screen.getByTestId('token-first').textContent).not.toBe('pending');
    expect(screen.getByTestId('token-second').textContent).not.toBe('pending');
  });
  const first = screen.getByTestId('token-first').textContent;
  const second = screen.getByTestId('token-second').textContent;
  expect(first).not.toBe(second);
  expect(mocks.mountTelemetryPane).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Count first' }));
  fireEvent.click(screen.getByRole('button', { name: 'Count second' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(
    fetch.mock.calls.map((call) =>
      new Headers(call[1]?.headers).get('x-station-plugin-capability'),
    ),
  ).toEqual([first, second]);
});
