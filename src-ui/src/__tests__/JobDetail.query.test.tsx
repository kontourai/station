// @vitest-environment jsdom
import type { RunSummary } from '@kontourai/station-contracts/runs';
import {
  _setApiBase,
  setClientCredentialResolver,
} from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { JobDetail } from '../components/scheduler/JobDetail';
import { NavigationProvider } from '../contexts/NavigationContext';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('run history stays honest during a refused read and recovers in place through keyboard Retry', async () => {
  const authority = {
    apiBase: 'https://station.test',
    authorityKey: 'history-fixture:1',
    isCurrent: () => true,
  };
  const firstRead = deferred<Response>();
  const retryRead = deferred<Response>();
  const unexpected: string[] = [];
  let runReads = 0;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const selected: RunSummary = {
    runId: 'selected-run',
    providerId: 'station',
    source: 'schedule',
    sourceId: 'nightly-sync',
    status: 'failed',
    startedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    retryEligible: false,
    attempt: 1,
    failureMessage: 'Selected job result',
  };
  const runs: RunSummary[] = [
    selected,
    {
      ...selected,
      runId: 'other-job',
      sourceId: 'other-job',
      failureMessage: 'Other job result',
    },
    {
      ...selected,
      runId: 'other-provider',
      providerId: 'other-provider',
      failureMessage: 'Other provider result',
    },
    {
      ...selected,
      runId: 'other-source',
      source: 'invoke',
      failureMessage: 'Other source result',
    },
  ];
  const user = userEvent.setup();
  _setApiBase(authority.apiBase);
  // Declared fixture authority precondition, not evidence of real authentication.
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    requestAuthority: authority,
  }));
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      if (
        url.origin === authority.apiBase &&
        method === 'GET' &&
        !url.search &&
        url.pathname === '/scheduler/jobs'
      ) {
        return response({ success: true, data: [] });
      }
      if (
        url.origin === authority.apiBase &&
        method === 'GET' &&
        !url.search &&
        url.pathname === '/api/runs'
      ) {
        runReads += 1;
        if (runReads === 1) return firstRead.promise;
        if (runReads === 2) return retryRead.promise;
      }
      const request = `${method} ${url.href}`;
      unexpected.push(request);
      throw new Error(`Unexpected history fixture request: ${request}`);
    }),
  );
  try {
    render(
      <QueryClientProvider client={client}>
        <NavigationProvider>
          <section aria-label="nightly-sync run history">
            <JobDetail name="nightly-sync" providerId="station" />
          </section>
        </NavigationProvider>
      </QueryClientProvider>,
    );
    const detail = screen.getByRole('region', {
      name: 'nightly-sync run history',
    });
    await waitFor(() => expect(runReads).toBe(1));
    expect(
      within(detail).queryByText('No run history', { exact: true }),
    ).toBeNull();
    expect(within(detail).getByLabelText('Loading run history')).toBeTruthy();
    await act(async () => {
      firstRead.resolve(
        response(
          { success: false, error: 'Run history storage unavailable' },
          503,
        ),
      );
    });
    const refusal = await within(detail).findByRole('alert');
    expect(refusal.textContent?.trim()).not.toBe('');
    expect(
      within(detail).queryByText('No run history', { exact: true }),
    ).toBeNull();
    const retry = within(detail).getByRole('button', { name: 'Retry' });
    await user.tab();
    expect(document.activeElement).toBe(retry);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(runReads).toBe(2));
    expect(
      within(detail).queryByText('No run history', { exact: true }),
    ).toBeNull();
    expect(
      screen.getByRole('region', { name: 'nightly-sync run history' }),
    ).toBe(detail);
    await act(async () => {
      retryRead.resolve(response({ success: true, data: runs }));
    });
    expect(await within(detail).findByText('Selected job result')).toBeTruthy();
    expect(within(detail).queryByText('Other job result')).toBeNull();
    expect(within(detail).queryByText('Other provider result')).toBeNull();
    expect(within(detail).queryByText('Other source result')).toBeNull();
    expect(
      within(detail).queryByText('No run history', { exact: true }),
    ).toBeNull();
    expect(within(detail).queryByRole('alert')).toBeNull();
    expect(
      screen.getByRole('region', { name: 'nightly-sync run history' }),
    ).toBe(detail);
    expect(unexpected).toEqual([]);
  } finally {
    cleanup();
    firstRead.resolve(
      response({ success: false, error: 'Fixture released' }, 503),
    );
    retryRead.resolve(
      response({ success: false, error: 'Fixture released' }, 503),
    );
    await client.cancelQueries();
    client.clear();
    setClientCredentialResolver(undefined);
    _setApiBase('');
    vi.unstubAllGlobals();
    expect(unexpected).toEqual([]);
  }
});
