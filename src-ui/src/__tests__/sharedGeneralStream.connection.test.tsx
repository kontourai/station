/** @vitest-environment jsdom */
import { createServer, type ServerResponse } from 'node:http';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, waitFor } from '@testing-library/react';
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

import { ClientBootstrapContext } from '../contexts/AuthorityPersistenceContext';
import { ServerEventsMount } from '../hooks/ServerEventsMount';
import { useServerEvents } from '../hooks/useServerEvents';
import { useServerEventsListener } from '../hooks/useServerEventsListener';

test('general events start without waiting for orchestration response headers', async () => {
  const requests: string[] = [];
  const streams: ServerResponse[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    streams.push(response);
    if (request.url === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: example:changed\ndata: {"value":7}\n\n');
    }
    // Deliberately hold orchestration headers: general delivery must not wait.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
  try {
    await waitFor(() => expect(handler).toHaveBeenCalledWith({ value: 7 }));
    expect(requests).toContain('/events');
    expect(requests).toContain('/api/orchestration/events');
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    hook.unmount();
    client.clear();
    for (const stream of streams) stream.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('waits for bootstrap then shares one real transport for both event families', async () => {
  const requests: string[] = [];
  const streams: ServerResponse[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    streams.push(response);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(
      'event: station:general\ndata: {"event":"example:changed","data":"{\\"value\\":7}"}\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  scope.base = `http://127.0.0.1:${address.port}`;
  const client = new QueryClient();
  const handler = vi.fn();
  let readiness: { status: 'pending' | 'settled'; sharedRealtime: boolean } = {
    status: 'pending',
    sharedRealtime: false,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ClientBootstrapContext.Provider value={readiness}>
        {children}
      </ClientBootstrapContext.Provider>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => useServerEvents({ 'example:changed': handler }),
    { wrapper },
  );
  try {
    expect(requests).toEqual([]);
    readiness = { status: 'settled', sharedRealtime: true };
    hook.rerender();
    await waitFor(() => expect(handler).toHaveBeenCalledWith({ value: 7 }));
    expect(requests).toEqual(['/api/orchestration/events?includeGeneral=1']);
  } finally {
    hook.unmount();
    client.clear();
    for (const stream of streams) stream.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('registers general delivery before a child starts the shared transport on bootstrap', async () => {
  const requests: string[] = [];
  const streams: ServerResponse[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    streams.push(response);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(
      'event: station:general\ndata: {"event":"example:changed","data":"{\\"value\\":7}"}\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  scope.base = `http://127.0.0.1:${address.port}`;
  const client = new QueryClient();
  const handler = vi.fn();
  function Parent() {
    useServerEventsListener({ 'example:changed': handler });
    return <ServerEventsMount />;
  }
  const tree = (status: 'pending' | 'settled') => (
    <QueryClientProvider client={client}>
      <ClientBootstrapContext.Provider value={{ status, sharedRealtime: true }}>
        <Parent />
      </ClientBootstrapContext.Provider>
    </QueryClientProvider>
  );
  const mounted = render(tree('pending'));
  try {
    expect(requests).toEqual([]);
    mounted.rerender(tree('settled'));
    await waitFor(() => expect(handler).toHaveBeenCalledWith({ value: 7 }));
    expect(requests).toEqual(['/api/orchestration/events?includeGeneral=1']);
  } finally {
    mounted.unmount();
    client.clear();
    for (const stream of streams) stream.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
