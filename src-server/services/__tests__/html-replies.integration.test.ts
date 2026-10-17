import { join } from 'node:path';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createHtmlReplyRoutes } from '../../routes/orchestration/html-replies.js';
import { createSelectedStationControlMcpServer } from '../../tools/station-control-mcp-server.js';
import { EventStore } from '../orchestration/event-store.js';

const makeTempDir = trackTempDirs();
test('MCP html_render publishes into the EventStore, reopens with its transcript reference, and deletes with its session', async () => {
  const root = makeTempDir('html-mcp-persistence-');
  const file = join(root, 'events.sqlite');
  let store = new EventStore(file);
  store.upsertSession({
    provider: 'codex',
    threadId: 'publisher',
    cwd: root,
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const app = new Hono().route(
    '/api/html-replies',
    createHtmlReplyRoutes({
      pages: store.htmlReplyPages(),
      isInternalRequest: () => true,
      resolveCaller: () => ({ sessionId: 'publisher', assurance: 'bound' }),
      sessionContext: () => ({ cwd: root, conversationId: 'publisher' }),
      canReadSession: (id) => id === 'publisher',
      preview: async () => {
        throw new Error('Not requested');
      },
    }),
  );
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
    app.request(input instanceof Request ? input : new Request(input, init)),
  );
  vi.stubEnv('STATION_API_BASE', 'http://html-mcp.test');
  const server = createSelectedStationControlMcpServer([
    'html_render',
    'html_preview',
  ]);
  const client = new Client({ name: 'html-reply-test', version: '1.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['html_render', 'html_preview']),
    );
    const result = await client.callTool({
      name: 'html_render',
      arguments: { html: '<h1>MCP retained page</h1>', height: 400 },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content.find((part) => part.type === 'text');
    if (content?.type !== 'text') throw new Error('No reference was returned');
    const { htmlReply: reference } = JSON.parse(content.text);
    expect(content.text).not.toContain('<h1>');
    store.appendEvent({
      eventId: 'turn-start',
      provider: 'codex',
      threadId: 'publisher',
      method: 'turn.started',
      turnId: 'turn',
      prompt: 'Publish the page',
      createdAt: new Date().toISOString(),
    });
    store.appendEvent({
      eventId: 'published',
      provider: 'codex',
      threadId: 'publisher',
      method: 'tool.completed',
      turnId: 'turn',
      itemId: 'item',
      toolCallId: 'call',
      toolName: 'station-control/html_render',
      status: 'success',
      output: result,
      createdAt: new Date().toISOString(),
    });
    store.close();
    store = new EventStore(file);
    expect(store.htmlReplyPages().read(reference)?.html).toBe(
      '<h1>MCP retained page</h1>',
    );
    const messages = projectRuntimeEventsToMessages(
      store
        .listEventWindowByTurn('publisher', { turnLimit: 1 })
        .events.map((row) => row.payload),
      { stableIds: true },
    );
    expect(JSON.stringify(messages)).toContain(reference.pageId);
    const completed = store
      .listEventWindowByTurn('publisher', { turnLimit: 1 })
      .events.find((row) => row.method === 'tool.completed');
    if (completed?.payload.method !== 'tool.completed')
      throw new Error('Missing bounded tool result');
    expect(completed.payload.htmlReply).toEqual(reference);
    expect(String(completed.payload.output).length).toBeLessThanOrEqual(84);
    store.deleteThread('publisher');
    expect(store.htmlReplyPages().read(reference)).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
    store.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
