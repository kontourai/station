/** @vitest-environment jsdom */

import type {
  BrowserSessionActivityView,
  BrowserSessionView,
} from '@kontourai/station-contracts/workspace-browser-pane';
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
import { type ReactNode, useEffect, useState } from 'react';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

const originalPlatform = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'platform');
  Object.defineProperty(navigator, 'platform', {
    value: 'Linux x86_64',
    configurable: true,
  });
  return descriptor;
});
afterAll(() => {
  if (originalPlatform)
    Object.defineProperty(navigator, 'platform', originalPlatform);
  else Reflect.deleteProperty(navigator, 'platform');
});

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'fixture',
    isCurrent: () => true,
  }),
}));
const preview = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(preview.enabled ? ['browser-experience'] : []),
}));
const canvasState = vi.hoisted(() => ({
  immersive: undefined as ((immersive: boolean) => void) | undefined,
  report: undefined as
    | ((
        state: import('../../../live-surface/LiveSurfaceCanvas').LiveSurfaceControlState,
      ) => void)
    | undefined,
}));
vi.mock('../useBrowserArtifactIntake', () => ({
  useBrowserArtifactIntake: () => () => async () => {},
}));
// The live view is its own tested component; here it only has to be mounted
// on the right surface.
vi.mock('../../../live-surface/LiveSurfaceCanvas', () => ({
  LiveSurfaceCanvas: (props: {
    surfaceId: string;
    label: string;
    readOnly?: boolean;
    onControlState?: (
      state: import('../../../live-surface/LiveSurfaceCanvas').LiveSurfaceControlState,
    ) => void;
    overlay?: import('react').ReactNode;
    onImmersiveChange?: (immersive: boolean) => void;
  }) => {
    useEffect(() => {
      canvasState.report = props.onControlState;
    }, [props.onControlState]);
    canvasState.immersive = props.onImmersiveChange;
    return (
      <div
        data-testid="live-canvas"
        data-surface={props.surfaceId}
        data-read-only={props.readOnly}
      >
        {props.label}
        {props.overlay}
        <div className="live-surface__stage" />
      </div>
    );
  },
}));

import { activeChatsStore } from '../../../contexts/active-chats-store';
import {
  evaluateShortcutWhen,
  KeyboardShortcutsProvider,
  useShortcutRegistry,
} from '../../../contexts/KeyboardShortcutsContext';
import { navigationStore } from '../../../contexts/navigation-store';
import {
  browserFloatSourceKey,
  browserShownSourceKey,
} from '../../../float-over-chat/floatSource';
import {
  dismissFloat,
  openFloat,
  registerFloatHost,
  takeFloatRequest,
} from '../../../float-over-chat/floatStore';
import { isSourceShown } from '../../../float-over-chat/shownSources';
import { registerConversationFileReceiver } from '../../../lib/conversation-file-intake';
import BrowserPane, { type BrowserPaneTarget } from '../BrowserPane';

const SESSION = 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77';
const OTHER = 'bs_11111111-2222-4333-8444-555555555555';

function sessionView(
  overrides: Partial<BrowserSessionView> = {},
): BrowserSessionView {
  return {
    browserSessionId: SESSION,
    projectId: 'p-alpha',
    projectSlug: 'alpha',
    principalKey: 'operator',
    reach: 'operator',
    url: 'https://example.com/',
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    generation: 1,
    state: 'live',
    createdAt: '2026-09-22T12:00:00.000Z',
    updatedAt: '2026-09-22T12:00:00.000Z',
    history: { entries: [], total: 0 },
    activity: { agentDriven: false },
    surfaceId: 'browser:0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77:g1',
    ...overrides,
  };
}

type Route = (init: RequestInit & { url: string }) =>
  | Response
  | Promise<Response>
  | {
      status?: number;
      body: unknown;
    };

/** A fake Station: routes are `METHOD path` → response. */
function fakeStation(routes: Record<string, Route>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const transport = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = `${url.pathname}${url.search}`;
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    if (!route)
      return new Response(JSON.stringify({ success: false, code: 'nope' }), {
        status: 599,
      });
    const answer = await route({
      ...init,
      url: String(input),
    });
    if (answer instanceof Response) return answer;
    const { status = 200, body: payload } = answer;
    return new Response(JSON.stringify(payload), { status });
  });
  return { transport, calls };
}

const ok =
  (data: unknown, status = 200) =>
  () => ({
    status,
    body: { success: true, data },
  });
const refuse =
  (status: number, code?: string, extra: object = {}) =>
  () => ({
    status,
    body: code ? { success: false, code, ...extra } : 'Not Found',
  });

const OPERATOR_ACCESS = ok({
  projectId: 'p-alpha',
  role: 'operator',
  operator: true,
  browser: 'ready',
  experiencePreviewEnabled: true,
});
const ADMIN_ACCESS = ok({
  projectId: 'p-alpha',
  role: 'project-admin',
  operator: false,
  browser: 'ready',
});

function renderPane(
  routes: Record<string, Route>,
  target: BrowserPaneTarget = { kind: 'session', browserSessionId: SESSION },
) {
  const station = fakeStation(routes);
  const onAttach = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (node: ReactNode) => (
    <KeyboardShortcutsProvider>
      <RegistryProbe />
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </KeyboardShortcutsProvider>
  );
  const view = render(
    wrap(
      <BrowserPane
        projectSlug="alpha"
        target={target}
        onAttach={onAttach}
        transport={station.transport as never}
      />,
    ),
  );
  return { ...station, onAttach, unmount: view.unmount };
}

