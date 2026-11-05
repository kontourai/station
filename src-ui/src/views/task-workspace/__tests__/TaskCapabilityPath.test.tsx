/** @vitest-environment jsdom */
import type {
  OwnAccessView,
  ToolLibrarySource,
  ToolLibraryView,
} from '@kontourai/station-contracts/tool-library';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TaskCapabilityPath } from '../TaskCapabilityPath';

const state = vi.hoisted(() => ({
  enabled: true,
  scope: {
    apiBase: 'http://station.test',
    authorityKey: 'person-a',
    isCurrent: (): boolean => true,
  },
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(state.enabled ? ['task-capabilities'] : []),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => state.scope,
}));
let client: QueryClient;
let access: OwnAccessView;
let view: ToolLibraryView;
let catalogFails: boolean;
let accessFails: boolean;
let calls: Array<{ method: string; path: string }>;
const onView = vi.fn();
const props = {
  taskId: 'task-a',
  taskCreatedAt: '2026-11-04T00:00:00Z',
  projectId: 'project-a',
  projectSlug: 'alpha',
  onView,
};
function source(overrides: Partial<ToolLibrarySource> = {}): ToolLibrarySource {
  return {
    id: 'docs',
    kind: 'integration',
    name: 'Project documentation',
    from: 'Station',
    installed: true,
    enabled: true,
    permitted: true,
    operatorOnly: false,
    tools: [{ name: 'read', description: 'Read project documentation.' }],
    ...overrides,
  };
}
function mount() {
  return render(
    <QueryClientProvider client={client}>
      <TaskCapabilityPath {...props} />
    </QueryClientProvider>,
  );
}
function openTools() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect Project tools' }),
  );
}
beforeEach(() => {
  state.enabled = true;
  state.scope = {
    apiBase: 'http://station.test',
    authorityKey: 'person-a',
    isCurrent: () => true,
  };
  onView.mockReset();
  calls = [];
  catalogFails = false;
  accessFails = false;
  access = {
    principalId: 'person-a',
    name: 'Alice',
    station: { name: 'Station', operator: false, canInstallTools: false },
    projects: [
      {
        id: 'project-a',
        slug: 'alpha',
        name: 'Alpha',
        role: 'admin',
        canManageAgents: true,
        canManageTools: false,
        canExecute: false,
      },
    ],
  };
  view = {
    sources: [
      source(),
      source({ id: 'disabled', name: 'Offline service', enabled: false }),
      source({ id: 'blocked', name: 'Restricted service', permitted: false }),
      source({
        id: 'missing',
        name: 'Optional service',
        installed: false,
        enabled: false,
        tools: [],
      }),
    ],
    operator: false,
    canManageAgents: true,
    canManagePolicy: false,
    policy: { mode: 'all', sources: [], revision: 1 },
    project: { id: 'project-a', slug: 'alpha', name: 'Alpha' },
  };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setClientCredentialResolver(() => ({
    origin: state.scope.apiBase,
    requestAuthority: state.scope,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname + url.search;
      calls.push({ method: init?.method ?? 'GET', path });
      if (path === '/api/tool-library/access')
        return Response.json(
          accessFails
            ? { success: false, error: 'Access unavailable' }
            : { success: true, data: access, principalId: access.principalId },
          { status: accessFails ? 503 : 200 },
        );
      if (path === '/api/tool-library/catalog?project=alpha')
        return Response.json(
          catalogFails
            ? { success: false, error: 'Catalog unavailable' }
            : { success: true, data: view, principalId: access.principalId },
          { status: catalogFails ? 503 : 200 },
        );
      throw new Error(`Unexpected capability request: ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('reads only when opened, presents setup restrictions, and links to the existing Task views without writes', async () => {
  mount();
  expect(calls).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Work chats' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Artifacts and receipts' }),
  );
  expect(onView.mock.calls).toEqual([['Work chats'], ['Details']]);
  openTools();
  await screen.findByText('Project documentation');
  expect(screen.getByText('Disabled or unavailable')).toBeTruthy();
  expect(screen.getByText('Excluded by Project policy')).toBeTruthy();
  expect(screen.getByText('Not installed')).toBeTruthy();
  expect(screen.queryByText('Ready')).toBeNull();
  expect(calls).toEqual([
    { method: 'GET', path: '/api/tool-library/access' },
    { method: 'GET', path: '/api/tool-library/catalog?project=alpha' },
  ]);
});

test('does not load a catalog without Project Agent management access or with the preview disabled', async () => {
  state.enabled = false;
  const mounted = mount();
  expect(
    screen.queryByRole('region', { name: 'Capabilities and evidence' }),
  ).toBeNull();
  expect(calls).toEqual([]);
  state.enabled = true;
  access.projects[0].canManageAgents = false;
  mounted.rerender(
    <QueryClientProvider client={client}>
      <TaskCapabilityPath {...props} />
    </QueryClientProvider>,
  );
  openTools();
  await screen.findByText(
    'Project Agent management access is required to inspect tools',
  );
  expect(calls).toEqual([{ method: 'GET', path: '/api/tool-library/access' }]);
});

test('search finds a reported tool beyond the first page and offers a clear-filter recovery', async () => {
  view.sources = [
    source({
      tools: Array.from({ length: 25 }, (_, index) => ({
        name: `action-${index}`,
        description: `Action ${index}`,
      })),
    }),
  ];
  mount();
  openTools();
  await screen.findByText('Project documentation');
  fireEvent.change(
    screen.getByRole('searchbox', { name: 'Find a Project tool' }),
    { target: { value: 'action-24' } },
  );
  fireEvent.click(screen.getByText('Project documentation'));
  expect(screen.getByText('action-24')).toBeTruthy();
  expect(screen.queryByText('action-0')).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'unknown capability' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
  expect(screen.getByText('Project documentation')).toBeTruthy();
});

test('a failed refresh hides cached setup until retry succeeds, and wrong Project data remains unavailable', async () => {
  mount();
  openTools();
  await screen.findByText('Project documentation');
  catalogFails = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tools' }));
  await screen.findByText('Project tools unavailable');
  expect(screen.queryByText('Project documentation')).toBeNull();
  catalogFails = false;
  view.project = { id: 'other-project', slug: 'other', name: 'Other' };
  fireEvent.click(screen.getByRole('button', { name: 'Retry Project tools' }));
  await waitFor(() =>
    expect(calls.filter((call) => call.path.includes('catalog'))).toHaveLength(
      3,
    ),
  );
  expect(screen.queryByText('Project documentation')).toBeNull();
  view.project = { id: 'project-a', slug: 'alpha', name: 'Alpha' };
  fireEvent.click(screen.getByRole('button', { name: 'Retry Project tools' }));
  await screen.findByText('Project documentation');
});

test('access failures have their own retry and retiring the preview removes the expanded inspector', async () => {
  accessFails = true;
  const mounted = mount();
  openTools();
  await screen.findByText('Tool access unavailable');
  expect(calls.some((call) => call.path.includes('catalog'))).toBe(false);
  accessFails = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry tool access' }));
  await screen.findByText('Project documentation');
  state.enabled = false;
  mounted.rerender(
    <QueryClientProvider client={client}>
      <TaskCapabilityPath {...props} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('searchbox')).toBeNull();
  const reads = calls.length;
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5100);
  });
  expect(calls).toHaveLength(reads);
});

test('refuses a catalog envelope belonging to another person', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/catalog')) {
        const body = await response.json();
        return Response.json({ ...body, principalId: 'other-person' });
      }
      return response;
    }),
  );
  mount();
  openTools();
  await screen.findByText('Project tools unavailable');
  expect(screen.queryByText('Project documentation')).toBeNull();
});

test('a changed Station authority retires an outstanding catalog read and resets inspection', async () => {
  let release: (response: Response) => void = () => {
    throw new Error('No catalog is pending');
  };
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/catalog'))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return original(input, init);
    }),
  );
  const mounted = mount();
  openTools();
  await screen.findByRole('status', { name: 'Loading Project tools' });
  const previous = state.scope;
  previous.isCurrent = () => false;
  state.scope = {
    apiBase: previous.apiBase,
    authorityKey: 'person-b',
    isCurrent: () => true,
  };
  mounted.rerender(
    <QueryClientProvider client={client}>
      <TaskCapabilityPath {...props} />
    </QueryClientProvider>,
  );
  await act(async () => {
    release(
      Response.json({ success: true, data: view, principalId: 'person-a' }),
    );
  });
  expect(
    screen
      .getByRole('button', { name: 'Inspect Project tools' })
      .getAttribute('aria-expanded'),
  ).toBe('false');
  expect(screen.queryByText('Project documentation')).toBeNull();
  expect(screen.queryByRole('searchbox')).toBeNull();
});
