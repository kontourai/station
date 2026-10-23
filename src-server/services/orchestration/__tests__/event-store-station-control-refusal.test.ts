/**
 * A station-control refusal survives a history read. The window cuts every
 * tool's output and error to a short excerpt (which no longer parses as the
 * refusal's JSON), so Station keeps the refusal's code and sentence whole on
 * the event it serves, read from the full text before the cut. Driven
 * through a real EventStore window read and the real transcript projection.
 */
import { join } from 'node:path';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();

const SENTENCE =
  'This action needs a credential that stayed inside Station. Ask the person to do it in Station.';
const ENVELOPE = JSON.stringify(
  {
    success: false,
    code: 'station_control_assurance_insufficient',
    error: SENTENCE,
  },
  null,
  2,
);

test('a refusal in the error text, and one in an MCP result, keep their code and sentence whole', () => {
  const store = new EventStore(
    join(makeTempDir('refusal-window-'), 'events.sqlite'),
  );
  const base = {
    provider: 'claude' as const,
    threadId: 'refused',
    turnId: 'turn',
    createdAt: '2026-10-20T12:00:00.000Z',
  };
  try {
    store.appendEvent({
      ...base,
      eventId: 'start',
      method: 'turn.started',
      prompt: 'Add a job',
    });
    for (const [id, toolName, field, value] of [
      ['in-error', 'mcp__station-control__add_job', 'error', ENVELOPE],
      [
        'in-output',
        'station-control_add_job',
        'output',
        { content: [{ type: 'text', text: ENVELOPE }] },
      ],
      // The same envelope from any other tool is just its output.
      ['other-tool', 'mcp__other__add_job', 'error', ENVELOPE],
    ] as const) {
      store.appendEvent({
        ...base,
        eventId: `${id}-call`,
        method: 'tool.started',
        itemId: id,
        toolCallId: id,
        toolName,
        arguments: {},
      });
      store.appendEvent({
        ...base,
        eventId: id,
        method: 'tool.completed',
        itemId: id,
        toolCallId: id,
        toolName,
        status: 'error',
        [field]: value,
      });
    }
    const window = store.listEventWindowByTurn(base.threadId, {
      turnLimit: 1,
    });
    const served = (id: string) =>
      window.events.find((event) => event.id === id);
    // The excerpt really is cut, and no longer the envelope.
    expect(served('in-error')?.elided).toBe('output_limit');
    const excerpt = (served('in-error')!.payload as { error?: string }).error;
    expect(excerpt?.length).toBeLessThan(ENVELOPE.length);
    const parts = projectRuntimeEventsToMessages(
      window.events.map((event) => event.payload),
    ).flatMap((message) => message.parts);
    const part = (id: string) => parts.find((p) => p.toolCallId === id);
    const refusal = {
      code: 'station_control_assurance_insufficient',
      message: SENTENCE,
    };
    expect(part('in-error')?.stationControlRefusal).toEqual(refusal);
    expect(part('in-output')?.stationControlRefusal).toEqual(refusal);
    expect(part('other-tool')?.stationControlRefusal).toBeUndefined();
  } finally {
    store.close();
  }
});

test('a sentence over its bound is not kept (never cut)', () => {
  const store = new EventStore(
    join(makeTempDir('refusal-window-'), 'events.sqlite'),
  );
  const base = {
    provider: 'claude' as const,
    threadId: 'long',
    turnId: 'turn',
    createdAt: '2026-10-20T12:00:00.000Z',
  };
  try {
    store.appendEvent({
      ...base,
      eventId: 'start',
      method: 'turn.started',
      prompt: 'x',
    });
    store.appendEvent({
      ...base,
      eventId: 'done',
      method: 'tool.completed',
      itemId: 'c',
      toolCallId: 'c',
      toolName: 'mcp__station-control__add_job',
      status: 'error',
      error: JSON.stringify({
        success: false,
        code: 'station_control_role_required',
        error: 'x'.repeat(2001),
      }),
    });
    const window = store.listEventWindowByTurn(base.threadId, {
      turnLimit: 1,
    });
    expect(
      window.events.find((e) => e.id === 'done')?.payload,
    ).not.toHaveProperty('stationControlRefusal');
  } finally {
    store.close();
  }
});