afterEach(() => {
  cleanup();
  canvasState.report = undefined;
  preview.enabled = true;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Open the toolbar's ⋯ menu and choose one of its items. */
async function chooseFromMenu(
  name: string,
  role: 'menuitem' | 'menuitemradio' = 'menuitem',
) {
  fireEvent.click(
    await screen.findByRole('button', { name: /^More browser actions/ }),
  );
  const menu = await screen.findByRole('menu', {
    name: /^More browser actions/,
  });
  const item = within(menu).getByRole(role, { name }) as HTMLButtonElement;
  await waitFor(() => expect(item.disabled).toBe(false));
  fireEvent.click(item);
}

let registry: ReturnType<typeof useShortcutRegistry> | null = null;
function RegistryProbe() {
  registry = useShortcutRegistry();
  return null;
}

/**
 * Run a Browser command through the shortcut registry the command palette
 * lists: the registered handler, only while it is enabled and its `when`
 * holds. This does not drive the palette's own UI. Focus inside the pane
 * first, which is what makes Browser commands current.
 */
async function runRegisteredCommand(id: string) {
  act(() =>
    (
      screen.getByRole('button', {
        name: /^More browser actions/,
      }) as HTMLButtonElement
    ).focus(),
  );
  let handler: (() => void) | undefined;
  await waitFor(() => {
    const shortcut = registry
      ?.getAllShortcuts()
      .find((entry) => entry.id === id);
    expect(shortcut).toBeTruthy();
    expect(shortcut!.disabled).toBe(false);
    expect(!shortcut!.when || evaluateShortcutWhen(shortcut!.when)).toBe(true);
    handler = shortcut!.handler;
  });
  act(() => handler!());
}

describe('BrowserPane honest states', () => {
  test('the driver chip loads the latest twenty session actions', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      seq: i + 1,
      at: '2026-09-22T12:00:00.000Z',
      kind: 'clicked',
      actor: { kind: 'agent' as const, sessionId: 'agent-1' },
      detail: `target ${i + 1}`,
    }));
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      [`GET /api/browser/sessions/${SESSION}`]: ok(
        sessionView({ history: { entries, total: entries.length } }),
      ),
    });
    await screen.findByTestId('live-canvas');
    act(() =>
      canvasState.report?.({
        status: 'live',
        tone: 'you',
        claimControl: async () => {},
        releaseControl: async () => {},
        keepControlAlive: async () => {},
        immersive: false,
        enterImmersive: () => {},
        exitImmersive: () => {},
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Control options/ }));
    const actions = await screen.findByRole('region', {
      name: 'Recent actions',
    });
    await waitFor(() =>
      expect(within(actions).getAllByRole('listitem')).toHaveLength(20),
    );
    expect(within(actions).getByText(/target 25/)).toBeTruthy();
    expect(within(actions).queryByText(/target 1\)/)).toBeNull();
    entries.push({
      seq: 26,
      at: '2026-09-22T12:00:01.000Z',
      kind: 'clicked',
      actor: { kind: 'agent', sessionId: 'agent-1' },
      detail: 'target 26',
    });
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    vi.useRealTimers();
    await waitFor(() =>
      expect(within(actions).getByText(/target 26/)).toBeTruthy(),
    );
  });

  test('a person can float the session and return it to the pane', async () => {
    const release = registerFloatHost();
    try {
      renderPane({
        'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
        [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
          sessionView(),
        ),
      });
      await screen.findByTestId('live-canvas');
      await chooseFromMenu('Float over chat');
      const request = takeFloatRequest();
      expect(request?.source).toMatchObject({
        kind: 'browser',
        browserSessionId: SESSION,
      });
      act(() => {
        if (request)
          openFloat('test-chat', request.source, { requested: true });
        request?.onTaken?.();
      });
      await waitFor(() =>
        expect(
          isSourceShown(
            browserShownSourceKey(SESSION, 'http://station.test', 'fixture'),
          ),
        ).toBe(false),
      );
      act(() => dismissFloat('test-chat', browserFloatSourceKey(SESSION)));
      await waitFor(() =>
        expect(
          isSourceShown(
            browserShownSourceKey(SESSION, 'http://station.test', 'fixture'),
          ),
        ).toBe(true),
      );
    } finally {
      release();
    }
  });

  test('the registered Screenshot to chat command hands the image to the active Project chat', async () => {
    const received = vi.fn(async (files: File[]) => ({
      added: files.length,
      errors: [],
    }));
    activeChatsStore.initChat('browser-capture-chat', {
      projectSlug: 'alpha',
      agentSlug: 'test',
      agentName: 'Test',
      title: 'Browser capture',
    });
    navigationStore.setActiveChat('browser-capture-chat');
    const release = registerConversationFileReceiver({
      apiBase: 'http://station.test',
      sessionId: 'browser-capture-chat',
      receive: received,
    });
    try {
      renderPane({
        'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
        [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
          sessionView(),
        ),
        [`GET /api/browser/sessions/${SESSION}/screenshot`]: () =>
          new Response(new Blob(['png'], { type: 'image/png' }), {
            headers: { 'content-type': 'image/png' },
          }),
      });
      await screen.findByTestId('live-canvas');
      await runRegisteredCommand('browser.screenshotChat');
      await waitFor(() => expect(received).toHaveBeenCalledOnce());
      expect(received.mock.calls[0]![0][0]).toMatchObject({
        name: 'browser-screenshot.png',
        type: 'image/png',
      });
    } finally {
      release();
      activeChatsStore.removeChat('browser-capture-chat');
      navigationStore.setActiveChat(null);
    }
  });
  test.each([false, true])(
    'Mod+Shift+S opens a screenshot when the page keyboard has focus (preview %s)',
    async (enabled) => {
      preview.enabled = enabled;
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      const { calls } = renderPane({
        'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
        [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
          sessionView(),
        ),
        [`GET /api/browser/sessions/${SESSION}/screenshot`]: () =>
          new Response(new Blob(['png'], { type: 'image/png' }), {
            headers: { 'content-type': 'image/png' },
          }),
      });
      const canvas = await screen.findByTestId('live-canvas');
      const keyboard = document.createElement('textarea');
      keyboard.setAttribute('data-live-surface-keyboard', '');
      canvas.appendChild(keyboard);
      act(() => keyboard.focus());
      fireEvent.keyDown(keyboard, {
        key: 's',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      });
      fireEvent.keyDown(keyboard, {
        key: 's',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      });
      await waitFor(() =>
        expect(
          calls.filter((call) => call.path.endsWith('/screenshot')),
        ).toHaveLength(1),
      );
      expect(await screen.findByText(/Screenshot taken/)).toBeTruthy();
    },
  );

  test.each([false, true])(
    'unavailable Browser shortcuts consume host bindings (preview %s)',
    async (enabled) => {
      preview.enabled = enabled;
      const { calls } = renderPane({
        'GET /api/browser/projects/alpha/access': ok({
          projectId: 'p-alpha',
          role: 'operator',
          operator: false,
          canDrive: false,
          browser: 'ready',
          experiencePreviewEnabled: true,
        }),
        [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
          sessionView(),
        ),
      });
      await screen.findByTestId('live-canvas');
      const toolbar = screen.getByRole('form', { name: 'Browser toolbar' });
      fireEvent.focusIn(toolbar);
      for (const key of ['r', '=', '-', '0']) {
        const event = new KeyboardEvent('keydown', {
          key,
          ctrlKey: !navigator.platform.toUpperCase().includes('MAC'),
          metaKey: navigator.platform.toUpperCase().includes('MAC'),
          bubbles: true,
          cancelable: true,
        });
        toolbar.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(calls.some((call) => call.method === 'POST')).toBe(false);
    },
  );

  test('tab shortcuts consume their chords without acting when the preview is off', async () => {
    preview.enabled = false;
    const station = fakeStation({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      'GET /api/browser/sessions?projectSlug=alpha': ok([sessionView()]),
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
    });
    render(
      <KeyboardShortcutsProvider>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <BrowserPane
            projectSlug="alpha"
            browserSessionIds={[SESSION]}
            target={{ kind: 'session', browserSessionId: SESSION }}
            transport={station.transport as never}
            onAttach={() => {}}
            onTabsChange={() => {}}
          />
        </QueryClientProvider>
      </KeyboardShortcutsProvider>,
    );
    const tab = await screen.findByRole('tab');
    act(() => tab.focus());
    for (const [key, shiftKey] of [
      ['t', false],
      ['w', false],
      ['t', true],
    ] as const) {
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const event = new KeyboardEvent('keydown', {
        key,
        shiftKey,
        ctrlKey: !isMac,
        metaKey: isMac,
        bubbles: true,
        cancelable: true,
      });
      tab.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(station.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  test('zoom shortcut and appearance menu act on the selected session generation', async () => {
    const session = sessionView();
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(session),
      [`POST /api/browser/sessions/${SESSION}/zoom`]: ok({
        ...session,
        zoomFactor: 1.1,
      }),
      [`POST /api/browser/sessions/${SESSION}/appearance`]: ok({
        ...session,
        zoomFactor: 1.1,
        colorScheme: 'dark',
      }),
    });
    await screen.findByTestId('live-canvas');
    const reload = screen.getByRole('button', { name: 'Reload' });
    act(() => reload.focus());
    fireEvent.keyDown(reload, { key: '=', ctrlKey: true, bubbles: true });
    fireEvent.keyDown(reload, { key: '=', metaKey: true, bubbles: true });
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/zoom'))?.body).toEqual({
        factor: 1.1,
        generation: 1,
      }),
    );
    expect(await screen.findByLabelText('Page zoom 110%')).toBeTruthy();
    await chooseFromMenu('Appearance: system');
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.path.endsWith('/appearance'))?.body,
      ).toEqual({ scheme: 'dark', generation: 1 }),
    );
  });
  test('view-only access mounts a non-interactive live surface', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': ok({
        projectId: 'p-alpha',
        role: 'operator-device',
        operator: false,
        canDrive: false,
        browser: 'ready',
      }),
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
    });
    expect((await screen.findByTestId('live-canvas')).dataset.readOnly).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('View only')).toBeTruthy();
  });
  test('view-only access lists sessions without offering a new page', async () => {
    renderPane(
      {
        'GET /api/browser/projects/alpha/access': ok({
          projectId: 'p-alpha',
          role: 'operator',
          operator: false,
          canDrive: false,
          browser: 'ready',
        }),
        'GET /api/browser/sessions?projectSlug=alpha': ok([]),
      },
      { kind: 'new' },
    );
    expect(await screen.findByText('Choose a session to watch.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open address' })).toBeNull();
    expect(
      screen.queryByRole('heading', {
        name: 'Open a page',
      }),
    ).toBeNull();
  });
  test('address shortcut runs through the registry while Browser chrome has focus', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
    });
    await screen.findByTestId('live-canvas');
    const reload = screen.getByRole('button', { name: 'Reload' });
    act(() => reload.focus());
    fireEvent.keyDown(reload, { key: 'l', ctrlKey: true, bubbles: true });
    fireEvent.keyDown(reload, { key: 'l', metaKey: true, bubbles: true });
    expect(document.activeElement).toBe(screen.getByLabelText('Address'));
  });
  test('new-tab shortcut opens a Browser tab through the registry', async () => {
    const first = sessionView({
      title: 'First page',
      favicon: 'data:image/png;base64,aWNvbg==',
    });
    const station = fakeStation({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      'GET /api/browser/sessions?projectSlug=alpha': ok([first]),
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(first),
      'POST /api/browser/sessions': ok(
        sessionView({ browserSessionId: OTHER, url: 'about:blank' }),
        201,
      ),
    });
    const attach = vi.fn();
    render(
      <KeyboardShortcutsProvider>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <BrowserPane
            projectSlug="alpha"
            target={{ kind: 'session', browserSessionId: SESSION }}
            browserSessionIds={[SESSION]}
            onTabsChange={vi.fn()}
            onAttach={attach}
            transport={station.transport as never}
          />
        </QueryClientProvider>
      </KeyboardShortcutsProvider>,
    );
    const tab = await screen.findByRole('tab', { name: 'First page' });
    act(() => tab.focus());
    fireEvent.keyDown(tab, { key: 't', ctrlKey: true, bubbles: true });
    fireEvent.keyDown(tab, { key: 't', metaKey: true, bubbles: true });
    await waitFor(() => expect(attach).toHaveBeenCalledWith(OTHER));
    expect(station.calls.find((call) => call.method === 'POST')?.body).toEqual({
      projectSlug: 'alpha',
      url: 'about:blank',
    });
  });
  test('closing the last Browser tab and reopening replaces its closed reference', async () => {
    const first = sessionView({ title: 'First page' });
    const station = fakeStation({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      'GET /api/browser/sessions?projectSlug=alpha': ok([first]),
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(first),
      [`DELETE /api/browser/sessions/${SESSION}`]: ok({
        ...first,
        state: 'closed',
      }),
      'POST /api/browser/sessions': ok(
        sessionView({ browserSessionId: OTHER }),
        201,
      ),
    });
    const change = vi.fn();
    render(
      <KeyboardShortcutsProvider>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <BrowserPane
            projectSlug="alpha"
            target={{ kind: 'session', browserSessionId: SESSION }}
            browserSessionIds={[SESSION]}
            onTabsChange={change}
            onAttach={vi.fn()}
            transport={station.transport as never}
          />
        </QueryClientProvider>
      </KeyboardShortcutsProvider>,
    );
    const tab = await screen.findByRole('tab', { name: 'First page' });
    act(() => tab.focus());
    fireEvent.keyDown(tab, { key: 'w', ctrlKey: true, bubbles: true });
    fireEvent.keyDown(tab, { key: 'w', metaKey: true, bubbles: true });
    await screen.findByText('This session was closed');
    fireEvent.keyDown(tab, {
      key: 'T',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    });
    fireEvent.keyDown(tab, {
      key: 'T',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
    });
    await waitFor(() => expect(change).toHaveBeenCalledWith([OTHER], OTHER));
  });
  test('a Station without the browser routes (hosted) says the browser is unavailable here', async () => {
    renderPane({ 'GET /api/browser/projects/alpha/access': refuse(404) });
    expect(
      await screen.findByText("The browser isn't available on this Station"),
    ).toBeTruthy();
  });

  test('a caller who is not the operator or a Project admin is told so', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': refuse(403, 'access-denied'),
    });
    expect(
      await screen.findByText("The browser isn't available to you"),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect(screen.getByText(/grant you Project admin access/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  test.each([
    ['project-not-found', 'Project not found', /Open an existing Project/],
    ['stale-sign-in', 'Sign in again', /Reconnect this device/],
  ])('explains %s with a recovery action', async (code, title, guidance) => {
    renderPane({ 'GET /api/browser/projects/alpha/access': refuse(403, code) });
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByText(guidance)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  test('a live session mounts the live view on its surface', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
    });
    const canvas = await screen.findByTestId('live-canvas');
    expect(canvas.dataset.surface).toBe(
      'browser:0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77:g1',
    );
    expect(canvas.textContent).toBe('Browser: example.com');
  });

  test('while its live view is on screen the pane announces the session, so the float-over-chat hides (#90 D9)', async () => {
    const key = browserShownSourceKey(
      SESSION,
      'http://station.test',
      'fixture',
    );
    expect(isSourceShown(key)).toBe(false);
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
    });
    await screen.findByTestId('live-canvas');
    expect(isSourceShown(key)).toBe(true);
    cleanup();
    expect(isSourceShown(key)).toBe(false);
  });

  test('a session with no live view is not announced as shown', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': ADMIN_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
        sessionView({
          state: 'needs-reopen',
          endReason: 'host-exited',
          surfaceId: undefined,
        }),
      ),
    });
    await screen.findByText('The browser stopped');
    expect(isSourceShown(browserFloatSourceKey(SESSION))).toBe(false);
  });

  test('a crashed session says so and reopens on demand', async () => {
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': ADMIN_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
        sessionView({
          state: 'needs-reopen',
          endReason: 'host-exited',
          surfaceId: undefined,
        }),
      ),
      [`POST /api/browser/sessions/${SESSION}/reopen`]: ok(
        sessionView({
          generation: 2,
          surfaceId: 'browser:0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77:g2',
        }),
      ),
    });
    expect(await screen.findByText('The browser stopped')).toBeTruthy();
    expect(
      screen.getByText('The browser process exited, possibly after a crash.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('live-canvas')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    const canvas = await screen.findByTestId('live-canvas');
    expect(canvas.dataset.surface).toMatch(/:g2$/);
    expect(calls.some((c) => c.path.endsWith('/reopen'))).toBe(true);
  });

  test('a session that no longer exists offers a new one and attaches to it', async () => {
    const { onAttach, calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: refuse(
        404,
        'not-found',
      ),
      'POST /api/browser/sessions': ok(
        sessionView({ browserSessionId: OTHER }),
        201,
      ),
    });
    expect(
      await screen.findByText('This browser session no longer exists'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open a new session' }));
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith(OTHER));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      projectSlug: 'alpha',
      url: 'about:blank',
    });
  });
});

