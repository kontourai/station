// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { activeChatsStore } from '../../../../contexts/active-chats-store';
import {
  closeActiveReplay,
  getActiveReplay,
  openReplayFromTape,
} from '../controller';
import { EMPTY_REPLAY_HISTORY } from '../history';
import { MAX_TAPE_BYTES, MAX_TAPE_FRAMES } from '../limits';
import {
  recordReplayRuntime,
  startReplayCapture,
  stopReplayCapture,
} from '../recorder';
import { isSessionTape, tapeFromSessionEvents } from '../tape';
import { readSessionTapeFile, serializeSessionTape } from '../tape-file';

const event = {
  method: 'turn.started' as const,
  provider: 'codex' as const,
  threadId: 'source',
  turnId: 'turn',
  eventId: 'start',
  createdAt: '2026-09-12T00:00:00Z',
  prompt: 'Private question',
};
const tape = () =>
  tapeFromSessionEvents({ threadId: 'source', agentSlug: 'codex' }, [event]);
const file = (value: unknown) => {
  const data = JSON.stringify(value);
  return {
    size: new TextEncoder().encode(data).length,
    text: async () => data,
  };
};
afterEach(() => {
  stopReplayCapture();
  closeActiveReplay();
  activeChatsStore.removeChat('source');
});

test('rejects malformed nested history, snapshot and chat data before opening', async () => {
  for (const value of [
    { ...tape(), initialHistory: { events: [] } },
    {
      ...tape(),
      initialChat: { messages: [{ role: 'assistant', content: {} }] },
    },
    {
      ...tape(),
      frames: [
        {
          kind: 'snapshot',
          atMs: 0,
          reconnect: true,
          payload: { sessions: [null] },
        },
      ],
    },
    {
      ...tape(),
      frames: [
        {
          kind: 'history',
          atMs: 0,
          state: { ...EMPTY_REPLAY_HISTORY, handoffs: null },
        },
      ],
    },
    {
      ...tape(),
      frames: [
        {
          kind: 'runtime',
          atMs: 0,
          event: { ...event, method: 'content.text-delta', delta: {} },
        },
      ],
    },
    {
      ...tape(),
      frames: [
        { kind: 'clock', atMs: 2 },
        { kind: 'clock', atMs: 1 },
      ],
    },
  ])
    await expect(readSessionTapeFile(file(value))).rejects.toThrow();
});

test('an invalid import cannot replace a working replay', () => {
  const current = openReplayFromTape(tape(), {
    agentSlug: 'codex',
    agentName: 'Codex',
  });
  expect(() =>
    openReplayFromTape(
      { ...tape(), initialChat: { messages: 'bad' } } as never,
      { agentSlug: 'codex', agentName: 'Codex' },
    ),
  ).toThrow('unsupported replay data');
  expect(getActiveReplay()?.replayId).toBe(current.replayId);
});

test('rejects oversized and deeply nested inputs without reflecting private invalid JSON', async () => {
  await expect(
    readSessionTapeFile({ size: MAX_TAPE_BYTES + 1, text: async () => '' }),
  ).rejects.toThrow('16 MiB');
  await expect(
    readSessionTapeFile({ size: 1, text: async () => 'PRIVATE_INVALID_JSON' }),
  ).rejects.toThrow('The recording is not valid JSON.');
  let nested: unknown = 'leaf';
  for (let i = 0; i < 70; i++) nested = { child: nested };
  expect(isSessionTape({ ...tape(), extra: nested })).toBe(false);
  expect(
    isSessionTape({
      ...tape(),
      events: Array(MAX_TAPE_FRAMES + 1).fill(event),
    }),
  ).toBe(false);
});

test('redaction removes payload keys and numeric secrets while preserving distinct semantic ids', async () => {
  const recorded = tape();
  recorded.events.push({
    ...event,
    eventId: 'tool',
    method: 'tool.completed',
    toolCallId: 'call',
    itemId: 'tool-item',
    toolName: 'inspect',
    status: 'success',
    output: {
      'private-customer@example.test': 123456789,
      nested: { method: 'private-secret' },
    },
  });
  recorded.initialChat = {
    messages: [
      { role: 'user', clientId: 'one', content: 'first' },
      { role: 'user', clientId: 'two', content: 'second' },
    ],
  };
  const encoded = serializeSessionTape(recorded);
  expect(encoded).not.toContain('private-customer');
  expect(encoded).not.toContain('123456789');
  expect(encoded).not.toContain('private-secret');
  const parsed = await readSessionTapeFile({
    size: encoded.length,
    text: async () => encoded,
  });
  expect(parsed.initialChat?.messages?.[0].clientId).not.toBe(
    parsed.initialChat?.messages?.[1].clientId,
  );
  expect(serializeSessionTape(recorded, true)).toContain('private-customer');
});

test('the capture limit leaves room for its completion explanation and remains importable', async () => {
  startReplayCapture('host', { threadId: 'source', agentSlug: 'codex' });
  for (let i = 0; i < MAX_TAPE_FRAMES + 1; i++)
    recordReplayRuntime('host', { ...event, eventId: `event-${i}` });
  const captured = stopReplayCapture()!;
  expect(captured.frames).toHaveLength(MAX_TAPE_FRAMES);
  expect(captured.stoppedReason).toContain('limit');
  const encoded = serializeSessionTape(captured, true);
  expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(
    MAX_TAPE_BYTES,
  );
  const parsed = await readSessionTapeFile({
    size: encoded.length,
    text: async () => encoded,
  });
  const replay = openReplayFromTape(parsed, {
    agentSlug: 'codex',
    agentName: 'Codex',
  });
  expect(replay.player.observe().issues.map((issue) => issue.code)).toContain(
    'incomplete-capture',
  );
});

test('byte-limited capture remains within the import ceiling including its final explanation', async () => {
  startReplayCapture('host', { threadId: 'source', agentSlug: 'codex' });
  const prompt = 'x'.repeat(60_000);
  for (let i = 0; i < 300; i++)
    recordReplayRuntime('host', { ...event, eventId: `large-${i}`, prompt });
  const captured = stopReplayCapture()!;
  expect(captured.stoppedReason).toContain('limit');
  expect(captured.frames!.length).toBeLessThan(300);
  const encoded = serializeSessionTape(captured, true);
  expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(
    MAX_TAPE_BYTES,
  );
  await expect(
    readSessionTapeFile({ size: encoded.length, text: async () => encoded }),
  ).resolves.toMatchObject({ stoppedReason: captured.stoppedReason });
});

test('imports a Flow run whose gates have never been evaluated', async () => {
  const recorded = tape();
  recorded.initialChat = {
    messages: [
      {
        role: 'assistant',
        content: '',
        contentParts: [
          {
            type: 'flow-run-attached',
            flowRunAttached: {
              runId: 'run',
              definitionId: 'definition',
              resumed: false,
              freshness: {
                lastEvaluatedAt: null,
                gateOutcomeCount: 0,
                evidenceCount: 0,
              },
            },
          },
        ],
      },
    ],
  };
  await expect(readSessionTapeFile(file(recorded))).resolves.toBeDefined();
});
