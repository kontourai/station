/** @vitest-environment jsdom */
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoryErasurePreview } from '../MemoryErasurePreview';

vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  useFeaturePreviewsQuery: () => ({
    data: [{ id: 'private-memory', enabled: true }],
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://station.example.test',
    authorityKey: 'owner',
    isCurrent: () => true,
  }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

test('shows only the resolved target and an unavailable impact, with no purge or invented cascade', async () => {
  setClientCredentialResolver(() => ({
    origin: 'https://station.example.test',
    requestAuthority: {
      apiBase: 'https://station.example.test',
      authorityKey: 'owner',
      isCurrent: () => true,
    },
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { kind: 'proposal', id: 'proposal-1', title: 'A memory' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryErasurePreview />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText('Type'), {
    target: { value: 'proposal' },
  });
  fireEvent.change(screen.getByLabelText('ID'), {
    target: { value: 'proposal-1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('A memory')).toBeTruthy();
  expect(
    screen.getByText(/Claims affected \(from Surface\): unavailable/),
  ).toBeTruthy();
  expect(screen.queryByText(/survivors|referrers/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /erase|purge/i })).toBeNull();
  client.clear();
});