describe('BrowserPane address bar', () => {
  test('searches human text from the address field', async () => {
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      [`POST /api/browser/sessions/${SESSION}/navigate`]: ok({
        session: sessionView(),
      }),
    });
    const address = await screen.findByLabelText('Address');
    fireEvent.change(address, { target: { value: 'station browser parity' } });
    fireEvent.submit(address.closest('form')!);
    await waitFor(() =>
      expect(
        calls.find((call) => call.path.endsWith('/navigate'))?.body,
      ).toEqual({
        url: 'https://duckduckgo.com/?q=station%20browser%20parity',
        generation: 1,
      }),
    );
  });

  test('tab selection and reordering preserve targets; closing addresses exactly the chosen session', async () => {
    const first = sessionView({ title: 'First page' });
    const second = sessionView({
      browserSessionId: OTHER,
      title: 'Second page',
      favicon: 'https://untrusted.test/icon.png',
      surfaceId: 'other-surface',
      url: 'https://second.test/',
    });
    const station = fakeStation({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      'GET /api/browser/sessions?projectSlug=alpha': ok([first, second]),
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(first),
      [`GET /api/browser/sessions/${OTHER}?view=summary`]: ok(second),
      [`DELETE /api/browser/sessions/${OTHER}`]: ok({
        ...second,
        state: 'closed',
      }),
    });
    let currentIds: string[] = [];
    function Tabs() {
      const [ids, setIds] = useState([SESSION, OTHER]);
      const [selected, setSelected] = useState(SESSION);
      currentIds = ids;
      return (
        <BrowserPane
          projectSlug="alpha"
          browserSessionIds={ids}
          target={{ kind: 'session', browserSessionId: selected }}
          transport={station.transport as never}
          onAttach={setSelected}
          onTabsChange={(next, selected) => {
            setIds(next);
            setSelected(selected);
          }}
        />
      );
    }
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Tabs />
      </QueryClientProvider>,
    );
    const firstTab = await screen.findByRole('tab', { name: 'First page' });
    expect(firstTab.querySelector('img')?.getAttribute('src')).toBe(
      first.favicon,
    );
    const secondTab = await screen.findByRole('tab', { name: 'Second page' });
    expect(secondTab.querySelector('img')).toBeNull();
    fireEvent.click(secondTab);
    await waitFor(() =>
      expect(
        screen.getByTestId('live-canvas').getAttribute('data-surface'),
      ).toBe('other-surface'),
    );
    fireEvent.keyDown(secondTab, { key: 'ArrowLeft', altKey: true });
    await waitFor(() => expect(currentIds).toEqual([OTHER, SESSION]));
    expect(station.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Close Second page' }));
    await waitFor(() => expect(currentIds).toEqual([SESSION]));
    expect(station.calls.filter((call) => call.method !== 'GET')).toEqual([
      {
        method: 'DELETE',
        path: `/api/browser/sessions/${OTHER}`,
        body: undefined,
      },
    ]);
    await waitFor(() =>
      expect(
        screen.getByTestId('live-canvas').getAttribute('data-surface'),
      ).toBe(first.surfaceId),
    );
    expect(screen.getByRole('button', { name: 'Reopen tab' })).toBeTruthy();
  });
  test('Escape cancels an address draft without navigating the shared page', async () => {
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
    });
    const address = (await screen.findByLabelText(
      'Address',
    )) as HTMLInputElement;
    await waitFor(() => expect(address.value).toBe('https://example.com/'));
    address.focus();
    fireEvent.change(address, {
      target: { value: 'https://example.invalid/abandoned' },
    });
    fireEvent.keyDown(address, { key: 'Escape' });
    expect(address.value).toBe('https://example.com/');
    expect(document.activeElement).not.toBe(address);
    expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
  });

  test('submits the typed address to the server and shows its refusal honestly', async () => {
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      [`POST /api/browser/sessions/${SESSION}/navigate`]: refuse(
        400,
        'url-not-allowed',
        { detail: { urlRejection: 'unsupported-scheme' } },
      ),
    });
    const address = (await screen.findByLabelText(
      'Address',
    )) as HTMLInputElement;
    await waitFor(() => expect(address.value).toBe('https://example.com/'));
    fireEvent.change(address, { target: { value: 'file:///etc/passwd' } });
    // Enter in the address submits its form (there is no separate Go).
    fireEvent.submit(address.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Station can't open file: URLs. Only http and https pages open here.",
    );
    expect(calls.find((c) => c.path.endsWith('/navigate'))?.body).toEqual({
      url: 'file:///etc/passwd',
      generation: 1,
    });
  });

  test('a successful navigation updates the address; a load error is reported', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      [`POST /api/browser/sessions/${SESSION}/navigate`]: ok({
        session: sessionView({ url: 'http://localhost:9/' }),
        errorText: 'net::ERR_CONNECTION_REFUSED',
      }),
    });
    const address = (await screen.findByLabelText(
      'Address',
    )) as HTMLInputElement;
    await waitFor(() => expect(address.disabled).toBe(false));
    fireEvent.change(address, { target: { value: 'localhost:9' } });
    fireEvent.submit(address.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The page could not load (net::ERR_CONNECTION_REFUSED).',
    );
    expect(address.value).toBe('http://localhost:9/');
  });

  test('non-macOS Alt+Left in the address field navigates Browser history', async () => {
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      [`GET /api/browser/sessions/${SESSION}/navigation`]: ok({
        generation: 1,
        title: 'Example',
        canGoBack: true,
        canGoForward: true,
      }),
      [`POST /api/browser/sessions/${SESSION}/history`]: ok(sessionView()),
    });
    const address = await screen.findByLabelText('Address');
    await screen.findByTestId('live-canvas');
    act(() => address.focus());
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      address.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(
        calls.find(
          (call) => call.method === 'POST' && call.path.endsWith('/history'),
        )?.body,
      ).toEqual({ action: 'back', generation: 1 }),
    );
  });

  test('back, forward and reload go to the history route', async () => {
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      [`POST /api/browser/sessions/${SESSION}/history`]: ok(sessionView()),
    });
    for (const name of ['Back', 'Forward', 'Reload']) {
      const button = await screen.findByRole('button', { name });
      await waitFor(() =>
        expect((button as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(button);
      await waitFor(() =>
        expect(
          calls.filter((c) => c.path.endsWith('/history')).length,
        ).toBeGreaterThan(0),
      );
    }
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.path.endsWith('/history'))
          .map((c) => (c.body as { action: string }).action),
      ).toEqual(['back', 'forward', 'reload']),
    );
  });

  test('Match this pane fits again on entering and leaving full screen; a preset does not follow', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        // The pane's stage, and the live view's own stage in full screen.
        const [width, height] = this.classList.contains('live-surface__stage')
          ? [1000, 700]
          : this.classList.contains('browser-pane__stage')
            ? [800, 500]
            : [0, 0];
        return new DOMRect(0, 0, width, height);
      },
    );
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      [`POST /api/browser/sessions/${SESSION}/viewport`]: ok(sessionView()),
    });
    await screen.findByTestId('live-canvas');
    const viewports = () =>
      calls
        .filter((c) => c.path.endsWith('/viewport'))
        .map(
          (c) =>
            (c.body as { viewport: { width: number; height: number } })
              .viewport,
        );
    const choose = async (name: string | RegExp) => {
      fireEvent.click(
        await screen.findByRole('button', { name: 'More browser actions' }),
      );
      fireEvent.click(
        await screen.findByRole('menuitem', { name: /^Viewport: / }),
      );
      const menu = await screen.findByRole('menu', { name: 'Viewport' });
      fireEvent.click(within(menu).getByRole('menuitemradio', { name }));
    };
    await choose('Match this pane');
    await waitFor(() => expect(viewports()).toHaveLength(1));
    expect(viewports()[0]).toMatchObject({ width: 800, height: 500 });
    await act(async () => {
      canvasState.immersive?.(true);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await waitFor(() => expect(viewports()).toHaveLength(2));
    expect(viewports()[1]).toMatchObject({ width: 1000, height: 700 });
    await act(async () => {
      canvasState.immersive?.(false);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await waitFor(() => expect(viewports()).toHaveLength(3));
    expect(viewports()[2]).toMatchObject({ width: 800, height: 500 });
    // A preset is a fixed size: full screen leaves it alone.
    await choose('Phone 393 × 852');
    await waitFor(() => expect(viewports()).toHaveLength(4));
    await act(async () => {
      canvasState.immersive?.(true);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(viewports()).toHaveLength(4);
  });

  test('a device preset is applied through the viewport route', async () => {
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      [`POST /api/browser/sessions/${SESSION}/viewport`]: ok(
        sessionView({
          viewport: {
            width: 393,
            height: 852,
            deviceScaleFactor: 3,
            mobile: true,
          },
        }),
      ),
    });
    await screen.findByTestId('live-canvas');
    const openViewport = async () => {
      fireEvent.click(
        await screen.findByRole('button', { name: 'More browser actions' }),
      );
      fireEvent.click(
        await screen.findByRole('menuitem', { name: /^Viewport: / }),
      );
      return screen.findByRole('menu', { name: 'Viewport' });
    };
    // The row says the current value; its list checks it.
    expect(
      (await screen.findAllByRole('button', { name: 'More browser actions' }))
        .length,
    ).toBe(1);
    let menu = await openViewport();
    expect(
      within(menu)
        .getByRole('menuitemradio', { name: 'Desktop 1280 × 800' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(
      within(menu).getByRole('menuitemradio', { name: 'Phone 393 × 852' }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith('/viewport'))).toBe(true),
    );
    menu = await openViewport();
    await waitFor(() =>
      expect(
        within(menu)
          .getByRole('menuitemradio', { name: 'Phone 393 × 852' })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(calls.find((c) => c.path.endsWith('/viewport'))?.body).toEqual({
      viewport: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
      generation: 1,
    });
  });
});

describe('BrowserPane session list (D6)', () => {
  test('lists agent-driven sessions with who drove them and their actions, and opening one attaches', async () => {
    const agentSession = sessionView({
      browserSessionId: OTHER,
      url: 'https://docs.example/',
      surfaceId: undefined,
      history: {
        entries: [
          {
            seq: 1,
            at: '2026-09-22T12:00:00.000Z',
            kind: 'created',
            actor: { kind: 'agent', sessionId: 'agent-1' },
            url: 'https://docs.example/',
          },
          {
            seq: 2,
            at: '2026-09-22T12:00:01.000Z',
            kind: 'dialog-handled',
            actor: { kind: 'system' },
            detail: 'alert dismissed automatically: hi',
          },
        ],
        total: 9,
        omittedFromSummary: 7,
      },
      // Derived by the server over the WHOLE history (S5): an agent drove it
      // even though no agent entry is among the latest few.
      activity: {
        agentDriven: true,
        lastDriver: { kind: 'agent', sessionId: 'agent-1' },
      },
    });
    const { onAttach } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      'GET /api/browser/sessions?projectSlug=alpha': ok([
        sessionView(),
        agentSession,
      ]),
    });
    await chooseFromMenu('Sessions');
    const items = await screen.findAllByTestId('browser-session-item');
    expect(items).toHaveLength(2);
    const agent = items[1]!;
    expect(within(agent).getByText('Agent')).toBeTruthy();
    expect(within(agent).getByText('Last driven by an agent.')).toBeTruthy();
    expect(
      within(agent).getByText(/an agent opened https:\/\/docs\.example\//),
    ).toBeTruthy();
    expect(
      within(agent).getByText(
        /the page showed a dialog Station answered \(alert dismissed automatically: hi\)/,
      ),
    ).toBeTruthy();
    expect(
      within(agent).getByRole('button', { name: 'Show all 9 kept entries' }),
    ).toBeTruthy();
    expect(within(items[0]!).getByText('Showing in this pane.')).toBeTruthy();
    fireEvent.click(
      within(agent).getByRole('button', { name: 'Open https://docs.example/' }),
    );
    expect(onAttach).toHaveBeenCalledWith(OTHER);
  });
});

describe('BrowserPane Chromium acquisition (D3)', () => {
  const needsConsent = ok({
    state: 'needs-consent',
    version: '140.0.1',
    downloadBytes: 152_000_000,
  });

  test('the operator is offered the download with its size, and consent is explicit', async () => {
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': ok({
        projectId: 'p-alpha',
        role: 'operator',
        operator: true,
        browser: 'not-ready',
      }),
      'GET /api/browser/acquisition': needsConsent,
      'POST /api/browser/acquisition/download': ok(
        {
          state: 'downloading',
          version: '140.0.1',
          receivedBytes: 1_000_000,
          totalBytes: 152_000_000,
        },
        202,
      ),
    });
    const download = await screen.findByRole('button', {
      name: 'Download Chromium (145.0 MB)',
    });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.click(download);
    expect(
      await screen.findByText(/Downloading Chromium 140\.0\.1/),
    ).toBeTruthy();
    expect(
      calls.find((c) => c.path === '/api/browser/acquisition/download')?.body,
    ).toEqual({ consent: true });
  });

  test('a Project admin is told to ask the operator, and the operator-only status is never read', async () => {
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': ok({
        projectId: 'p-alpha',
        role: 'project-admin',
        operator: false,
        browser: 'not-ready',
      }),
    });
    expect(
      await screen.findByText(
        'Ask the Station operator to set up the browser.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Download Chromium/ }),
    ).toBeNull();
    expect(calls.some((c) => c.path === '/api/browser/acquisition')).toBe(
      false,
    );
  });
});

