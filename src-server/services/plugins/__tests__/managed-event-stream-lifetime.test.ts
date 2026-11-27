import {
  type MCPConnection,
  prepareMCPConnection,
  setRemoteTransportFetchPolicy,
} from '@kontourai/station-shared/mcp';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { MCPService } from '../mcp-service.js';

const makeTemp = trackTempDirs();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test('a pooled event stream retains admission until its source cancellation settles', async () => {
  const cancellationStarted = deferred();
  const releaseCancellation = deferred();
  const firstFrame = deferred();
  const secondSource = deferred();
  let streams = 0;
  const definition = {
    id: 'events-fixture',
    kind: 'mcp' as const,
    transport: 'streamable-http' as const,
    endpoint: 'https://events.example.test/mcp',
  };
  const handler = createMcpHandler(
    () =>
      new McpServer(
        { name: 'events-fixture', version: '1.0.0' },
        {
          capabilities: {
            extensions: { 'io.modelcontextprotocol/events': {} },
          },
        },
      ),
    { legacy: 'reject' },
  );
  const previousFetch = setRemoteTransportFetchPolicy(
    () => async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (request.headers.get('mcp-method') !== 'events/stream')
        return handler.fetch(request);
      streams += 1;
      if (streams === 2) secondSource.resolve();
      const { id } = z.object({ id: z.number() }).parse(await request.json());
      const frame = new TextEncoder().encode(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/events/active',
          params: {
            cursor: 'cursor',
            heartbeatMs: 5000,
            truncated: false,
            _meta: { 'io.modelcontextprotocol/subscriptionId': id },
          },
        })}\n\n`,
      );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame);
        },
        cancel() {
          cancellationStarted.resolve();
          return releaseCancellation.promise;
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  );

  const prepared = prepareMCPConnection(definition);
  const controller = new AbortController();
  const nextController = new AbortController();
  let reading: Promise<void> | undefined;
  let attemptedWhileClosing: Promise<void> | undefined;
  let nextRead: Promise<void> | undefined;
  try {
    const active = new Map<string, MCPConnection>();
    const service = new MCPService(
      new ConfigLoader({ projectHomeDir: makeTemp('event-stream-owner-') }),
      active,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { warn: vi.fn() },
    );
    await service.saveIntegration(definition);
    active.set(definition.id, await prepared.connect());
    const input = { name: 'work.settled', cursor: null };
    reading = service.readMCPEventStream(
      definition.id,
      input,
      async () => firstFrame.resolve(),
      controller.signal,
    );
    void reading.catch(() => {});
    await firstFrame.promise;
    controller.abort();
    await cancellationStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    attemptedWhileClosing = service.readMCPEventStream(
      definition.id,
      input,
      async () => {},
      nextController.signal,
    );
    const refusal = await Promise.race([
      attemptedWhileClosing.then(
        () => null,
        (error: unknown) => error,
      ),
      secondSource.promise.then(() => null),
    ]);
    expect(refusal).toMatchObject({
      message: 'There are too many open event streams.',
    });
    expect(streams).toBe(1);

    releaseCancellation.resolve();
    await expect(reading).rejects.toThrow();
    const nextFrame = deferred();
    nextRead = service.readMCPEventStream(
      definition.id,
      input,
      async () => nextFrame.resolve(),
      nextController.signal,
    );
    void nextRead.catch(() => {});
    await nextFrame.promise;
    expect(streams).toBe(2);
    nextController.abort();
    await expect(nextRead).rejects.toThrow();
  } finally {
    releaseCancellation.resolve();
    controller.abort();
    nextController.abort();
    await Promise.allSettled([reading, attemptedWhileClosing, nextRead]);
    await prepared.close();
    setRemoteTransportFetchPolicy(previousFetch);
  }
});
