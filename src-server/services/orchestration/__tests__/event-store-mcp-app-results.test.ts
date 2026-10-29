import { join } from 'node:path';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();

test.each(['demo/chart', 'my__srv/chart'])(
  'retains %s result metadata and structured output through store reopen and transcript projection',
  (toolName) => {
    const path = join(makeTempDir('mcp-app-window-'), 'events.sqlite');
    const threadId = 'apps';
    const turnId = 'turn';
    const base = {
      provider: 'codex' as const,
      threadId,
      turnId,
      createdAt: '2026-10-17T12:00:00.000Z',
    };
    const result = {
      content: [{ type: 'text', text: 'Chart data' }],
      structuredContent: { count: 7 },
    };
    let store = new EventStore(path);
    store.setMcpAppResourceResolver((ref) =>
      ref === toolName ? 'ui://demo/chart' : undefined,
    );
    store.appendEvent({
      ...base,
      eventId: 'start',
      method: 'turn.started',
      prompt: 'Chart',
    });
    store.appendEvent({
      ...base,
      eventId: 'call',
      method: 'tool.started',
      itemId: 'chart-call',
      toolCallId: 'chart-call',
      toolName,
      arguments: { range: 'week' },
    });
    store.appendEvent({
      ...base,
      eventId: 'result',
      method: 'tool.completed',
      itemId: 'chart-call',
      toolCallId: 'chart-call',
      toolName,
      status: 'success',
      output: result,
    });
    const reference = {
      version: 1,
      sessionId: threadId,
      pageId: '00000000-0000-4000-8000-000000000001',
    };
    for (const [id, name] of [
      ['page', 'mcp__station-control__html_render'],
      ['ordinary', 'attacker/html_render'],
    ])
      store.appendEvent({
        ...base,
        eventId: id,
        method: 'tool.completed',
        itemId: id,
        toolCallId: id,
        toolName: name,
        status: 'success',
        output: {
          content: [
            { type: 'text', text: JSON.stringify({ htmlReply: reference }) },
          ],
        },
        mcpAppResourceUri: 'ui://forged/app',
      });
    store.close();
    store = new EventStore(path);
    try {
      const window = store.listEventWindowByTurn(threadId, { turnLimit: 1 });
      const completed = window.events.find((event) => event.id === 'result');
      expect(completed?.elided).toBeUndefined();
      expect(completed?.payload).toMatchObject({
        output: result,
        mcpAppResourceUri: 'ui://demo/chart',
      });
      const page = window.events.find((event) => event.id === 'page');
      expect(page?.payload).toMatchObject({ htmlReply: reference });
      expect(page?.payload).not.toHaveProperty('mcpAppResourceUri');
      const ordinary = window.events.find((event) => event.id === 'ordinary');
      expect(ordinary?.elided).toBe('output_limit');
      expect(ordinary?.payload).not.toHaveProperty('htmlReply');
      expect(ordinary?.payload).not.toHaveProperty('mcpAppResourceUri');
      const messages = projectRuntimeEventsToMessages(
        window.events.map((event) => event.payload),
      );
      expect(messages.flatMap((message) => message.parts)).toContainEqual(
        expect.objectContaining({
          toolCallId: 'chart-call',
          toolName,
          output: result,
        }),
      );
    } finally {
      store.close();
    }
  },
);

test('keeps the existing output limit for oversized MCP results and ordinary structured tools', () => {
  const store = new EventStore(
    join(makeTempDir('mcp-app-window-'), 'events.sqlite'),
  );
  const base = {
    provider: 'codex' as const,
    threadId: 'apps',
    turnId: 'turn',
    createdAt: '2026-10-17T12:00:00.000Z',
  };
  try {
    store.appendEvent({
      ...base,
      eventId: 'start',
      method: 'turn.started',
      prompt: 'Chart',
    });
    for (const [id, toolName, output] of [
      [
        'large',
        'demo/chart',
        { content: [{ type: 'text', text: 'x'.repeat(28_000) }] },
      ],
      [
        'ordinary',
        'read_file',
        { content: [{ type: 'text', text: 'x'.repeat(500) }] },
      ],
    ] as const) {
      store.appendEvent({
        ...base,
        eventId: id,
        method: 'tool.completed',
        itemId: id,
        toolCallId: id,
        toolName,
        status: 'success',
        output,
      });
    }
    const window = store.listEventWindowByTurn('apps', { turnLimit: 1 });
    for (const id of ['large', 'ordinary']) {
      const completed = window.events.find((event) => event.id === id);
      expect(completed?.elided).toBe('output_limit');
      expect(completed?.payload).toMatchObject({ output: expect.any(String) });
    }
  } finally {
    store.close();
  }
});