describe('Browser empty state', () => {
  test('says what to do and opens a shared local server, IPv6 included, in one click', async () => {
    const { calls, onAttach } = renderPane(
      {
        'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
        'GET /api/browser/sessions?projectSlug=alpha': ok([]),
        'GET /api/browser/projects/alpha/local-targets': ok([
          {
            id: 'lt_00000000-0000-4000-8000-000000000002',
            host: '::1',
            port: 5173,
            label: 'vite',
            addedBy: 'operator',
            addedAt: '2026-09-22T12:00:00.000Z',
          },
        ]),
        'POST /api/browser/sessions': ok(sessionView(), 201),
      },
      { kind: 'new' },
    );
    expect(
      await screen.findByRole('heading', {
        name: 'Open a page',
      }),
    ).toBeTruthy();
    // No empty session list beside it: one instruction, one place to act.
    expect(screen.queryByRole('heading', { name: 'Sessions' })).toBeNull();
    const servers = await screen.findByRole('list', { name: 'Local servers' });
    fireEvent.click(within(servers).getByRole('button', { name: /vite/ }));
    await waitFor(() =>
      expect(
        (
          calls.find(
            (c) => c.method === 'POST' && c.path === '/api/browser/sessions',
          )?.body as { url?: string } | undefined
        )?.url,
      ).toBe('http://[::1]:5173/'),
    );
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith(SESSION));
  });
});

