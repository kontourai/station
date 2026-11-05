/** @vitest-environment jsdom */
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryErasurePreview } from '../MemoryErasurePreview';

const state = vi.hoisted(() => ({
  enabled: true,
  authorityKey: 'owner',
  current: true,
}));
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
      isCurrent: () => state.current && state.authorityKey === key,
    };
  },
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  state.enabled = true;
  state.authorityKey = 'owner';
  state.current = true;
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

test('shows the Corpus proposal impact without inventing record effects', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('erasure-preview')
        ? reply({
            success: true,
            data: {
              kind: 'proposal',
              id: 'proposal-1',
              title: 'A memory',
              impact: {
                proposalId: 'proposal-1',
                alreadyErased: false,
                state: 'pending',
                revision: 'revision-1',
              },
            },
          })
        : reply({
            success: true,
            data: [{ id: 'proposal-1', candidate: { title: 'A memory' } }],
          }),
    ),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Look up proposal' }),
  );
  expect(await screen.findByText('Found proposal · proposal-1')).toBeTruthy();
  expect(
    screen.getByText(/Claims affected \(from Surface\): unavailable/),
  ).toBeTruthy();
  expect(screen.getByText('Proposal to erase: proposal-1')).toBeTruthy();
  expect(
    screen.getByText('The pending proposal will be rejected.'),
  ).toBeTruthy();
  expect(screen.queryByText(/survivors|referrers/i)).toBeNull();
  expect(screen.getByRole('button', { name: 'Erase memory' })).toBeTruthy();
});

test('disabled preview renders nothing and makes no request', async () => {
  state.enabled = false;
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const { container } = mount();
  await waitFor(() => expect(container.textContent).toBe(''));
  expect(fetcher).not.toHaveBeenCalled();
});

test('shows returned record effects and warns that survivors may retain content', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('erasure-preview')
        ? reply({
            success: true,
            data: {
              kind: 'record',
              id: 'record-1',
              title: 'A memory',
              impact: {
                revision: 'revision-1',
                purged: ['record-1'],
                cascaded: ['record-2'],
                survivors: ['record-3'],
                referrers: [],
                alreadyPurged: [],
                proposalsRejected: [],
                proposalsScrubbed: [],
                proposalsBlocked: ['proposal-2'],
              },
            },
          })
        : reply({ success: true, data: [] }),
    ),
  );
  mount();
  fireEvent.change(screen.getByLabelText('ID'), {
    target: { value: 'record-1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
  expect(await screen.findByText('record-2')).toBeTruthy();
  expect(screen.getByText('record-3')).toBeTruthy();
  expect(screen.getByText('proposal-2')).toBeTruthy();
  expect(
    screen.getByText('Records to review may still contain erased content.'),
  ).toBeTruthy();
  expect(screen.queryByText('revision-1')).toBeNull();
});

test('refuses an impact response for a different target', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('erasure-preview')
        ? reply({
            success: true,
            data: {
              kind: 'proposal',
              id: 'proposal-1',
              title: 'Wrong target',
              impact: {
                proposalId: 'proposal-2',
                alreadyErased: false,
                state: 'pending',
                revision: 'revision-1',
              },
            },
          })
        : reply({
            success: true,
            data: [{ id: 'proposal-1', candidate: { title: 'Proposal' } }],
          }),
    ),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Look up proposal' }),
  );
  expect(await screen.findByText('Couldn’t load memory')).toBeTruthy();
  expect(screen.queryByText('Wrong target')).toBeNull();
});

test('does not display the previous authority’s result after switching accounts', async () => {
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
              impact: {
                proposalId: 'proposal-1',
                alreadyErased: false,
                state: 'pending',
                revision: 'revision-1',
              },
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
    await screen.findByRole('button', { name: 'Look up proposal' }),
  );
  expect(await screen.findByText('Owner result')).toBeTruthy();
  state.authorityKey = 'other';
  view.rerender(
    <QueryClientProvider client={clients[0]}>
      <MemoryErasurePreview />
    </QueryClientProvider>,
  );
  expect(screen.queryByText('Owner result')).toBeNull();
  expect(screen.queryByText('Other result')).toBeNull();
  await waitFor(() =>
    expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(''),
  );
});

