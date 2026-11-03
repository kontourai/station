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
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

function stub(routes: Record<string, () => Response>) {
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
});