describe('Browser commands in the shortcut registry', () => {
  test('console, sessions, rotate, stop loading, float and Browser settings each run as a registered command', async () => {
    const release = registerFloatHost();
    const navigate = vi
      .spyOn(navigationStore, 'navigate')
      .mockImplementation(() => {});
    try {
      const { calls } = renderPane({
        'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
        [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
          sessionView(),
        ),
        'GET /api/browser/sessions?projectSlug=alpha': ok([sessionView()]),
        [`GET /api/browser/sessions/${SESSION}/console`]: ok({
          entries: [],
          dropped: 0,
          latestSeq: 0,
          generation: 1,
          capturing: true,
        }),
        [`POST /api/browser/sessions/${SESSION}/viewport`]: ok(sessionView()),
        [`POST /api/browser/sessions/${SESSION}/history`]: ok(sessionView()),
      });
      await screen.findByTestId('live-canvas');
      await runRegisteredCommand('browser.console');
      expect(
        await screen.findByRole('region', { name: 'Console' }),
      ).toBeTruthy();
      await runRegisteredCommand('browser.sessions');
      expect(
        await screen.findByRole('heading', { name: 'Sessions' }),
      ).toBeTruthy();
      await runRegisteredCommand('browser.rotate');
      await waitFor(() =>
        expect(calls.some((c) => c.path.endsWith('/viewport'))).toBe(true),
      );
      await runRegisteredCommand('browser.stop');
      await waitFor(() =>
        expect(
          calls.some(
            (c) =>
              c.path.endsWith('/history') &&
              (c.body as { action: string }).action === 'stop',
          ),
        ).toBe(true),
      );
      await runRegisteredCommand('browser.float');
      expect(takeFloatRequest()?.source).toMatchObject({
        kind: 'browser',
        browserSessionId: SESSION,
      });
      await runRegisteredCommand('browser.settings');
      expect(navigate).toHaveBeenCalledWith(
        '/settings',
        expect.objectContaining({ view: 'advanced', project: 'alpha' }),
      );
    } finally {
      release();
    }
  });
});

describe('BrowserPane settings link (D4, D7)', () => {
  test('Browser settings… opens Settings › Advanced › Browser & devices on this Project', async () => {
    const navigate = vi
      .spyOn(navigationStore, 'navigate')
      .mockImplementation(() => {});
    renderPane({
      'GET /api/browser/projects/alpha/access': ADMIN_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
        sessionView({ principalKey: 'principal:admin', reach: 'project' }),
      ),
    });
    await screen.findByTestId('live-canvas');
    await chooseFromMenu('Browser settings…');
    expect(navigate).toHaveBeenCalledWith('/settings', {
      view: 'advanced',
      highlight: 'browser-project-settings',
      project: 'alpha',
    });
  });

  test('the ⋯ menu no longer carries the agent access or local servers panels', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
    });
    await screen.findByTestId('live-canvas');
    fireEvent.click(
      await screen.findByRole('button', { name: /^More browser actions/ }),
    );
    const menu = await screen.findByRole('menu', {
      name: /^More browser actions/,
    });
    expect(
      within(menu).queryByRole('menuitem', { name: 'Agent access' }),
    ).toBeNull();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Local servers' }),
    ).toBeNull();
    expect(
      within(menu).getByRole('menuitem', { name: 'Browser settings…' }),
    ).toBeTruthy();
  });
});

describe('BrowserPane v1 migration', () => {
  const migration = {
    projectId: 'p-alpha',
    requestedUrl: 'http://127.0.0.1:5173/',
    viewportPreference: 'mobile' as const,
  };

  test("asks the server to restore or open a session for the v1 URL in the caller's own profile, and attaches (S1)", async () => {
    const { onAttach, calls } = renderPane(
      {
        'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
        'POST /api/browser/sessions': ok(
          sessionView({ browserSessionId: OTHER }),
          201,
        ),
      },
      { kind: 'migrate', migration },
    );
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith(OTHER));
    // The server matches (profile + exact URL); the client never picks a
    // session out of a list whose URLs are redacted.
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      projectSlug: 'alpha',
      url: 'http://127.0.0.1:5173/',
      reuse: true,
      viewport: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
    });
    expect(calls.some((c) => c.path.startsWith('/api/browser/sessions?'))).toBe(
      false,
    );
  });
});

