/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserNetworkDrawer } from '../BrowserNetworkDrawer';
import type { BrowserPaneApi } from '../browserPaneApi';

afterEach(cleanup);

it('filters failed requests and XHR requests through the drawer control', async () => {
  const network = vi.fn(async () => ({
    generation: 1,
    latestSeq: 3,
    dropped: 0,
    entries: [
      {
        seq: 1,
        method: 'GET',
        url: 'https://example.test/a',
        type: 'Document',
        status: 200,
      },
      {
        seq: 2,
        method: 'POST',
        url: 'https://example.test/b',
        type: 'XHR',
        status: 503,
      },
      {
        seq: 3,
        method: 'GET',
        url: 'https://example.test/c',
        type: 'Image',
        failed: true,
      },
    ],
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BrowserNetworkDrawer
        api={{ network } as unknown as BrowserPaneApi}
        apiBase=""
        browserSessionId="bs_test"
        generation={1}
        live
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/example.test\/a/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Requests'), {
    target: { value: 'failed' },
  });
  expect(screen.queryByText(/example.test\/a/)).toBeNull();
  expect(screen.getByText(/example.test\/b/)).toBeTruthy();
  expect(screen.getByText(/example.test\/c/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Requests'), {
    target: { value: 'xhr' },
  });
  expect(screen.getByText(/example.test\/b/)).toBeTruthy();
  expect(screen.queryByText(/example.test\/c/)).toBeNull();
});

it('polls newer updates and replaces the existing request without crossing generations', async () => {
  let generation = 1;
  const network = vi.fn(async (_id: string, after: number) =>
    generation === 2
      ? {
          generation: 2,
          latestSeq: 1,
          dropped: 0,
          entries: [
            {
              seq: 1,
              method: 'GET',
              url: 'https://example.test/new',
              type: 'Fetch',
              status: 200,
            },
          ],
        }
      : after === 0
        ? {
            generation: 1,
            latestSeq: 1,
            dropped: 0,
            entries: [
              {
                requestSeq: 1,
                seq: 1,
                method: 'GET',
                url: 'https://example.test/a',
                type: 'Fetch',
              },
            ],
          }
        : {
            generation: 1,
            latestSeq: 2,
            dropped: 0,
            entries: [
              {
                requestSeq: 1,
                seq: 2,
                method: 'GET',
                url: 'https://example.test/a',
                type: 'Fetch',
                status: 200,
              },
            ],
          },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <BrowserNetworkDrawer
        api={{ network } as unknown as BrowserPaneApi}
        apiBase=""
        browserSessionId="bs_test"
        generation={1}
        live
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/Pending/)).toBeTruthy();
  await client.refetchQueries({
    queryKey: ['browser-network', '', 'bs_test', 1],
  });
  expect(await screen.findByText(/200/)).toBeTruthy();
  expect(screen.queryAllByText(/example.test\/a/)).toHaveLength(1);
  expect(network).toHaveBeenLastCalledWith(
    'bs_test',
    1,
    expect.any(AbortSignal),
  );
  generation = 2;
  view.rerender(
    <QueryClientProvider client={client}>
      <BrowserNetworkDrawer
        api={{ network } as unknown as BrowserPaneApi}
        apiBase=""
        browserSessionId="bs_test"
        generation={2}
        live
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/example.test\/new/)).toBeTruthy();
  expect(network).toHaveBeenLastCalledWith(
    'bs_test',
    0,
    expect.any(AbortSignal),
  );
  expect(screen.queryByText(/example.test\/a/)).toBeNull();
});
