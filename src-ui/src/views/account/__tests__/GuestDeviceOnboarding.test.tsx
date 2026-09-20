/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GuestDeviceOnboarding } from '../GuestDeviceOnboarding';

const apiA = 'https://a.example.test';
const apiB = 'https://b.example.test';
const principalA = `human:deployment:${'a'.repeat(64)}`;
const principalB = `human:deployment:${'b'.repeat(64)}`;
const view = (name: string, slug = name.toLowerCase()) => ({
  version: 'station.member-project/v1',
  kind: 'member-project',
  id: `${slug}-id`,
  slug,
  name,
  description: `${name} description`,
  actions: ['view'],
});
const success = (data: unknown) => Response.json({ success: true, data });
const account = (id: string) =>
  Response.json({
    data: {
      principal: { id, kind: 'human', display: id },
      issuer: 'station:test',
      expiresAt: '2099-01-01T00:00:00.000Z',
      contacts: [],
    },
  });

afterEach(() => vi.unstubAllGlobals());

test('a late Station A response cannot repopulate Station B UI or query cache', async () => {
  let resolveA!: (response: Response) => void;
  const pendingA = new Promise<Response>((resolve) => {
    resolveA = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/account-auth/session')
        return Promise.resolve(
          account(url.origin === apiA ? principalA : principalB),
        );
      return url.origin === apiA
        ? pendingA
        : Promise.resolve(success([view('Beta')]));
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onAccountRequired = vi.fn();
  const rendered = render(
    <QueryClientProvider client={client}>
      <GuestDeviceOnboarding
        key={`${apiA}:${principalA}`}
        apiBase={apiA}
        principalId={principalA}
        onAccountRequired={onAccountRequired}
      />
    </QueryClientProvider>,
  );
  rendered.rerender(
    <QueryClientProvider client={client}>
      <GuestDeviceOnboarding
        key={`${apiB}:${principalB}`}
        apiBase={apiB}
        principalId={principalB}
        onAccountRequired={onAccountRequired}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Beta')).toBeTruthy();
  resolveA(success([view('Alpha')]));
  await waitFor(() =>
    expect(
      client.getQueryData(['guest-projects', apiA, principalA]),
    ).toBeUndefined(),
  );
  expect(screen.queryByText('Alpha')).toBeNull();
  expect(client.getQueryData(['guest-projects', apiB, principalB])).toEqual([
    view('Beta'),
  ]);
  expect(onAccountRequired).not.toHaveBeenCalled();
});

test('a Project removed during detail read leaves no stale detail in UI or cache', async () => {
  let resolveDetail!: (response: Response) => void;
  const pendingDetail = new Promise<Response>((resolve) => {
    resolveDetail = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/account-auth/session')
        return Promise.resolve(account(principalA));
      return path === '/api/projects/example'
        ? pendingDetail
        : Promise.resolve(success([view('Example Project', 'example')]));
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GuestDeviceOnboarding
        apiBase={apiA}
        principalId={principalA}
        onAccountRequired={vi.fn()}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read Project details' }),
  );
  resolveDetail(
    Response.json(
      { success: false, error: 'Project not found' },
      { status: 404 },
    ),
  );
  expect(
    await screen.findByText(
      'Project details are unavailable. Shared Projects were refreshed.',
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole('region', { name: 'Example Project details' }),
  ).toBeNull();
  const state = client.getQueryState([
    'guest-project',
    apiA,
    principalA,
    'example',
  ]);
  expect(state?.status).toBe('error');
  expect(state?.data).toBeUndefined();
});

test('a same-origin account replacement discards the in-flight Project response', async () => {
  let currentPrincipal = principalA;
  let resolveProjects!: (response: Response) => void;
  const pendingProjects = new Promise<Response>((resolve) => {
    resolveProjects = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/account-auth/session')
        return Promise.resolve(account(currentPrincipal));
      return pendingProjects;
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onAccountRequired = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <GuestDeviceOnboarding
        apiBase={apiA}
        principalId={principalA}
        onAccountRequired={onAccountRequired}
      />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      (fetch as ReturnType<typeof vi.fn>).mock.calls.some(([input]) =>
        String(input).endsWith('/api/projects'),
      ),
    ).toBe(true),
  );
  currentPrincipal = principalB;
  resolveProjects(success([view('Alpha')]));
  await waitFor(() => expect(onAccountRequired).toHaveBeenCalledOnce());
  expect(screen.queryByText('Alpha')).toBeNull();
  expect(
    client.getQueryData(['guest-projects', apiA, principalA]),
  ).toBeUndefined();
});

test('Device loss during detail read hides the whole catalogue and offers approval', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/projects/example')
        return Promise.resolve(new Response(null, { status: 401 }));
      if (path === '/api/account-auth/session')
        return Promise.resolve(
          Response.json({
            data: {
              principal: {
                id: `human:deployment:${'a'.repeat(64)}`,
                kind: 'human',
                display: 'Person A',
              },
              issuer: 'station:test',
              expiresAt: '2099-01-01T00:00:00.000Z',
              contacts: [],
            },
          }),
        );
      return Promise.resolve(success([view('Example Project', 'example')]));
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GuestDeviceOnboarding
        apiBase={apiA}
        principalId={principalA}
        onAccountRequired={vi.fn()}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read Project details' }),
  );
  expect(
    await screen.findByRole('button', {
      name: 'Request access for this browser',
    }),
  ).toBeTruthy();
  expect(screen.queryByText('Example Project')).toBeNull();
  expect(
    screen.queryByText('This browser has view-only Project access.'),
  ).toBeNull();
});