test.each(['ordinary', 'error', 'invalid-uri', 'ambiguous', 'forged'] as const)(
  'keeps %s MCP results as previews instead of expanding the history window',
  (kind) => {
    const store = new EventStore(
      join(makeTempDir('mcp-app-ordinary-window-'), 'events.sqlite'),
    );
    const base = {
      provider: 'codex' as const,
      threadId: 'ordinary',
      turnId: 'turn',
      createdAt: '2026-10-17T12:00:00.000Z',
    };
    try {
      store.appendEvent({
        ...base,
        eventId: 'start',
        method: 'turn.started',
        prompt: 'Read data',
      });
      for (let index = 0; index < 20; index++) {
        const output = {
          content: [{ type: 'text', text: 'x'.repeat(15_000) }],
          ...(kind === 'ordinary'
            ? {}
            : {
                _meta: {
                  ui: {
                    resourceUri:
                      kind !== 'invalid-uri'
                        ? 'ui://demo/chart'
                        : 'https://example.com/chart',
                  },
                },
              }),
          ...(kind === 'error' ? { isError: true } : {}),
        };
        store.appendEvent({
          ...base,
          eventId: `call-${index}`,
          method: 'tool.completed',
          itemId: `call-${index}`,
          toolCallId: `call-${index}`,
          toolName: kind === 'ambiguous' ? 'mcp__my__srv__chart' : 'demo/read',
          status: 'success',
          output,
          mcpAppResourceUri: 'ui://forged/retention',
        });
      }
      const window = store.listEventWindowByTurn('ordinary', { turnLimit: 1 });
      expect(window.events).toHaveLength(21);
      expect(window.hasMore).toBe(false);
      for (const event of window.events.filter(
        (event) => event.id !== 'start',
      )) {
        expect(event.elided).toBe('output_limit');
        expect(event.payload).toMatchObject({ output: expect.any(String) });
        expect(event.payload).not.toHaveProperty('mcpAppResourceUri');
      }
      expect(Buffer.byteLength(JSON.stringify(window))).toBeLessThan(16_000);
    } finally {
      store.close();
    }
  },
);

test('terminal replay keeps its original App stamp through disconnect, declaration change and store reopen', () => {
  const path = join(makeTempDir('mcp-app-replay-'), 'events.sqlite');
  let store = new EventStore(path);
  let uri: string | undefined = 'ui://demo/chart';
  store.setMcpAppResourceResolver(() => uri);
  const event = {
    provider: 'codex' as const,
    threadId: 'apps',
    turnId: 'turn',
    createdAt: '2026-10-17T12:00:00.000Z',
    eventId: 'terminal',
    method: 'tool.completed' as const,
    itemId: 'call',
    toolCallId: 'call',
    toolName: 'demo/chart',
    status: 'success' as const,
    output: { content: [{ type: 'text', text: 'Chart data' }] },
  };
  try {
    const sequence = store.appendEvent(event);
    expect(store.appendEvent(event)).toBe(sequence);
    uri = undefined;
    expect(store.appendEvent(event)).toBe(sequence);
    uri = 'ui://replacement/chart';
    expect(store.appendEvent(event)).toBe(sequence);
    store.close();
    store = new EventStore(path);
    expect(store.appendEvent(event)).toBe(sequence);
    expect(store.listEvents('apps')[0]?.payload).toMatchObject({
      mcpAppResourceUri: 'ui://demo/chart',
    });
    expect(() =>
      store.appendEvent({ ...event, output: { content: [] } }),
    ).toThrow('replay does not match');
  } finally {
    store.close();
  }
});
