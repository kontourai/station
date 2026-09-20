/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GuestDeviceOnboarding } from '../GuestDeviceOnboarding';

const apiA = 'https://a.example.test';
const apiB = 'https://b.example.test';
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

afterEach(() => vi.unstubAllGlobals());

test('a late Station A response cannot repopulate Station B UI or query cache', async () => {
  let resolveA!: (response: Response) => void;
  const pendingA = new Promise<Response>((resolve) => {
    resolveA = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) =>
      input.startsWith(apiA)
        ? pendingA
        : Promise.resolve(success([view('Beta')])),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onAccountRequired = vi.fn();
  const rendered = render(
    <QueryClientProvider client={client}>
      <GuestDeviceOnboarding
        key={`${apiA}:person-a`}
        apiBase={apiA}
        principalId="person-a"
        onAccountRequired={onAccountRequired}
      />
    </QueryClientProvider>,
  );
  rendered.rerender(
    <QueryClientProvider client={client}>
      <GuestDeviceOnboarding
        key={`${apiB}:person-b`}
        apiBase={apiB}
        principalId="person-b"
        onAccountRequired={onAccountRequired}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Beta')).toBeTruthy();
  resolveA(success([view('Alpha')]));
  await waitFor(() =>
    expect(
      client.getQueryData(['guest-projects', apiA, 'person-a']),
    ).toBeUndefined(),
  );
  expect(screen.queryByText('Alpha')).toBeNull();
  expect(client.getQueryData(['guest-projects', apiB, 'person-b'])).toEqual([
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
    vi.fn((input: string) =>
      new URL(input).pathname === '/api/projects/example'
        ? pendingDetail
        : Promise.resolve(success([view('Example Project', 'example')])),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GuestDeviceOnboarding
        apiBase={apiA}
        principalId="person-a"
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
    await screen.findByText('This Project is no longer shared with you.'),
  ).toBeTruthy();
  expect(
    screen.queryByRole('region', { name: 'Example Project details' }),
  ).toBeNull();
  const state = client.getQueryState([
    'guest-project',
    apiA,
    'person-a',
    'example',
  ]);
  expect(state?.status).toBe('error');
  expect(state?.data).toBeUndefined();
});
