// @vitest-environment jsdom

/**
 * Settings › Advanced › Browser & devices: the configuration the Browser and
 * Device panes moved out of their chrome. Agent JavaScript (D4) and shared
 * local servers (D7) keep their server authority; device setup (hub,
 * sharing, agent device access) opens from here once setup is done.
 * Mounted over a real QueryClient with only `fetch` stubbed.
 */

import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../contexts/ProjectsContext', () => ({
  useScopedProjectsQuery: () => ({
    data: [
      { slug: 'alpha', name: 'Alpha' },
      { slug: 'beta', name: 'Beta' },
    ],
  }),
}));

import { BrowserDevicesSection } from '../BrowserDevicesSection';

const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const OPERATOR_ACCESS = {
  projectId: 'p-alpha',
  role: 'operator',
  operator: true,
  browser: 'ready',
};
const ADMIN_ACCESS = {
  projectId: 'p-alpha',
  role: 'project-admin',
  operator: false,
  browser: 'ready',
};

type Call = { method: string; path: string; body: unknown };

function stub(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      const route = routes[`${method} ${url.pathname}`];
      return route
        ? route()
        : new Response(JSON.stringify({ success: false }), { status: 404 });
    }),
  );
  return calls;
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BrowserDevicesSection />
    </QueryClientProvider>,
  );
}

beforeEach(() =>
  setClientCredentialResolver(() => ({
    origin: 'http://station.test',
    requestAuthority: {
      apiBase: 'http://station.test',
      authorityKey: 'authority-1',
      isCurrent: () => true,
    },
  })),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver();
  window.history.replaceState(null, '', '/');
});

