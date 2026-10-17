import { join } from 'node:path';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();

test.each(['demo/chart', 'mcp__demo__chart'])(
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
      _meta: { ui: { resourceUri: 'ui://demo/chart' } },
    };
    let store = new EventStore(path);
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
    store.close();
    store = new EventStore(path);
    try {
      const window = store.listEventWindowByTurn(threadId, { turnLimit: 1 });
      const completed = window.events.find((event) => event.id === 'result');
      expect(completed?.elided).toBeUndefined();
      expect(completed?.payload).toMatchObject({ output: result });
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
