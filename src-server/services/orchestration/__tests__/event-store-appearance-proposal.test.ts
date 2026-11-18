import { join } from 'node:path';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();

test('exact appearance proposal identity survives excerpt and spill through the durable transcript', () => {
  const store = new EventStore(
    join(makeTempDir('appearance-history-'), 'events.sqlite'),
  );
  const base = {
    provider: 'codex' as const,
    threadId: 'appearance-session',
    turnId: 'turn',
    createdAt: '2026-11-17T00:00:00.000Z',
  };
  const proposalId = 'a'.repeat(64);
  try {
    store.appendEvent({
      ...base,
      eventId: 'start',
      method: 'turn.started',
      prompt: 'Make Station warmer',
    });
    for (const [id, css, sourceSessionId, toolName] of [
      [
        'excerpt',
        ' '.repeat(500),
        base.threadId,
        'mcp__station-control__propose_appearance',
      ],
      [
        'spilled',
        ' '.repeat(40_000),
        base.threadId,
        'station-control/propose_appearance',
      ],
      [
        'other-session',
        '',
        'someone-else',
        'station-control/propose_appearance',
      ],
      ['other-tool', '', base.threadId, 'station-control/get_appearance'],
    ] as const) {
      store.appendEvent({
        ...base,
        eventId: `${id}-start`,
        method: 'tool.started',
        itemId: id,
        toolCallId: id,
        toolName,
        arguments: {},
      });
      const envelope = {
        success: true,
        state: 'proposed',
        data: {
          proposal: {
            id: proposalId,
            proposedAt: base.createdAt,
            sourceSessionId,
            appearance: { version: 1, name: 'Warm paper', palette: {}, css },
          },
        },
      };
      store.appendEvent({
        ...base,
        eventId: id,
        method: 'tool.completed',
        itemId: id,
        toolCallId: id,
        toolName,
        status: 'success',
        output: JSON.stringify(envelope),
      });
    }
    const window = store.listEventWindowByTurn(base.threadId, { turnLimit: 1 });
    expect(window.events.find((event) => event.id === 'excerpt')?.elided).toBe(
      'output_limit',
    );
    expect(
      window.events.find((event) => event.id === 'spilled')?.payload
        .spilledContent,
    ).toBeDefined();
    const parts = projectRuntimeEventsToMessages(
      window.events.map((event) => event.payload),
    ).flatMap((message) => message.parts);
    for (const id of ['excerpt', 'spilled']) {
      expect(
        parts.find((part) => part.toolCallId === id)?.appearanceProposal,
      ).toEqual({
        id: proposalId,
        name: 'Warm paper',
        sourceSessionId: base.threadId,
      });
    }
    for (const id of ['other-session', 'other-tool']) {
      expect(parts.find((part) => part.toolCallId === id)).toBeDefined();
      expect(
        parts.find((part) => part.toolCallId === id)?.appearanceProposal,
      ).toBeUndefined();
    }
  } finally {
    store.close();
  }
});