describe('Browser agent JavaScript (D4)', () => {
  test('a Project admin sees the JavaScript permission off, with what it hands over, and turns it on', async () => {
    const calls = stub({
      'GET /api/browser/projects/alpha/access': () => ok(ADMIN_ACCESS),
      'GET /api/browser/projects/alpha/settings': () =>
        ok({ browserEvaluate: false }),
      'PUT /api/browser/projects/alpha/settings': () =>
        ok({ browserEvaluate: true, updatedBy: 'principal:admin' }),
    });
    mount();
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
    expect(description?.textContent).toMatch(/cookies and\s+local storage/);
    expect(description?.textContent).toMatch(/keep running/);
    expect(description?.textContent).toMatch(
      /acts as you on the signed-in site/,
    );
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
  });

  test("opens on the Project the Browser's settings link names, and switches Project", async () => {
    window.history.replaceState(null, '', '/settings?project=beta');
    const calls = stub({
      'GET /api/browser/projects/beta/access': () => ok(ADMIN_ACCESS),
      'GET /api/browser/projects/beta/settings': () =>
        ok({ browserEvaluate: true }),
      'GET /api/browser/projects/alpha/access': () => ok(ADMIN_ACCESS),
      'GET /api/browser/projects/alpha/settings': () =>
        ok({ browserEvaluate: false }),
    });
    mount();
    const project = (await screen.findByLabelText(
      'Project',
    )) as HTMLSelectElement;
    expect(project.value).toBe('beta');
    await waitFor(() =>
      expect(
        screen
          .getByRole('switch', {
            name: "Let agents run JavaScript in this Project's pages",
          })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
    fireEvent.change(project, { target: { value: 'alpha' } });
    await waitFor(() =>
      expect(
        screen
          .getByRole('switch', {
            name: "Let agents run JavaScript in this Project's pages",
          })
          .getAttribute('aria-checked'),
      ).toBe('false'),
    );
    expect(
      calls.some((c) => c.path === '/api/browser/projects/alpha/settings'),
    ).toBe(true);
  });
});

describe('Browser settings for a view-only caller', () => {
  test('a caller who cannot drive this Project gets no agent JavaScript switch', async () => {
    const calls = stub({
      'GET /api/browser/projects/alpha/access': () =>
        ok({
          projectId: 'p-alpha',
          role: 'operator-device',
          operator: false,
          canDrive: false,
          browser: 'ready',
        }),
    });
    mount();
    expect(
      await screen.findByText(
        "You can't change Browser settings for this Project.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('switch', {
        name: "Let agents run JavaScript in this Project's pages",
      }),
    ).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/settings'))).toBe(false);
  });
});

describe('Browser access read outcomes', () => {
  const refused = (status: number, code: string) => () =>
    new Response(
      JSON.stringify({ success: false, error: { code, message: code } }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );

  test('a refused access read says the caller cannot change it', async () => {
    stub({
      'GET /api/browser/projects/alpha/access': refused(403, 'forbidden'),
    });
    mount();
    expect(
      await screen.findByText(
        "You can't change Browser settings for this Project.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  test('a failed access read offers Try again, which brings the switch back', async () => {
    let failing = true;
    stub({
      'GET /api/browser/projects/alpha/access': () =>
        failing ? refused(500, 'internal')() : ok(ADMIN_ACCESS),
      'GET /api/browser/projects/alpha/settings': () =>
        ok({ browserEvaluate: false }),
    });
    mount();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(
      screen.queryByText("You can't change Browser settings for this Project."),
    ).toBeNull();
    failing = false;
    fireEvent.click(retry);
    expect(
      await screen.findByRole('switch', {
        name: "Let agents run JavaScript in this Project's pages",
      }),
    ).toBeTruthy();
  });
});

describe('Browser shared local servers (D7, operator only)', () => {
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
    const calls = stub({
      'GET /api/browser/projects/alpha/access': () => ok(OPERATOR_ACCESS),
      'GET /api/browser/projects/alpha/settings': () =>
        ok({ browserEvaluate: false }),
      'GET /api/browser/projects/alpha/local-targets': () =>
        ok([
          {
            id: 'lt_00000000-0000-4000-8000-000000000001',
            host: '127.0.0.1',
            port: 3001,
            label: 'api',
            addedBy: 'operator',
            addedAt: '2026-09-22T12:00:00.000Z',
          },
        ]),
      'GET /api/browser/projects/alpha/local-target-suggestions': () =>
        ok({ state: 'ok', suggestions: [suggestion] }),
      'POST /api/browser/projects/alpha/local-targets': () =>
        ok(
          { id: 'lt_x', ...suggestion, addedBy: 'operator', addedAt: 'x' },
          201,
        ),
      'DELETE /api/browser/projects/alpha/local-targets/lt_00000000-0000-4000-8000-000000000001':
        () => ok({}),
    });
    mount();
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

  test.each(['shared servers', 'server discovery'] as const)(
    'a failed %s read keeps Retry focused while pending and recovers in Settings',
    async (read) => {
      let failing = true;
      let finishRetry!: (response: Response) => void;
      const pendingRetry = new Promise<Response>((resolve) => {
        finishRetry = resolve;
      });
      let retryResponse: Response | Promise<Response> = pendingRetry;
      const sharedTargets = [
        {
          id: 'lt_00000000-0000-4000-8000-000000000001',
          host: '127.0.0.1',
          port: 3001,
          label: 'api',
          addedBy: 'operator',
          addedAt: '2026-09-22T12:00:00.000Z',
        },
      ];
      const failure = () =>
        new Response(JSON.stringify({ success: false, code: 'internal' }), {
          status: 500,
        });
      const calls = stub({
        'GET /api/browser/projects/alpha/access': () => ok(OPERATOR_ACCESS),
        'GET /api/browser/projects/alpha/settings': () =>
          ok({ browserEvaluate: false }),
        'GET /api/browser/projects/alpha/local-targets': () =>
          read === 'shared servers'
            ? failing
              ? failure()
              : retryResponse
            : ok(sharedTargets),
        'GET /api/browser/projects/alpha/local-target-suggestions': () =>
          read === 'server discovery'
            ? failing
              ? failure()
              : retryResponse
            : ok({ state: 'ok', suggestions: [suggestion] }),
      });
      mount();
      const find = await screen.findByRole('button', {
        name: 'Find local servers',
      });
      expect(
        calls.some((call) => call.path.endsWith('/local-target-suggestions')),
      ).toBe(false);
      if (read === 'server discovery') fireEvent.click(find);
      const error = await screen.findByRole('alert');
      expect(
        within(error).getByText(
          read === 'shared servers'
            ? 'Shared local servers could not be read'
            : 'Local servers could not be listed',
        ),
      ).toBeTruthy();
      const retry = within(error).getByRole('button', { name: 'Try again' });
      retry.focus();
      failing = false;
      fireEvent.click(retry);
      const retryPath = `/api/browser/projects/alpha/${
        read === 'shared servers' ? 'local-targets' : 'local-target-suggestions'
      }`;
      const retryReads = () =>
        calls.filter((call) => call.path === retryPath).length;
      await waitFor(() => expect(retryReads()).toBe(2));
      try {
        expect(retry.isConnected).toBe(true);
        expect(document.activeElement).toBe(retry);
        expect(retry.getAttribute('aria-busy')).toBe('true');
        expect(retry).toHaveProperty('disabled', false);
        await act(async () => fireEvent.click(retry));
        expect(retryReads()).toBe(2);
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
        await within(error).findByText(
          'You do not have access to this browser session.',
        ),
      ).toBeTruthy();
      expect(retry.isConnected).toBe(true);
      expect(document.activeElement).toBe(retry);
      expect(retry.getAttribute('aria-busy')).toBe('false');
      expect(retry.getAttribute('aria-disabled')).toBe('false');
      retryResponse = ok(
        read === 'shared servers'
          ? sharedTargets
          : { state: 'ok', suggestions: [suggestion] },
      );
      fireEvent.click(retry);
      expect(
        await screen.findByRole('button', {
          name:
            read === 'shared servers'
              ? 'Stop sharing api'
              : "Share vite :5173 with this Project's admins",
        }),
      ).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByLabelText('Project')).toBeTruthy();
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
      expect(retryReads()).toBe(3);
      if (read === 'shared servers') {
        expect(
          calls.some((call) => call.path.endsWith('/local-target-suggestions')),
        ).toBe(false);
      }
    },
  );

  test('a Project admin never sees the local servers control', async () => {
    const calls = stub({
      'GET /api/browser/projects/alpha/access': () => ok(ADMIN_ACCESS),
      'GET /api/browser/projects/alpha/settings': () =>
        ok({ browserEvaluate: false }),
    });
    mount();
    await screen.findByRole('switch', {
      name: "Let agents run JavaScript in this Project's pages",
    });
    await waitFor(() =>
      expect(
        calls.some((c) => c.path === '/api/browser/projects/alpha/access'),
      ).toBe(true),
    );
    expect(
      screen.queryByRole('heading', { name: 'Shared local servers' }),
    ).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/local-targets'))).toBe(false);
  });
});

describe('Device setup', () => {
  test('opens the device setup wizard (hub, sharing, agent device access) after setup is done', async () => {
    stub({
      'GET /api/browser/projects/alpha/access': () => ok(ADMIN_ACCESS),
      'GET /api/browser/projects/alpha/settings': () =>
        ok({ browserEvaluate: false }),
    });
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open device setup' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Set up devices' }),
    ).toBeTruthy();
  });

  test('a caller who is not the operator is refused inside device setup, with nothing to change', async () => {
    stub({
      'GET /api/browser/projects/alpha/access': () => ok(ADMIN_ACCESS),
      'GET /api/browser/projects/alpha/settings': () =>
        ok({ browserEvaluate: false }),
      'GET /api/mobile-devices/toolchain': () =>
        new Response(
          JSON.stringify({ success: false, error: { code: 'forbidden' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open device setup' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Set up devices',
    });
    expect(
      await within(dialog).findByText(
        'Ask the Station operator to set up devices.',
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('switch')).toBeNull();
  });
});