describe('BrowserPane wave 2 fix round', () => {
  test('a dialog the page shows after attaching is announced, with the disclosure (S6)', async () => {
    let lastDialog: BrowserSessionActivityView['lastDialog'];
    const observedSession = () => ({
      status: 200,
      body: {
        success: true,
        data: sessionView({
          activity: {
            agentDriven: false,
            ...(lastDialog ? { lastDialog } : {}),
          },
        }),
      },
    });
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: observedSession,
      [`POST /api/browser/sessions/${SESSION}/history`]: observedSession,
    });
    await screen.findByTestId('live-canvas');
    expect(screen.queryByText(/The page showed a dialog/)).toBeNull();
    lastDialog = {
      seq: 7,
      at: '2026-09-22T12:00:05.000Z',
      type: 'confirm',
      message: 'Delete everything?',
      accepted: false,
      count: 1,
    };
    // Reload returns the observed session, including the page's new dialog.
    const reload = await screen.findByRole('button', { name: 'Reload' });
    await waitFor(() =>
      expect((reload as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(reload);
    expect(
      (await screen.findByText(/The page showed a dialog/)).textContent,
    ).toBe(
      'The page showed a dialog: “Delete everything?”. Station dismissed it automatically because no person was in control. Take control before the page asks, and you can answer it yourself.',
    );
  });

  test('a dialog already in the history when the pane attaches is not announced as new', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
        sessionView({
          activity: {
            agentDriven: false,
            lastDialog: {
              seq: 3,
              at: '2026-09-22T12:00:00.000Z',
              type: 'alert',
              message: 'old',
              accepted: false,
              count: 1,
            },
          },
        }),
      ),
    });
    await screen.findByTestId('live-canvas');
    // Re-render (any state change) after the baseline is taken: an old
    // dialog must still not be announced.
    await chooseFromMenu('Sessions');
    await screen.findByRole('heading', { name: 'Sessions' });
    expect(screen.queryByText(/The page showed a dialog/)).toBeNull();
  });

  test('a navigation Station refused is credited to Station (D2)', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      [`POST /api/browser/sessions/${SESSION}/navigate`]: ok({
        session: sessionView({ url: 'http://127.0.0.1:3141/' }),
        errorText: 'net::ERR_BLOCKED_BY_CLIENT',
        blocked: 'station-listener',
      }),
    });
    const address = (await screen.findByLabelText(
      'Address',
    )) as HTMLInputElement;
    await waitFor(() => expect(address.disabled).toBe(false));
    fireEvent.change(address, { target: { value: '127.0.0.1:3141' } });
    fireEvent.submit(address.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Station blocked this address: it's one of Station's own services.",
    );
  });

  test('a live session with no surface says so for THIS session (S5)', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
        sessionView({ surfaceId: undefined }),
      ),
    });
    expect(
      await screen.findByText(
        "The live view isn't available for this session right now",
      ),
    ).toBeTruthy();
  });

  test('a browser that failed to start is not called "not set up" (S5)', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
        sessionView({ state: 'needs-reopen', surfaceId: undefined }),
      ),
      [`POST /api/browser/sessions/${SESSION}/reopen`]: refuse(
        503,
        'browser-host-failed',
      ),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The browser could not start, or stopped unexpectedly.',
    );
  });

  test('an unsupported platform is not reported as a failed download (S5)', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': ok({
        projectId: 'p-alpha',
        role: 'operator',
        operator: true,
        browser: 'not-ready',
      }),
      'GET /api/browser/acquisition': ok({
        state: 'failed',
        reason: 'unsupported-platform',
        detail: 'linux-arm64',
        retryable: false,
      }),
    });
    expect(
      await screen.findByText(
        "Station can't download Chromium for this computer",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/The last download failed/)).toBeNull();
  });

  test('the full history of a session is fetched only when asked for (S4, S5)', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      seq: index + 1,
      at: '2026-09-22T12:00:00.000Z',
      kind: 'navigated',
      actor: { kind: 'operator' as const },
      url: `https://example.com/${index}`,
    }));
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      'GET /api/browser/sessions?projectSlug=alpha': ok([
        sessionView({
          browserSessionId: OTHER,
          history: {
            entries: entries.slice(-5),
            total: 12,
            omittedFromSummary: 7,
          },
        }),
      ]),
      [`GET /api/browser/sessions/${OTHER}`]: ok(
        sessionView({
          browserSessionId: OTHER,
          history: { entries, total: 12 },
        }),
      ),
    });
    await chooseFromMenu('Sessions');
    const show = await screen.findByRole('button', {
      name: 'Show all 12 kept entries',
    });
    expect(calls.some((c) => c.path === `/api/browser/sessions/${OTHER}`)).toBe(
      false,
    );
    fireEvent.click(show);
    const full = await screen.findByRole('list', {
      name: 'Full history of https://example.com/',
    });
    expect(within(full).getAllByRole('listitem')).toHaveLength(12);
  });

  test('a failed full-history read keeps Retry focused while pending and recovers in Sessions', async () => {
    let failing = true;
    let finishRetry!: (response: Response) => void;
    const pendingRetry = new Promise<Response>((resolve) => {
      finishRetry = resolve;
    });
    let retryResponse: Response | Promise<Response> = pendingRetry;
    const entries = [1, 2].map((seq) => ({
      seq,
      at: '2026-09-22T12:00:00.000Z',
      kind: 'navigated',
      actor: { kind: 'operator' as const },
      url: `https://example.com/${seq}`,
    }));
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      'GET /api/browser/sessions?projectSlug=alpha': ok([
        sessionView({
          browserSessionId: OTHER,
          history: {
            entries: entries.slice(-1),
            total: 2,
            omittedFromSummary: 1,
          },
        }),
      ]),
      [`GET /api/browser/sessions/${OTHER}`]: () =>
        failing ? refuse(500, 'internal')() : retryResponse,
    });
    await chooseFromMenu('Sessions');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Show all 2 kept entries' }),
    );
    const error = await screen.findByRole('alert');
    expect(
      within(error).getByText('The full history could not be read'),
    ).toBeTruthy();
    const retry = within(error).getByRole('button', { name: 'Try again' });
    retry.focus();
    failing = false;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        calls.filter((call) => call.path === `/api/browser/sessions/${OTHER}`),
      ).toHaveLength(2),
    );
    try {
      expect(retry.isConnected).toBe(true);
      expect(document.activeElement).toBe(retry);
      expect(retry.getAttribute('aria-busy')).toBe('true');
      expect(retry).toHaveProperty('disabled', false);
      await act(async () => fireEvent.click(retry));
      expect(
        calls.filter((call) => call.path === `/api/browser/sessions/${OTHER}`),
      ).toHaveLength(2);
    } finally {
      await act(async () =>
        finishRetry(
          new Response(
            JSON.stringify({ success: false, code: 'access-denied' }),
            { status: 403 },
          ),
        ),
      );
    }
    expect(
      await screen.findByText(
        'You do not have access to this browser session.',
      ),
    ).toBeTruthy();
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute('aria-busy')).toBe('false');
    expect(retry.getAttribute('aria-disabled')).toBe('false');
    retryResponse = new Response(
      JSON.stringify({
        success: true,
        data: sessionView({
          browserSessionId: OTHER,
          history: { entries, total: 2 },
        }),
      }),
    );
    fireEvent.click(retry);
    const history = await screen.findByRole('list', {
      name: 'Full history of https://example.com/',
    });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('The full history could not be read')).toBeNull();
    expect(
      calls.filter((call) => call.path === `/api/browser/sessions/${OTHER}`),
    ).toHaveLength(3);
  });

  test('a failed session list keeps Retry focused while pending and recovers in place', async () => {
    let failing = true;
    let finishRetry!: (response: Response) => void;
    const pendingRetry = new Promise<Response>((resolve) => {
      finishRetry = resolve;
    });
    let retryResponse: Response | Promise<Response> = pendingRetry;
    const { calls } = renderPane(
      {
        'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
        'GET /api/browser/sessions?projectSlug=alpha': () =>
          failing ? refuse(500, 'internal')() : retryResponse,
      },
      { kind: 'new' },
    );
    const error = await screen.findByRole('alert');
    expect(
      within(error).getByText('Browser sessions could not be listed'),
    ).toBeTruthy();
    const retry = within(error).getByRole('button', { name: 'Try again' });
    retry.focus();
    failing = false;
    fireEvent.click(retry);
    const sessionReads = () =>
      calls.filter(
        (call) => call.path === '/api/browser/sessions?projectSlug=alpha',
      ).length;
    await waitFor(() => expect(sessionReads()).toBe(2));
    try {
      expect(retry.isConnected).toBe(true);
      expect(document.activeElement).toBe(retry);
      expect(retry.getAttribute('aria-busy')).toBe('true');
      expect(retry).toHaveProperty('disabled', false);
      await act(async () => fireEvent.click(retry));
      expect(sessionReads()).toBe(2);
    } finally {
      await act(async () =>
        finishRetry(
          new Response(
            JSON.stringify({ success: false, code: 'access-denied' }),
            { status: 403 },
          ),
        ),
      );
    }
    expect(
      await screen.findByText(
        'You do not have access to this browser session.',
      ),
    ).toBeTruthy();
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute('aria-busy')).toBe('false');
    expect(retry.getAttribute('aria-disabled')).toBe('false');
    retryResponse = new Response(
      JSON.stringify({ success: true, data: [sessionView()] }),
    );
    fireEvent.click(retry);
    expect(
      await screen.findByRole('button', { name: 'Open https://example.com/' }),
    ).toBeTruthy();
    expect(
      screen.queryByText('Browser sessions could not be listed'),
    ).toBeNull();
    expect(screen.getByLabelText('Address')).toBeTruthy();
    expect(sessionReads()).toBe(3);
  });

  test('a pane opened from the Add-pane grid asks for a page, then attaches (D3)', async () => {
    const { onAttach, calls } = renderPane(
      {
        'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
        'GET /api/browser/sessions?projectSlug=alpha': ok([]),
        'POST /api/browser/sessions': ok(
          sessionView({ browserSessionId: OTHER }),
          201,
        ),
      },
      { kind: 'new' },
    );
    const address = await screen.findByLabelText('Address');
    fireEvent.change(address, { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open address' }));
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith(OTHER));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      projectSlug: 'alpha',
      url: 'example.com',
    });
  });

  test.each([
    [
      'browser-sandbox-unavailable',
      'This Station’s Linux host blocks the browser sandbox. Its operator must allow it. How to fix',
      'https://github.com/kontourai/station/blob/main/docs/guides/browser-workspace.md#no-usable-sandbox-on-linux',
    ],
    [
      'browser-host-failed',
      'The browser could not start, or stopped unexpectedly.',
      undefined,
    ],
  ])(
    'a browser that cannot start on Open says why (%s)',
    async (code, text, href) => {
      renderPane(
        {
          'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
          'GET /api/browser/sessions?projectSlug=alpha': ok([]),
          'GET /api/browser/projects/alpha/local-targets': ok([]),
          'POST /api/browser/sessions': refuse(503, code),
        },
        { kind: 'new' },
      );
      const address = await screen.findByLabelText('Address');
      fireEvent.change(address, { target: { value: 'https://google.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Open address' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(text);
      expect(
        within(alert)
          .queryByRole('link', { name: 'How to fix' })
          ?.getAttribute('href'),
      ).toBe(href);
    },
  );
});

describe('BrowserPane delta-review nits', () => {
  test("Station's own lifecycle entries are Station's, and only page events are the page's (S-N1)", async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      'GET /api/browser/sessions?projectSlug=alpha': ok([
        sessionView({
          browserSessionId: OTHER,
          url: 'https://docs.example/',
          history: {
            entries: [
              {
                seq: 1,
                at: '2026-09-22T12:00:00.000Z',
                kind: 'host-exited',
                actor: { kind: 'system' },
                detail: 'crashed',
              },
              {
                seq: 2,
                at: '2026-09-22T12:00:01.000Z',
                kind: 'page-navigated',
                actor: { kind: 'system' },
                url: 'https://docs.example/next',
              },
              {
                seq: 3,
                at: '2026-09-22T12:00:02.000Z',
                kind: 'server-restarted',
                actor: { kind: 'system' },
              },
            ],
            total: 3,
          },
        }),
      ]),
    });
    await chooseFromMenu('Sessions');
    const list = await screen.findByRole('list', {
      name: 'Recent actions in https://docs.example/',
    });
    const text = list.textContent ?? '';
    expect(text).toContain(
      'Station stopped the session: the browser exited (crashed)',
    );
    expect(text).toContain(
      'the page navigated on its own to https://docs.example/next',
    );
    expect(text).toContain(
      'Station stopped the session when Station restarted',
    );
    expect(text).not.toContain('the page stopped');
  });

  test('folded repeats are said as folded, never as discarded (S-N2)', async () => {
    const entries = [
      {
        seq: 1,
        at: '2026-09-22T12:00:00.000Z',
        kind: 'created',
        actor: { kind: 'operator' as const },
        url: 'https://example.com/',
      },
      {
        seq: 2001,
        at: '2026-09-22T12:00:01.000Z',
        kind: 'dialog-handled',
        actor: { kind: 'system' as const },
        detail: 'alert dismissed automatically: 1',
        count: 2000,
      },
    ];
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      'GET /api/browser/sessions?projectSlug=alpha': ok([
        sessionView({
          browserSessionId: OTHER,
          history: {
            entries: entries.slice(-1),
            total: 2001,
            omittedFromSummary: 1,
          },
        }),
      ]),
      [`GET /api/browser/sessions/${OTHER}`]: ok(
        sessionView({
          browserSessionId: OTHER,
          history: { entries, total: 2001 },
        }),
      ),
    });
    await chooseFromMenu('Sessions');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Show all 2 kept entries' }),
    );
    expect(
      await screen.findByText(
        '1999 repeats are folded into the entries above.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/no longer kept/)).toBeNull();
  });

  test('the dialog notice can be dismissed, and comes back for a newer dialog', async () => {
    let lastDialog: BrowserSessionActivityView['lastDialog'];
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: () => ({
        status: 200,
        body: {
          success: true,
          data: sessionView({
            activity: {
              agentDriven: false,
              ...(lastDialog ? { lastDialog } : {}),
            },
          }),
        },
      }),
      [`POST /api/browser/sessions/${SESSION}/history`]: ok(sessionView()),
    });
    await screen.findByTestId('live-canvas');
    const reload = await screen.findByRole('button', { name: 'Reload' });
    await waitFor(() =>
      expect((reload as HTMLButtonElement).disabled).toBe(false),
    );
    const dialog = (seq: number) => ({
      seq,
      at: '2026-09-22T12:00:05.000Z',
      type: 'alert',
      message: `hi ${seq}`,
      accepted: false,
      count: 1,
    });
    lastDialog = dialog(7);
    fireEvent.click(reload);
    await screen.findByText(/The page showed a dialog: “hi 7”/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/The page showed a dialog/)).toBeNull();
    lastDialog = dialog(8);
    fireEvent.click(reload);
    expect(
      await screen.findByText(/The page showed a dialog: “hi 8”/),
    ).toBeTruthy();
  });
});

