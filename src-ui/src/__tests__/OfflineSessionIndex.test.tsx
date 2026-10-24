// @vitest-environment jsdom

import { orchestrationQueries } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { persistQueryClientSave } from '@tanstack/react-query-persist-client';
import { act, render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { OfflineSessionIndex } from '../components/OfflineSessionIndex';
import { buildPersistOptions } from '../lib/queryPersistence';

test('persists a session identifier index without titles, recovery cursors or runtime diagnostics', async () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <OfflineSessionIndex />
    </QueryClientProvider>,
  );
  act(() =>
    client.setQueryData(
      // The exact scoped key the shared session-list query writes.
      orchestrationQueries.sessions({
        apiBase: 'https://station.example.test',
        authorityKey: 'authority-1',
      }).queryKey,
      [
        {
          threadId: 'session-a',
          conversationId: 'conversation-a',
          displayTitle: 'pasted-secret',
          resumeCursor: { token: 'provider-secret' },
          lastRuntimeErrorMessage: 'diagnostic-secret',
        },
      ],
    ),
  );
  let raw: string | undefined;
  const options = buildPersistOptions({
    throttleTime: 0,
    storage: {
      getItem: async () => undefined,
      setItem: async (_key, value) => {
        raw = value;
      },
      removeItem: async () => {},
    },
  });
  await persistQueryClientSave({ queryClient: client, ...options });
  expect(JSON.parse(raw!).clientState.queries).toEqual([
    expect.objectContaining({
      queryKey: ['offline-session-index'],
      state: expect.objectContaining({
        data: {
          savedAt: expect.any(Number),
          rows: [{ threadId: 'session-a', conversationId: 'conversation-a' }],
        },
      }),
    }),
  ]);
  expect(raw).not.toMatch(/pasted-secret|provider-secret|diagnostic-secret/);
  client.clear();
});
