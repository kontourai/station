// @vitest-environment jsdom
import type { LayoutMetadata } from '@kontourai/station-contracts/layout';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { navigationStore } from '../../../contexts/navigation-store';
import { AppsLibrary } from '../AppsLibrary';

let boards: LayoutMetadata[];
let enabled: boolean;
let denied: boolean;
let readFailed: boolean;
let deleteResponse: Promise<void> | undefined;
let requests: { method: string; path: string; body: unknown }[];
const open = vi.fn();
const clients: QueryClient[] = [];

beforeEach(() => {
  enabled = true;
  denied = false;
  readFailed = false;
  deleteResponse = undefined;
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
        if (deleteResponse) await deleteResponse;
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
function mount(content?: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      {content ?? <AppsLibrary onClose={vi.fn()} onOpen={open} />}
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
  await screen.findByRole('button', {
    name: 'Daily brief Personal Board Morning decisions',
  });
  expect(
    within(screen.getByRole('region', { name: 'Plugin layouts' })).getByText(
      'acme-tools',
    ),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Search apps'), {
    target: { value: 'acme' },
  });
  expect(
    screen.queryByRole('button', {
      name: 'Daily brief Personal Board Morning decisions',
    }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Tool desk acme-tools Plugin workspace',
    }),
  );
  expect(open).toHaveBeenCalledWith('tools');
  fireEvent.change(screen.getByLabelText('Search apps'), {
    target: { value: 'missing' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
  expect(
    screen.getByRole('button', {
      name: 'Daily brief Personal Board Morning decisions',
    }),
  ).toBeTruthy();
});

test('creates a named Board at a free address and opens it after the form closes', async () => {
  mount();
  await screen.findByRole('button', {
    name: 'Daily brief Personal Board Morning decisions',
  });
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
  fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
    target: { value: 'Release watch' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
  await screen.findByRole('button', {
    name: 'Release desk Personal Board Release watch',
  });
  expect(requests.find((entry) => entry.method === 'PUT')).toEqual({
    path: '/api/me/layouts/daily',
    method: 'PUT',
    body: {
      name: 'Release desk',
      icon: '🌿',
      description: 'Release watch',
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
  fireEvent.click(screen.getByRole('button', { name: 'Delete Board' }));
  await screen.findByText('Access refused');
  expect(boards.some((board) => board.slug === 'daily')).toBe(true);
  denied = false;
  fireEvent.click(screen.getByRole('button', { name: 'Delete Board' }));
  await screen.findByRole('dialog', { name: 'Apps' });
  await waitFor(() =>
    expect(
      screen.queryByRole('button', {
        name: 'Daily brief Personal Board Morning decisions',
      }),
    ).toBeNull(),
  );
});

test('successful deletion closes its confirmation after newer navigation supersedes the return', async () => {
  let release!: () => void;
  deleteResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  act(() => navigationStore.navigate('/boards/daily'));
  mount();
  try {
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete Daily brief' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete Board' }));
    await waitFor(() =>
      expect(
        requests.filter((entry) => entry.method === 'DELETE'),
      ).toHaveLength(1),
    );
    expect(boards.some((board) => board.slug === 'daily')).toBe(false);
    act(() => navigationStore.navigate('/newer-destination'));
    await act(async () => {
      release();
      await deleteResponse;
    });
    await screen.findByRole('dialog', { name: 'Apps' });
    expect(screen.queryByRole('dialog', { name: 'Delete Board?' })).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'Daily brief Personal Board Morning decisions',
      }),
    ).toBeNull();
    expect(window.location.pathname).toBe('/newer-destination');
    expect(requests.filter((entry) => entry.method === 'DELETE')).toHaveLength(
      1,
    );
  } finally {
    release();
  }
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
  await screen.findByRole('button', {
    name: 'Daily brief Personal Board Morning decisions',
  });
  expect(
    screen.getByRole('button', { name: 'New Board' }).hasAttribute('disabled'),
  ).toBe(false);
});

test('route cancellation preserves metadata and discard closes the editor and releases its guard', async () => {
  act(() => navigationStore.navigate('/apps-review-start'));
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Edit Daily brief details' }),
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
    target: { value: 'Keep this draft' },
  });
  act(() => navigationStore.navigate('/apps-review-target'));
  let decision = await screen.findByRole('dialog', { name: 'Unsaved Changes' });
  fireEvent.click(within(decision).getByRole('button', { name: 'Cancel' }));
  expect(window.location.pathname).toBe('/apps-review-start');
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Description' })
      .value,
  ).toBe('Keep this draft');
  act(() => navigationStore.navigate('/apps-review-target'));
  decision = await screen.findByRole('dialog', { name: 'Unsaved Changes' });
  fireEvent.click(within(decision).getByRole('button', { name: 'Discard' }));
  await waitFor(() =>
    expect(window.location.pathname).toBe('/apps-review-target'),
  );
  expect(screen.queryByRole('dialog', { name: 'Edit app details' })).toBeNull();
  act(() => navigationStore.navigate('/apps-review-finished'));
  expect(window.location.pathname).toBe('/apps-review-finished');
  expect(screen.queryByRole('dialog', { name: 'Unsaved Changes' })).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Edit Daily brief details' }),
  );
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Description' })
      .value,
  ).toBe('Morning decisions');
  expect(requests.some((request) => request.method === 'PUT')).toBe(false);
});

function Launcher() {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpened(true)}>
        Browse apps
      </button>
      {opened && <AppsLibrary onClose={() => setOpened(false)} onOpen={open} />}
    </>
  );
}

test('returns keyboard focus to the launcher after visiting a child dialog', async () => {
  mount(<Launcher />);
  const trigger = screen.getByRole('button', { name: 'Browse apps' });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByRole('button', {
    name: 'Daily brief Personal Board Morning decisions',
  });
  const create = screen.getByRole('button', { name: 'New Board' });
  create.focus();
  fireEvent.click(create);
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'New Board' }), {
    key: 'Escape',
  });
  const library = await screen.findByRole('dialog', { name: 'Apps' });
  fireEvent.keyDown(library, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