describe('BrowserPane live-verify fixes', () => {
  test('notices are laid over the live view, inside its stage, not above it (D4-style)', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      [`POST /api/browser/sessions/${SESSION}/navigate`]: ok({
        session: sessionView(),
        errorText: 'net::ERR_NAME_NOT_RESOLVED',
      }),
    });
    const canvas = await screen.findByTestId('live-canvas');
    const address = (await screen.findByLabelText(
      'Address',
    )) as HTMLInputElement;
    await waitFor(() => expect(address.disabled).toBe(false));
    fireEvent.change(address, { target: { value: 'nope.invalid' } });
    fireEvent.submit(address.closest('form')!);
    const alert = await screen.findByRole('alert');
    // Same stage as the canvas: the notice overlays it instead of pushing
    // it down (the pixel check is the live verify's; jsdom has no layout).
    const stage = canvas.closest('.browser-pane__stage');
    expect(stage).not.toBeNull();
    expect(stage?.contains(alert)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test("the history names a navigation after someone's click, and a Station block", async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      'GET /api/browser/sessions?projectSlug=alpha': ok([
        sessionView({
          browserSessionId: OTHER,
          url: 'https://docs.example/',
          history: {
            entries: [
              {
                seq: 1,
                at: '2026-09-22T12:00:00.000Z',
                kind: 'link-followed',
                actor: { kind: 'system' },
                cause: { kind: 'operator' },
                url: 'https://docs.example/next',
              },
              {
                seq: 2,
                at: '2026-09-22T12:00:01.000Z',
                kind: 'navigation-blocked',
                actor: { kind: 'operator' },
                url: 'http://127.0.0.1:3141/',
                detail:
                  "blocked by Station: it is one of Station's own services",
              },
            ],
            total: 2,
          },
        }),
      ]),
    });
    await chooseFromMenu('Sessions');
    const list = await screen.findByRole('list', {
      name: 'Recent actions in https://docs.example/',
    });
    expect(list.textContent).toContain(
      "the page navigated after the Station operator's click to https://docs.example/next",
    );
    expect(list.textContent).toContain(
      "the Station operator tried to open http://127.0.0.1:3141/ (blocked by Station: it is one of Station's own services)",
    );
  });
});

