/** @vitest-environment jsdom */
import type {
  RepositoryAcquisition,
  RepositoryAcquisitionRequest,
} from '@kontourai/station-contracts/project';
import { _setApiBase } from '@kontourai/station-sdk';
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

const authority = vi.hoisted(() => ({
  scope: {
    apiBase: 'http://station.test',
    authorityKey: 'alice',
    draftRecoveryKey: 'alice-recovery',
    isCurrent: () => true,
  },
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => authority.scope,
}));

import { NewProjectRepositorySource } from '../components/modals/NewProjectRepositorySource';

const clients: QueryClient[] = [];
beforeEach(() => {
  sessionStorage.clear();
  authority.scope = {
    apiBase: 'http://station.test',
    authorityKey: 'alice',
    draftRecoveryKey: 'alice-recovery',
    isCurrent: () => true,
  };
  _setApiBase(authority.scope.apiBase);
  setClientCredentialResolver(() => {
    const captured = authority.scope;
    return {
      origin: captured.apiBase,
      requestAuthority: {
        ...captured,
        isCurrent: () => authority.scope === captured,
      },
    };
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
function mount(onUseCheckout = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const onBusyChange = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <NewProjectRepositorySource
        onUseCheckout={onUseCheckout}
        onBusyChange={onBusyChange}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('Start from a Git repository'));
  return { ...view, onUseCheckout, onBusyChange, client };
}
function enterSource() {
  fireEvent.change(screen.getByLabelText('Repository URL'), {
    target: { value: 'git@github.com:org/research.git' },
  });
  fireEvent.change(screen.getByLabelText('Branch or tag (optional)'), {
    target: { value: 'release' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Acquire repository' }));
}

test.each(['github', 'gitlab'] as const)(
  '%s account selection keeps the chosen provider transport and branch through actual acquisition dispatch',
  async (provider) => {
    const host = provider === 'github' ? 'github.com' : 'gitlab.com';
    let acquired: RepositoryAcquisitionRequest | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes(`/repository-providers/${provider}?page=1`))
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                provider,
                account: { id: '42', login: 'operator' },
                page: 1,
                hasMore: false,
                observedAt: '2026-10-22T00:00:00Z',
                repositories: [
                  {
                    id: '7',
                    fullName: 'org/research',
                    webUrl: `https://${host}/org/research`,
                    httpsCloneUrl: `https://${host}/org/research.git`,
                    sshCloneUrl: `git@${host}:org/research.git`,
                    defaultBranch: 'release',
                    visibility: 'private',
                  },
                ],
              },
            }),
          );
        if (
          url.endsWith('/repository-acquisitions') &&
          init?.method === 'POST'
        ) {
          acquired = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({ success: true, data: ready(acquired!) }),
          );
        }
        if (
          acquired &&
          url.endsWith(`/repository-acquisitions/${acquired.requestId}`)
        )
          return new Response(
            JSON.stringify({ success: true, data: ready(acquired) }),
          );
        throw new Error(`Unexpected fixture request: ${url}`);
      }),
    );
    mount();
    fireEvent.click(
      screen.getByRole('button', {
        name:
          provider === 'github' ? 'Choose from GitHub' : 'Choose from GitLab',
      }),
    );
    await screen.findByText(/Signed in as operator/);
    expect(acquired).toBeUndefined();
    fireEvent.change(screen.getByLabelText('Clone protocol'), {
      target: { value: 'ssh' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use org/research' }));
    expect(screen.getByLabelText('Repository URL')).toHaveProperty(
      'value',
      `git@${host}:org/research.git`,
    );
    expect(screen.getByLabelText('Branch or tag (optional)')).toHaveProperty(
      'value',
      'release',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Acquire repository' }));
    await waitFor(() =>
      expect(acquired).toMatchObject({
        sourceUrl: `git@${host}:org/research.git`,
        sourceRef: 'release',
      }),
    );
  },
);
function ready(request: RepositoryAcquisitionRequest): RepositoryAcquisition {
  return {
    schemaVersion: 1,
    request,
    phase: 'ready',
    attempt: 1,
    checkoutPath: '/host/owned/checkout-1',
    resolvedCommit: 'a'.repeat(40),
    canonicalRemote: 'github.com/org/research',
    updatedAt: '2026-10-22T15:00:00.000Z',
  };
}

test('explicit source and ref reach transport, checkout handoff is deliberate, and reopening recovers the same receipt', async () => {
  let record: RepositoryAcquisition | undefined;
  let posts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith('/api/projects/repository-acquisitions') &&
        init?.method === 'POST'
      ) {
        posts++;
        record = ready(JSON.parse(String(init.body)));
        return Response.json({ success: true, data: record });
      }
      if (
        record &&
        url.endsWith(
          `/api/projects/repository-acquisitions/${record.request.requestId}`,
        )
      )
        return Response.json({ success: true, data: record });
      throw new Error(`Unexpected fixture request: ${url}`);
    }),
  );
  const first = mount();
  enterSource();
  await screen.findByRole('button', { name: 'Use this checkout' });
  expect(record?.request).toMatchObject({
    sourceUrl: 'git@github.com:org/research.git',
    sourceRef: 'release',
  });
  expect(first.onUseCheckout).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use this checkout' }));
  expect(first.onUseCheckout).toHaveBeenCalledWith(
    '/host/owned/checkout-1',
    'research',
    record?.request.requestId,
  );
  expect(first.onBusyChange).toHaveBeenCalledWith(true);
  first.unmount();
  const reopened = mount();
  await screen.findByRole('button', { name: 'Use this checkout' });
  expect(posts).toBe(1);
  expect(reopened.onUseCheckout).not.toHaveBeenCalled();
});

