// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { conversationConnection } from '../components/conversation/__tests__/fixtures';
import type { StationConnection } from '../connections/station-connection';
import { useConversationStartTarget } from '../hooks/useConversationStartTarget';

const wire = vi.hoisted(() => ({
  source: undefined as
    | undefined
    | {
        remoteEnabled: boolean;
        resolve: (
          options: unknown,
        ) => Promise<{ connection: StationConnection; release: () => void }>;
      },
  projects: vi.fn(),
}));
vi.mock('../connections/StationConnectionsContext', () => ({
  useStationConnectionsOptional: () => wire.source,
}));
vi.mock('@kontourai/station-sdk/client', () => ({
  listProjects: wire.projects,
}));

test('Start waits for the current provider after its predecessor lease is released', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const receiver = conversationConnection('relay');
  let firstCurrent = true;
  const first = { ...receiver, isCurrent: () => firstCurrent };
  const release = vi.fn(() => {
    firstCurrent = false;
  });
  wire.source = {
    remoteEnabled: true,
    resolve: async () => ({ connection: first, release }),
  };
  wire.projects.mockResolvedValue([
    { slug: 'receiver-work', name: 'Receiver work' },
  ]);
  const view = renderHook(() => useConversationStartTarget('receiver', true), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  try {
    await waitFor(() =>
      expect(view.result.current.projects.isSuccess).toBe(true),
    );
    act(() => view.result.current.choose('receiver-work'));
    expect(view.result.current.ready).toBe(true);
    let resolveNext!: (lease: {
      connection: StationConnection;
      release: () => void;
    }) => void;
    wire.source = {
      remoteEnabled: true,
      resolve: () =>
        new Promise((resolve) => {
          resolveNext = resolve;
        }),
    };
    view.rerender();
    expect(release).toHaveBeenCalledOnce();
    expect(view.result.current.ready).toBe(false);
    expect(view.result.current.connection).toBeUndefined();
    expect(view.result.current.context).toBe('receiver-work');
    const second = { ...receiver, runtimeKey: 'replacement-provider' };
    await act(async () =>
      resolveNext({ connection: second, release: () => {} }),
    );
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.connection).toBe(second);
    expect(view.result.current.project?.slug).toBe('receiver-work');
  } finally {
    view.unmount();
    client.clear();
    wire.source = undefined;
  }
});
