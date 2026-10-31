/** @vitest-environment jsdom */
import { createServer, type ServerResponse } from 'node:http';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';

const scope = vi.hoisted(() => ({ base: '' }));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: scope.base }),
  useHostRequestAuthorityScope: () => ({
    apiBase: scope.base,
    authorityKey: 'person',
    isCurrent: () => true,
  }),
}));
import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';
import { useServerEvents } from '../hooks/useServerEvents';

test.each([true, false])(
  'real SSE transport handles %s multiplex support',
  async (modern) => {
    const requests: { path: string; cursor: string | undefined }[] = [];
    const streams: ServerResponse[] = [];
    const server = createServer((request, response) => {
      const path = request.url ?? '';
      const cursor = request.headers['last-event-id'];
      requests.push({
        path,
        cursor: typeof cursor === 'string' ? cursor : undefined,
      });
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        ...(modern && path.startsWith('/api/orchestration/events')
          ? { 'X-Station-General-Stream': '1' }
          : {}),
      });
      streams.push(response);
      if (path.startsWith('/api/orchestration/events')) {
        response.write(
          'event: orchestration:snapshot\ndata: {"sessions":[]}\nid: 17\n\n',
        );
      } else {
        response.write(': ready\n\n');
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    scope.base = `http://127.0.0.1:${address.port}`;
    const client = new QueryClient();
    const handler = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () => useServerEvents({ 'example:changed': handler }),
      { wrapper },
    );
    const release = ensureOrchestrationEventStream(
      scope.base,
      undefined,
      'person',
    );
    try {
      await waitFor(() => expect(requests).toHaveLength(modern ? 1 : 2));
      const target = streams[modern ? 0 : 1];
      if (modern) {
        target.write('event: station:general\ndata: null\n\n');
        target.write(
          'event: station:general\ndata: {"event":42,"data":"{}"}\n\n',
        );
        target.write(
          'event: station:general\ndata: {"event":"example:changed","data":"{\\"value\\":7}"}\n\n',
        );
      } else {
        target.write('event: example:changed\ndata: {"value":7}\n\n');
      }
      await waitFor(() => expect(handler).toHaveBeenCalledWith({ value: 7 }));
      expect(handler).toHaveBeenCalledTimes(1);
      hook.unmount();
      release();
      await waitFor(() =>
        expect(streams.every((stream) => stream.destroyed)).toBe(true),
      );
      const again = ensureOrchestrationEventStream(
        scope.base,
        undefined,
        'person',
      );
      await waitFor(() =>
        expect(requests.length).toBeGreaterThan(modern ? 1 : 2),
      );
      expect(requests[modern ? 1 : 2].cursor).toBe('17');
      again();
    } finally {
      hook.unmount();
      release();
      client.clear();
      for (const stream of streams) stream.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