test('requires confirmation of the plan and renders the returned receipt', async () => {
  const emptyImpact = {
    purged: ['record-1'],
    cascaded: ['record-2'],
    survivors: [],
    referrers: [],
    alreadyPurged: [],
    proposalsRejected: [],
    proposalsScrubbed: [],
    proposalsBlocked: [],
  };
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/memory/erase') && init?.method === 'POST')
        return reply({
          success: true,
          data: {
            receipt: {
              kind: 'record',
              result: { ...emptyImpact, cascaded: ['record-4'] },
            },
          },
        });
      if (String(input).includes('erasure-preview'))
        return reply({
          success: true,
          data: {
            kind: 'record',
            id: 'record-1',
            title: 'A memory',
            impact: { ...emptyImpact, revision: 'revision-1' },
          },
        });
      return reply({ success: true, data: [] });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  fireEvent.change(screen.getByLabelText('ID'), {
    target: { value: 'record-1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Erase memory' }));
  const dialog = screen.getByRole('alertdialog');
  expect(within(dialog).getByText(/cannot be undone/)).toBeTruthy();
  expect(within(dialog).getByText(/record-2/)).toBeTruthy();
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).endsWith('/memory/erase')),
  ).toHaveLength(0);
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Erase permanently' }),
  );
  const receipt = await screen.findByRole('region', {
    name: 'Erasure receipt',
  });
  expect(within(receipt).getByText('record-4')).toBeTruthy();
  expect(within(receipt).queryByText('record-2')).toBeNull();
});

test('stale confirmation refreshes the preview and requires confirmation again', async () => {
  let revision = 'revision-1';
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/memory/erase') && init?.method === 'POST') {
        revision = 'revision-2';
        return reply({ success: false, code: 'STALE_REVISION' }, 409);
      }
      if (String(input).includes('erasure-preview'))
        return reply({
          success: true,
          data: {
            kind: 'proposal',
            id: 'proposal-1',
            title: 'A memory',
            impact: {
              proposalId: 'proposal-1',
              alreadyErased: false,
              state: 'pending',
              revision,
            },
          },
        });
      return reply({
        success: true,
        data: [{ id: 'proposal-1', candidate: { title: 'A memory' } }],
      });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Look up proposal' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Erase memory' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Erase permanently',
    }),
  );
  expect(
    await screen.findByText(
      'Memory changed. Review the updated effects and confirm again.',
    ),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).includes('erasure-preview'),
      ).length,
    ).toBeGreaterThan(1),
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).endsWith('/memory/erase')),
  ).toHaveLength(1);
});

test.each([
  [403, 'Sign in as the host operator to erase memories.'],
  [404, 'Private memory is unavailable. Check access or update Station.'],
  [
    503,
    'Erasure could not be confirmed. Retry here, or restart Station if it still fails.',
  ],
])('explains erasure failure %s', async (status, message) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/memory/erase') && init?.method === 'POST')
        return reply({ success: false }, status);
      if (String(input).includes('erasure-preview'))
        return reply({
          success: true,
          data: {
            kind: 'proposal',
            id: 'proposal-1',
            title: 'A memory',
            impact: {
              proposalId: 'proposal-1',
              alreadyErased: false,
              state: 'pending',
              revision: 'revision-1',
            },
          },
        });
      return reply({
        success: true,
        data: [{ id: 'proposal-1', candidate: { title: 'A memory' } }],
      });
    }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Look up proposal' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Erase memory' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Erase permanently',
    }),
  );
  expect(await screen.findByText(message)).toBeTruthy();
});

test('explains an unavailable store and a missing target without offering retry', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('erasure-preview')
        ? reply({ success: false }, 404)
        : reply({ success: false }, 404),
    ),
  );
  mount();
  expect(await screen.findByText('Private memory is unavailable')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('ID'), {
    target: { value: 'missing' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
  expect(
    await screen.findByText('That ID doesn’t match a memory or proposal.'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

test('hides the preview when the authority is no longer current', () => {
  state.current = false;
  const { container } = mount();
  expect(container.textContent).toBe('');
});

test('omits erased proposals from the list', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      reply({
        success: true,
        data: [
          {
            id: 'live',
            candidate: { title: 'Live proposal' },
            state: 'pending',
            proposer_id: 'owner',
            evidence: {},
            proposed_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 'erased',
            candidate: { title: '[purged]' },
            state: 'rejected',
            proposer_id: 'owner',
            evidence: {},
            proposed_at: '2026-01-01T00:00:00Z',
            erasure: { erased_at: '2026-01-02T00:00:00Z' },
          },
        ],
      }),
    ),
  );
  mount();
  expect(await screen.findByText('Live proposal')).toBeTruthy();
  expect(screen.queryByText('[purged]')).toBeNull();
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
