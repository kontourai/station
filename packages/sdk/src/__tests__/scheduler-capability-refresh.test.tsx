// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { resetPublicStationCapabilities } from '../publicStationCapabilities';
import { useScheduledConversationTargetCapability } from '../query-domains/scheduler';

vi.mock('../api', () => ({ _getApiBase: async () => 'http://station.test' }));

afterEach(() => {
  vi.unstubAllGlobals();
  resetPublicStationCapabilities();
});

test('refresh after a host upgrade reads a new descriptor even when history was supported', async () => {
  let supported = false;
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          environmentId: '00000000-0000-4000-8000-000000000000',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
          transports: { http: 1, sse: 1, websocket: 1 },
          compatibility: {
            serverVersion: '0.1.11',
            protocolVersion: 3,
            minClientProtocol: 1,
            capabilities: {
              remoteAuth: 1,
              devicePairing: 1,
              environmentProof: 1,
            },
          },
          capabilities: {
            sessionEventWindow: true,
            scheduledConversationTarget: supported,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(
    () => useScheduledConversationTargetCapability(),
    { wrapper },
  );
  await waitFor(() => expect(result.current.data).toBe(false));
  supported = true;
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ['scheduler', 'conversation-target-capability'],
    });
  });
  await waitFor(() => expect(result.current.data).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(2);
  supported = false;
  await waitFor(() => expect(result.current.data).toBe(false), {
    timeout: 15_000,
  });
  expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(3);
  unmount();
  client.clear();
});
