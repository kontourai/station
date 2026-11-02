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
