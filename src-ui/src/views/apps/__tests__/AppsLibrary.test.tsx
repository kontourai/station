// @vitest-environment jsdom
import type { LayoutMetadata } from '@kontourai/station-contracts/layout';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppsLibrary } from '../AppsLibrary';

let boards: LayoutMetadata[];
let enabled: boolean;
let denied: boolean;
let readFailed: boolean;
let requests: { method: string; path: string; body: unknown }[];
const open = vi.fn();
const deleted = vi.fn();
const clients: QueryClient[] = [];

beforeEach(() => {
  enabled = true;
  denied = false;
  readFailed = false;
  requests = [];
  boards = [
    {
      id: 'daily',
      slug: 'daily',
      type: 'custom',
      name: 'Daily brief',
      icon: '🌿',
      description: 'Morning decisions',
    },
    {
      id: 'tools',
      slug: 'tools',
      type: 'custom',
      name: 'Tool desk',
      plugin: 'acme-tools',
      description: 'Plugin workspace',
    },
  ];
  _setApiBase('https://station.test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path, method, body });
      const reply = (data: unknown, status = 200) =>
        new Response(
          JSON.stringify(
            status < 400
              ? { success: true, data }
              : { success: false, error: 'Access refused' },
          ),
          { status, headers: { 'Content-Type': 'application/json' } },
        );
      if (path === '/api/feature-previews')
        return reply([{ id: 'apps-library', enabled }]);
      if (path === '/api/me/layouts' && method === 'GET')
        return reply(boards, readFailed ? 403 : 200);
      if (path === '/api/me/layouts' && method === 'POST') {
        const created = { ...body, id: body.slug, type: 'custom' };
        boards.push(created);
        return reply(created, 201);
      }
      const slug = path.split('/').at(-1);
      if (method === 'PUT') {
        const board = boards.find((entry) => entry.slug === slug);
        Object.assign(board!, body);
        return reply(board);
      }
      if (method === 'DELETE') {
        if (denied) return reply(null, 403);
        boards = boards.filter((entry) => entry.slug !== slug);
        return reply(null);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <AppsLibrary onClose={vi.fn()} onOpen={open} onDeleted={deleted} />
    </QueryClientProvider>,
  );
}

test('a disabled preview cannot mount the launcher or read personal layouts', async () => {
  enabled = false;
  mount();
  await waitFor(() =>
    expect(
      requests.some((entry) => entry.path === '/api/feature-previews'),
    ).toBe(true),
  );
  expect(screen.queryByRole('dialog', { name: /Apps/ })).toBeNull();
  expect(requests.some((entry) => entry.path === '/api/me/layouts')).toBe(
    false,
  );
});

test('searches the owned inventory, distinguishes plugin layouts and opens the exact Board', async () => {
  mount();
  await screen.findByRole('button', { name: 'Open Daily brief' });
  expect(
    within(screen.getByRole('region', { name: 'Plugin layouts' })).getByText(
      'acme-tools',
    ),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Search apps'), {
    target: { value: 'acme' },
  });
  expect(screen.queryByRole('button', { name: 'Open Daily brief' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open Tool desk' }));
  expect(open).toHaveBeenCalledWith('tools');
  fireEvent.change(screen.getByLabelText('Search apps'), {
    target: { value: 'missing' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
  expect(screen.getByRole('button', { name: 'Open Daily brief' })).toBeTruthy();
});

test('creates a named Board at a free address and opens it after the form closes', async () => {
  mount();
  await screen.findByRole('button', { name: 'Open Daily brief' });
  fireEvent.click(screen.getByRole('button', { name: 'New Board' }));
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'Daily' },
  });
  fireEvent.change(screen.getByLabelText('Icon'), { target: { value: '☀️' } });
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'Release watch' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create Board' }));
  await waitFor(() => expect(open).toHaveBeenCalledWith('daily-2'));
  expect(requests.find((entry) => entry.method === 'POST')?.body).toEqual({
    slug: 'daily-2',
    name: 'Daily',
    icon: '☀️',
    description: 'Release watch',
  });
  expect(screen.queryByRole('dialog', { name: 'New Board' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Unsaved Changes' })).toBeNull();
});

test('edits metadata without replacing the layout config or changing its address', async () => {
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Edit Daily brief details' }),
  );
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'Release desk' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
  await screen.findByRole('button', { name: 'Open Release desk' });
  expect(requests.find((entry) => entry.method === 'PUT')).toEqual({
    path: '/api/me/layouts/daily',
    method: 'PUT',
    body: {
      name: 'Release desk',
      icon: '🌿',
      description: 'Morning decisions',
    },
  });
  expect(open).not.toHaveBeenCalled();
});

test('requires deletion confirmation and retains the Board when authority refuses it', async () => {
  denied = true;
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Delete Daily brief' }),
  );
  expect(requests.some((entry) => entry.method === 'DELETE')).toBe(false);
  fireEvent.click(
    screen.getByRole('button', { name: 'Delete Board', exact: true }),
  );
  await screen.findByText('Access refused');
  expect(deleted).not.toHaveBeenCalled();
  expect(boards.some((board) => board.slug === 'daily')).toBe(true);
  denied = false;
  fireEvent.click(
    screen.getByRole('button', { name: 'Delete Board', exact: true }),
  );
  await waitFor(() => expect(deleted).toHaveBeenCalledWith('daily'));
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Open Daily brief' }),
    ).toBeNull(),
  );
});

test('a failed list cannot create and recovers through Retry apps', async () => {
  readFailed = true;
  mount();
  await screen.findByRole('button', { name: 'Retry apps' });
  expect(
    screen.getByRole('button', { name: 'New Board' }).hasAttribute('disabled'),
  ).toBe(true);
  readFailed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry apps' }));
  await screen.findByRole('button', { name: 'Open Daily brief' });
  expect(
    screen.getByRole('button', { name: 'New Board' }).hasAttribute('disabled'),
  ).toBe(false);
});
