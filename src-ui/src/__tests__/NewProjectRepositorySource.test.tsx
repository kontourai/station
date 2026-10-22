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
        url.endsWith('/projects/repository-acquisitions') &&
        init?.method === 'POST'
      ) {
        posts++;
        record = ready(JSON.parse(String(init.body)));
        return Response.json({ success: true, data: record });
      }
      if (
        record &&
        url.endsWith(
          `/projects/repository-acquisitions/${record.request.requestId}`,
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
        url.endsWith('/projects/repository-acquisitions') &&
        init?.method === 'POST'
      ) {
        posts++;
        record = ready(JSON.parse(String(init.body)));
        throw new TypeError('Connection lost after server commit');
      }
      if (
        record &&
        url.endsWith(
          `/projects/repository-acquisitions/${record.request.requestId}`,
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
        url.endsWith('/projects/repository-acquisitions')
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
          `/projects/repository-acquisitions/${record.request.requestId}/retry`,
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
          `/projects/repository-acquisitions/${record.request.requestId}`,
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
    ),
  );
  expect(calls).toHaveLength(2);
});
