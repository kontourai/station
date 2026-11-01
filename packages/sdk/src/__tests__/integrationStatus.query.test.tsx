// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { useIntegrationStatusQuery } from '../query-domains/integrationStatus';

const response = (reason: string) =>
  Response.json({
    success: true,
    data: {
      connections: [
        {
          connectionId: 'github',
          provider: 'github',
          actions: [
            {
              action: 'read',
              computedBy: 'github.gh-auth-status',
              state: 'unverified',
              reason,
            },
          ],
        },
      ],
    },
  });

afterEach(() => vi.unstubAllGlobals());

test.each([false, true])(
  'Station changes never expose previous status (caller opt-in: %s)',
  async (optIn) => {
    const client = new QueryClient();
    let release!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response('station a'))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(
      ({ apiBase }) =>
        useIntegrationStatusQuery(
          apiBase,
          optIn ? { keepPreviousData: true } : undefined,
        ),
      { initialProps: { apiBase: 'https://a.example' }, wrapper },
    );
    try {
      await waitFor(() =>
        expect(
          view.result.current.data?.connections[0]?.actions[0]?.reason,
        ).toBe('station a'),
      );
      view.rerender({ apiBase: 'https://b.example' });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(view.result.current.data).toBeUndefined();
      expect(view.result.current.isPlaceholderData).toBe(false);
      await act(async () => {
        release(response('station b'));
      });
      await waitFor(() =>
        expect(
          view.result.current.data?.connections[0]?.actions[0]?.reason,
        ).toBe('station b'),
      );
      expect(view.result.current.isPlaceholderData).toBe(false);
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
