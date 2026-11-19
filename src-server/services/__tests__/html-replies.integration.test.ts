import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { htmlReplyReference } from '@kontourai/station-shared/html-reply-document';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { createGateTestRegistry } from '../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FakeAcpProcess } from '../../providers/__tests__/fake-acp-process.js';
import { AcpAdapter } from '../../providers/adapters/acp-adapter.js';
import { createHtmlReplyRoutes } from '../../routes/orchestration/html-replies.js';
import { createSelectedStationControlMcpServer } from '../../tools/station-control-mcp-server.js';
import type { ACPProcess } from '../acp/acp-process.js';
import { EventBus } from '../orchestration/event-bus.js';
import { EventStore } from '../orchestration/event-store.js';
import { OrchestrationService } from '../orchestration/orchestration-service.js';

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

test('the ACP render route records the page with its transcript event before any engine result', async () => {
  const cwd = makeTempDir('html-acp-publish-');
  const dbPath = join(cwd, 'events.sqlite');
  const store = new EventStore(dbPath);
  const db = new DatabaseSync(dbPath);
  const eventBus = new EventBus();
  const adapter = new AcpAdapter({
    getConnections: async () => [
      {
        id: 'fixture-acp',
        command: 'fixture-acp',
        args: ['acp', '--process-per-session'],
        name: 'Fixture ACP',
        enabled: true,
      },
    ],
    processFactory: (options) =>
      new FakeAcpProcess(options) as unknown as ACPProcess,
  });
  // The engine is scripted. Local installation and login are separate from publication.
  vi.spyOn(adapter, 'getPrerequisites').mockResolvedValue([]);
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
    resolveSessionAgent: async (input) => ({
      ...input,
      agent: { slug: 'fixture-acp' },
    }),
  });
  const threadId = 'agy:visual';
  const app = createHtmlReplyRoutes({
    pages: store.htmlReplyPages(),
    capturePublisher: (id) => service.captureAcpHtmlReplyPublisher(id),
    isInternalRequest: () => true,
    resolveCaller: () => ({
      sessionId: threadId,
      assurance: 'delegated-custody',
    }),
    sessionContext: () => ({ cwd, conversationId: threadId }),
    canReadSession: (id) => id === threadId,
    preview: async () => {
      throw new Error('Not requested');
    },
  });
  const publish = () =>
    app.request('/render', {
      method: 'POST',
      body: JSON.stringify({ html: `<p>${'x'.repeat(8874)}</p>`, height: 450 }),
    });
  try {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider: 'acp',
        cwd,
        metadata: { connectionId: 'fixture-acp', agentSlug: 'fixture-acp' },
      },
    });
    expect((await publish()).status).toBe(409);
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'Publish a page' },
    });
    await vi.waitFor(() =>
      expect(service.stationControlCallingTurn(threadId).kind).toBe('turn'),
    );
    const received: string[] = [];
    const unsub = eventBus.subscribe(({ data }) => {
      const event = data?.event;
      if (
        event &&
        typeof event === 'object' &&
        'method' in event &&
        event.method === 'tool.completed' &&
        'eventId' in event &&
        typeof event.eventId === 'string'
      )
        received.push(event.eventId);
    });
    try {
      db.exec(
        "CREATE TRIGGER reject_html_event BEFORE INSERT ON orchestration_events WHEN NEW.method = 'tool.completed' BEGIN SELECT RAISE(ABORT, 'injected visual reply event failure'); END",
      );
      expect((await publish()).status).toBe(400);
      expect(
        db
          .prepare('SELECT COUNT(*) AS n FROM orchestration_html_reply_pages')
          .get(),
      ).toEqual({ n: 0 });
      expect(received).toEqual([]);
      db.exec('DROP TRIGGER reject_html_event');
      const rendered = await publish();
      expect(rendered.status).toBe(200);
      const htmlReply = htmlReplyReference(await rendered.json());
      if (!htmlReply) throw new Error('No publication reference was returned');
      const retry = await publish();
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ success: true, htmlReply });
      expect(received).toEqual([htmlReply.pageId]);
      store.appendEvent({
        eventId: 'provider-echo',
        provider: 'acp',
        method: 'tool.completed',
        threadId,
        itemId: 'render',
        toolCallId: 'render',
        toolName: 'mcp_station-control_html_render',
        status: 'success',
        output: { success: true, htmlReply },
        createdAt: new Date().toISOString(),
      });
      const events = store.listEventWindowByTurn(threadId, {
        turnLimit: 1,
      }).events;
      expect(
        events.flatMap(({ payload }) =>
          payload.method === 'tool.completed' && payload.htmlReply
            ? [payload.htmlReply]
            : [],
        ),
      ).toEqual([htmlReply]);
      expect(store.htmlReplyPages().read(htmlReply)).toMatchObject({
        height: 450,
      });
    } finally {
      unsub();
    }
  } finally {
    await service.shutdown();
    db.close();
    store.close();
  }
});