test('a lost POST response is reconciled by reading the retained request, and another authority cannot see its recovery', async () => {
  let record: RepositoryAcquisition | undefined;
  let posts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith('/api/projects/repository-acquisitions') &&
        init?.method === 'POST'
      ) {
        posts++;
        record = ready(JSON.parse(String(init.body)));
        throw new TypeError('Connection lost after server commit');
      }
      if (
        record &&
        url.endsWith(
          `/api/projects/repository-acquisitions/${record.request.requestId}`,
        )
      )
        return Response.json({ success: true, data: record });
      throw new Error(`Unexpected fixture request: ${url}`);
    }),
  );
  const view = mount();
  enterSource();
  await screen.findByRole('button', { name: 'Use this checkout' });
  expect(posts).toBe(1);
  authority.scope = {
    ...authority.scope,
    authorityKey: 'bob',
    draftRecoveryKey: 'bob-recovery',
  };
  view.rerender(
    <QueryClientProvider client={view.client}>
      <NewProjectRepositorySource
        onUseCheckout={view.onUseCheckout}
        onBusyChange={view.onBusyChange}
      />
    </QueryClientProvider>,
  );
  expect(
    screen.queryByRole('button', { name: 'Use this checkout' }),
  ).toBeNull();
  expect(screen.queryByText(/Operation:/)).toBeNull();
});

test('failure exposes an explicit retry under the original request ID', async () => {
  let record: RepositoryAcquisition | undefined;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (
        init?.method === 'POST' &&
        url.endsWith('/api/projects/repository-acquisitions')
      ) {
        calls.push(url);
        record = {
          ...ready(JSON.parse(String(init.body))),
          phase: 'failed',
          resolvedCommit: undefined,
          error: 'Access refused.',
        };
        return Response.json({ success: true, data: record });
      }
      if (
        record &&
        init?.method === 'POST' &&
        url.endsWith(
          `/api/projects/repository-acquisitions/${record.request.requestId}/retry`,
        )
      ) {
        calls.push(url);
        record = {
          ...ready(record.request),
          attempt: 2,
          checkoutPath: '/host/owned/checkout-2',
        };
        return Response.json({ success: true, data: record });
      }
      if (
        record &&
        url.endsWith(
          `/api/projects/repository-acquisitions/${record.request.requestId}`,
        )
      )
        return Response.json({ success: true, data: record });
      throw new Error(`Unexpected fixture request: ${url}`);
    }),
  );
  const view = mount();
  enterSource();
  await screen.findByText('Access refused.');
  expect(calls).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry acquisition' }));
  await screen.findByRole('button', { name: 'Use this checkout' });
  fireEvent.click(screen.getByRole('button', { name: 'Use this checkout' }));
  await waitFor(() =>
    expect(view.onUseCheckout).toHaveBeenCalledWith(
      '/host/owned/checkout-2',
      'research',
      record?.request.requestId,
    ),
  );
  expect(calls).toHaveLength(2);
});