/** A pane that attaches to what it opens, as the workspace host does. */
function AttachingPane({
  initial,
  transport,
}: {
  initial: BrowserPaneTarget;
  transport: never;
}) {
  const [target, setTarget] = useState<BrowserPaneTarget>(initial);
  return (
    <BrowserPane
      projectSlug="alpha"
      target={target}
      onAttach={(id) => setTarget({ kind: 'session', browserSessionId: id })}
      transport={transport}
    />
  );
}

describe('BrowserPane on a phone-width pane (Duo audit)', () => {
  /** Give every Browser stage this measured size (jsdom lays nothing out). */
  function stageSize(width: number, height: number) {
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('browser-pane__stage')
          ? DOMRect.fromRect({ x: 0, y: 0, width, height })
          : real.call(this);
      },
    );
  }

  function renderAttachingPane(
    routes: Record<string, Route>,
    initial: BrowserPaneTarget,
  ) {
    const station = fakeStation(routes);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <KeyboardShortcutsProvider>
        <QueryClientProvider client={client}>
          <AttachingPane
            initial={initial}
            transport={station.transport as never}
          />
        </QueryClientProvider>
      </KeyboardShortcutsProvider>,
    );
    return station;
  }

  const newSessionRoutes = (viewportRoute: Route) => ({
    'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
    'GET /api/browser/sessions?projectSlug=alpha': ok([]),
    'GET /api/browser/projects/alpha/local-targets': ok([]),
    'POST /api/browser/sessions': ok(sessionView(), 201),
    [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
    [`POST /api/browser/sessions/${SESSION}/viewport`]: viewportRoute,
  });

  async function openFromAddress() {
    const address = await screen.findByLabelText('Address');
    fireEvent.change(address, { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open address' }));
    await screen.findByTestId('live-canvas');
  }

  test('a page opened from a narrow pane is sized to that pane, once', async () => {
    stageSize(342, 364);
    const { calls } = renderAttachingPane(
      newSessionRoutes(
        ok(
          sessionView({
            viewport: { width: 342, height: 364, deviceScaleFactor: 1 },
          }),
        ),
      ),
      { kind: 'new' },
    );
    await openFromAddress();
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path.endsWith('/viewport')).map((c) => c.body),
      ).toEqual([
        {
          viewport: { width: 342, height: 364, deviceScaleFactor: 1 },
          generation: 1,
        },
      ]),
    );
    // This pane's own change is not announced back to it.
    expect(screen.queryByText(/page size changed/)).toBeNull();
  });

  test('a page opened from a wide pane keeps its desktop viewport', async () => {
    stageSize(900, 700);
    const { calls } = renderAttachingPane(newSessionRoutes(ok(sessionView())), {
      kind: 'new',
    });
    await openFromAddress();
    // Let the live session settle; then nothing resized it.
    await screen.findByRole('button', { name: /^More browser actions/ });
    expect(calls.some((c) => c.path.endsWith('/viewport'))).toBe(false);
  });

  test('attaching a narrow pane to an existing session never resizes the shared page', async () => {
    stageSize(342, 364);
    const { calls } = renderAttachingPane(newSessionRoutes(ok(sessionView())), {
      kind: 'session',
      browserSessionId: SESSION,
    });
    await screen.findByTestId('live-canvas');
    await screen.findByRole('button', { name: /^More browser actions/ });
    expect(calls.some((c) => c.path.endsWith('/viewport'))).toBe(false);
  });

  test('a viewport change made elsewhere is announced as changing the page for everyone', async () => {
    let reads = 0;
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: () => {
        reads += 1;
        return {
          body: {
            success: true,
            data: sessionView(
              reads > 1
                ? {
                    viewport: { width: 342, height: 364, deviceScaleFactor: 1 },
                  }
                : {},
            ),
          },
        };
      },
    });
    await screen.findByTestId('live-canvas');
    expect(screen.queryByText(/page size changed/)).toBeNull();
    expect(
      (
        await screen.findByText(
          'The page size changed to 342 × 364 for everyone watching.',
          undefined,
          { timeout: 6_000 },
        )
      ).getAttribute('role'),
    ).toBe('alert');
  }, 10_000);

  test('the viewport choices say they change the page for everyone watching', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
    });
    await screen.findByTestId('live-canvas');
    fireEvent.click(
      await screen.findByRole('button', { name: 'More browser actions' }),
    );
    const menu = await screen.findByRole('menu', {
      name: 'More browser actions',
    });
    expect(within(menu).getByText('View for everyone watching')).toBeTruthy();
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: /^Viewport: / }),
    );
    const list = await screen.findByRole('menu', { name: 'Viewport' });
    expect(
      within(list).getByRole('menuitemradio', { name: 'Match this pane' }),
    ).toBeTruthy();
    expect(within(list).queryByText('Fit to this pane')).toBeNull();
  });

  test('on a coarse pointer the ⋯ menu shows no keyboard shortcut hints', async () => {
    const coarse = (matches: boolean) =>
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: (query: string) => ({
          matches: matches && query === '(pointer: coarse)',
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      });
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    try {
      for (const touch of [false, true]) {
        coarse(touch);
        renderPane({
          'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
          [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
            sessionView(),
          ),
        });
        await screen.findByTestId('live-canvas');
        fireEvent.click(
          await screen.findByRole('button', { name: 'More browser actions' }),
        );
        const menu = await screen.findByRole('menu', {
          name: 'More browser actions',
        });
        const shot = within(menu).getByRole('menuitem', {
          name: /^Screenshot/,
        });
        // Fine pointer: the chord is shown and announced; touch: neither.
        expect(within(menu).queryByText('Ctrl+Shift+S') !== null).toBe(!touch);
        expect(within(menu).queryByText('Ctrl+Shift+R') !== null).toBe(!touch);
        expect(shot.getAttribute('aria-keyshortcuts')).toBe(
          touch ? null : 'Control+Shift+S',
        );
        cleanup();
      }
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  test('submitting an address puts the keyboard away, in a new pane and on a live page', async () => {
    renderAttachingPane(newSessionRoutes(ok(sessionView())), {
      kind: 'new',
    });
    const start = (await screen.findByLabelText('Address')) as HTMLInputElement;
    act(() => start.focus());
    expect(document.activeElement).toBe(start);
    fireEvent.change(start, { target: { value: 'example.com' } });
    fireEvent.submit(start.closest('form')!);
    expect(document.activeElement).not.toBe(start);
    await screen.findByTestId('live-canvas');
    cleanup();

    renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      [`POST /api/browser/sessions/${SESSION}/navigate`]: ok({
        session: sessionView({ url: 'https://example.org/' }),
      }),
    });
    const address = (await screen.findByLabelText(
      'Address',
    )) as HTMLInputElement;
    await waitFor(() => expect(address.disabled).toBe(false));
    act(() => address.focus());
    expect(document.activeElement).toBe(address);
    fireEvent.change(address, { target: { value: 'example.org' } });
    fireEvent.submit(address.closest('form')!);
    expect(document.activeElement).not.toBe(address);
  });

  test('a new pane is titled, and says when no local servers are shared', async () => {
    renderPane(
      {
        'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
        'GET /api/browser/sessions?projectSlug=alpha': ok([]),
        'GET /api/browser/projects/alpha/local-targets': ok([]),
      },
      { kind: 'new' },
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Browser' }),
    ).toBeTruthy();
    expect(
      await screen.findByText('Local servers appear here once shared'),
    ).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Local servers' })).toBeNull();
  });

  test('a failed local-server read says so and retries the read', async () => {
    let reads = 0;
    renderPane(
      {
        'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
        'GET /api/browser/sessions?projectSlug=alpha': ok([]),
        'GET /api/browser/projects/alpha/local-targets': () => {
          reads += 1;
          return reads === 1
            ? { status: 500, body: { success: false, code: 'boom' } }
            : { body: { success: true, data: [] } };
        },
      },
      { kind: 'new' },
    );
    expect(
      await screen.findByText('Local servers could not be read'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('Local servers appear here once shared'),
    ).toBeTruthy();
    expect(reads).toBe(2);
  });
});

test('two panes share one browser viewer and transfer it on unmount', async () => {
  const routes = {
    'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
    [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
  };
  const first = renderPane(routes);
  await screen.findByTestId('live-canvas');
  renderPane(routes);
  await screen.findByText('This Browser is shown in another view');
  expect(screen.getAllByTestId('live-canvas')).toHaveLength(1);
  first.unmount();
  await waitFor(() =>
    expect(screen.getAllByTestId('live-canvas')).toHaveLength(1),
  );
  expect(
    screen.queryByText('This Browser is shown in another view'),
  ).toBeNull();
});
