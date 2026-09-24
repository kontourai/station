/** @vitest-environment jsdom */

import type {
  BrowserSessionActivityView,
  BrowserSessionView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
// The live view is its own tested component; here it only has to be mounted
// on the right surface.
vi.mock('../../../live-surface/LiveSurfaceCanvas', () => ({
  LiveSurfaceCanvas: (props: { surfaceId: string; label: string }) => (
    <div data-testid="live-canvas" data-surface={props.surfaceId}>
      {props.label}
    </div>
  ),
}));

import { browserFloatSourceKey } from '../../../float-over-chat/floatSource';
import { isSourceShown } from '../../../float-over-chat/shownSources';
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

type Route = (init: RequestInit & { url: string }) => {
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
    const { status = 200, body: payload } = route({
      ...init,
      url: String(input),
    });
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
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
  render(
    wrap(
      <BrowserPane
        projectSlug="alpha"
        target={target}
        onAttach={onAttach}
        transport={station.transport as never}
      />,
    ),
  );
  return { ...station, onAttach };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BrowserPane honest states', () => {
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
    const key = browserFloatSourceKey(SESSION);
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
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
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
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('desktop');
    fireEvent.change(select, { target: { value: 'phone' } });
    await waitFor(() => expect(select.value).toBe('phone'));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Sessions' }));
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
      name: 'Download Chromium (152 MB)',
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

describe('BrowserPane local targets (D7, operator only)', () => {
  const suggestion = {
    host: 'localhost',
    port: 5173,
    label: 'vite',
    pid: 4242,
    processName: 'node',
    commandLine: 'node vite --token ********',
    cwd: '/work/alpha',
    selected: false,
    warnings: ['may-proxy'],
  };

  test('lists shared servers, offers unselected suggestions, and shares one only on its own click', async () => {
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': OPERATOR_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(sessionView()),
      'GET /api/browser/projects/alpha/local-targets': ok([
        {
          id: 'lt_00000000-0000-4000-8000-000000000001',
          host: '127.0.0.1',
          port: 3001,
          label: 'api',
          addedBy: 'operator',
          addedAt: '2026-09-22T12:00:00.000Z',
        },
      ]),
      'GET /api/browser/projects/alpha/local-target-suggestions': ok({
        state: 'ok',
        suggestions: [suggestion],
      }),
      'POST /api/browser/projects/alpha/local-targets': ok(
        { id: 'lt_x', ...suggestion, addedBy: 'operator', addedAt: 'x' },
        201,
      ),
      'DELETE /api/browser/projects/alpha/local-targets/lt_00000000-0000-4000-8000-000000000001':
        ok({}),
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Local servers' }),
    );
    expect(await screen.findByText('api — 127.0.0.1:3001')).toBeTruthy();
    expect(
      calls.some((c) => c.path.endsWith('/local-target-suggestions')),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Find local servers' }));
    const share = await screen.findByRole('button', {
      name: "Share vite :5173 with this Project's admins",
    });
    expect(screen.getByText(/pid 4242/)).toBeTruthy();
    expect(screen.getByText('Folder: /work/alpha')).toBeTruthy();
    expect(screen.getByText('node vite --token ********')).toBeTruthy();
    expect(screen.getByText(/may proxy other addresses/)).toBeTruthy();
    // Nothing is shared by finding it.
    expect(
      calls.some(
        (c) => c.method === 'POST' && c.path.endsWith('/local-targets'),
      ),
    ).toBe(false);
    fireEvent.click(share);
    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.method === 'POST' && c.path.endsWith('/local-targets'),
        )?.body,
      ).toEqual({ host: 'localhost', port: 5173, label: 'vite' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing api' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE')).toBe(true),
    );
  });

  test('a Project admin never sees the local servers control', async () => {
    renderPane({
      'GET /api/browser/projects/alpha/access': ADMIN_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
        sessionView({ principalKey: 'principal:admin', reach: 'project' }),
      ),
    });
    await screen.findByTestId('live-canvas');
    expect(screen.queryByRole('button', { name: 'Local servers' })).toBeNull();
  });
});

describe('BrowserPane agent access (D4)', () => {
  test('a Project admin sees the JavaScript permission off, with what it hands over, and turns it on', async () => {
    const { calls } = renderPane({
      'GET /api/browser/projects/alpha/access': ADMIN_ACCESS,
      [`GET /api/browser/sessions/${SESSION}?view=summary`]: ok(
        sessionView({ principalKey: 'principal:admin', reach: 'project' }),
      ),
      'GET /api/browser/projects/alpha/settings': ok({
        browserEvaluate: false,
      }),
      'PUT /api/browser/projects/alpha/settings': ok({
        browserEvaluate: true,
        updatedBy: 'principal:admin',
      }),
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Agent access' }),
    );
    const toggle = await screen.findByRole('switch', {
      name: "Let agents run JavaScript in this Project's pages",
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // #2425: the state is also said in words beside the switch (hidden from
    // assistive tech, which reads aria-checked), not by colour alone.
    const switchState = () =>
      toggle
        .closest('.station-toggle-field')
        ?.querySelector('.station-toggle__state');
    expect(switchState()?.textContent).toBe('Off');
    expect(switchState()?.getAttribute('aria-hidden')).toBe('true');
    // The disclosure is the switch's own description (S6).
    const description = document.getElementById(
      toggle.getAttribute('aria-describedby') ?? '',
    );
    expect(description?.textContent).toMatch(/cookies and local storage/);
    expect(description?.textContent).toMatch(/keep running/);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'PUT' && c.path.endsWith('/settings'))
          ?.body,
      ).toEqual({ browserEvaluate: true }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole('switch', {
            name: "Let agents run JavaScript in this Project's pages",
          })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(
      screen
        .getByRole('switch', {
          name: "Let agents run JavaScript in this Project's pages",
        })
        .closest('.station-toggle-field')
        ?.querySelector('.station-toggle__state')?.textContent,
    ).toBe('On');
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
    expect(screen.queryByText(/The page showed a dialog/)).toBeNull();
    lastDialog = {
      seq: 7,
      at: '2026-09-22T12:00:05.000Z',
      type: 'confirm',
      message: 'Delete everything?',
      accepted: false,
      count: 1,
    };
    // Any mutation refreshes the summary; Reload is the simplest.
    const reload = await screen.findByRole('button', { name: 'Reload' });
    await waitFor(() =>
      expect((reload as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(reload);
    expect(
      (await screen.findByText(/The page showed a dialog/)).textContent,
    ).toBe(
      "The page showed a dialog: “Delete everything?”. Station dismissed it. Pages that need you to confirm or answer a prompt can't be completed here yet.",
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
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    await screen.findByRole('heading', {
      name: 'Browser sessions in this Project',
    });
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
    fireEvent.click(await screen.findByRole('button', { name: 'Sessions' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith(OTHER));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      projectSlug: 'alpha',
      url: 'example.com',
    });
  });
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
    fireEvent.click(await screen.findByRole('button', { name: 'Sessions' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Sessions' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Sessions' }));
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
