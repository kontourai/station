/** @vitest-environment jsdom */
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryErasurePreview } from '../MemoryErasurePreview';

const state = vi.hoisted(() => ({ enabled: true, authorityKey: 'owner' }));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  useFeaturePreviewsQuery: () => ({
    data: [{ id: 'private-memory', enabled: state.enabled }],
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => {
    const key = state.authorityKey;
    return {
      apiBase: 'https://station.example.test',
      authorityKey: key,
      isCurrent: () => state.authorityKey === key,
    };
  },
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  state.enabled = true;
  state.authorityKey = 'owner';
  setClientCredentialResolver(() => {
    const key = state.authorityKey;
    return {
      origin: 'https://station.example.test',
      requestAuthority: {
        apiBase: 'https://station.example.test',
        authorityKey: key,
        isCurrent: () => state.authorityKey === key,
      },
    };
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryErasurePreview />
    </QueryClientProvider>,
  );
}
function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('starts from proposals and shows only the target and unavailable impact', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('erasure-preview')
        ? reply({
            success: true,
            data: { kind: 'proposal', id: 'proposal-1', title: 'A memory' },
          })
        : reply({
            success: true,
            data: [{ id: 'proposal-1', candidate: { title: 'A memory' } }],
          }),
    ),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Preview erasure' }),
  );
  expect(await screen.findByText('Found proposal · proposal-1')).toBeTruthy();
  expect(
    screen.getByText(/Claims affected \(from Surface\): unavailable/),
  ).toBeTruthy();
  expect(screen.queryByText(/survivors|referrers/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /^(erase|purge)$/i })).toBeNull();
});

test('disabled preview renders nothing and makes no request', async () => {
  state.enabled = false;
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const { container } = mount();
  await waitFor(() => expect(container.textContent).toBe(''));
  expect(fetcher).not.toHaveBeenCalled();
});

test('does not retain the previous authority’s target after switching accounts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('erasure-preview')
        ? reply({
            success: true,
            data: {
              kind: 'proposal',
              id: 'proposal-1',
              title:
                state.authorityKey === 'owner'
                  ? 'Owner result'
                  : 'Other result',
            },
          })
        : reply({
            success: true,
            data: [{ id: 'proposal-1', candidate: { title: 'Proposal' } }],
          }),
    ),
  );
  const view = mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Preview erasure' }),
  );
  expect(await screen.findByText('Owner result')).toBeTruthy();
  state.authorityKey = 'other';
  view.rerender(
    <QueryClientProvider client={clients[0]}>
      <MemoryErasurePreview />
    </QueryClientProvider>,
  );
  expect(screen.queryByText('Owner result')).toBeNull();
  expect(await screen.findByText('Other result')).toBeTruthy();
});

test('explains a missing store and a missing target without offering retry', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('erasure-preview')
        ? reply({ success: false }, 404)
        : reply({ success: false }, 404),
    ),
  );
  mount();
  expect(
    await screen.findByText(/Private memory hasn’t been created yet/),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('ID'), {
    target: { value: 'missing' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
  expect(
    await screen.findByText('That ID doesn’t match a memory or proposal.'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

test('offers retry when proposals cannot be loaded', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({ success: false }, 503)),
  );
  mount();
  expect(await screen.findByText('Couldn’t load proposals')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});
