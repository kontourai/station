import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { CHAT_INPUT_MAX_CHARS } from '../../../../src-shared/chat-input-limits.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { CodexRolloutSessionSource } from '../../../providers/sessions/codex-rollout-session-source.js';
import { EventStore } from '../event-store.js';
import { createSessionInventoryModule } from '../session-inventory-module.js';

const tempRoot = trackTempDirs();

function envelope(type: string, payload: Record<string, unknown>) {
  return { timestamp: '2026-10-24T16:00:01.000Z', type, payload };
}

/**
 * A Codex rollout in which the middle turn carries no user message (Codex
 * opens such turns itself, e.g. to continue after a tool or compaction). The
 * importer records that turn's start with neither prompt nor attachments.
 */
function writeRollout(home: string) {
  const directory = join(home, 'sessions', '2026', '10', '24');
  mkdirSync(directory, { recursive: true });
  const lines = [
    {
      timestamp: '2026-10-24T16:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'native-session',
        session_id: 'native-session',
        cwd: '/workspace',
        source: 'cli',
      },
    },
    envelope('event_msg', { type: 'task_started', turn_id: 't1' }),
    envelope('event_msg', { type: 'user_message', message: 'question' }),
    envelope('event_msg', { type: 'task_complete', turn_id: 't1' }),
    envelope('event_msg', { type: 'task_started', turn_id: 't2' }),
    envelope('event_msg', { type: 'task_complete', turn_id: 't2' }),
    envelope('event_msg', { type: 'task_started', turn_id: 't3' }),
    envelope('event_msg', { type: 'user_message', message: 'again' }),
    envelope('event_msg', { type: 'task_complete', turn_id: 't3' }),
  ];
  writeFileSync(
    join(directory, 'rollout-a.jsonl'),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  );
}

async function importRollout(store: EventStore) {
  const home = tempRoot('station-inventory-rollout-');
  writeRollout(home);
  const source = new CodexRolloutSessionSource({ homeDir: home });
  const [session] = (await source.discover()).sessions;
  if (!session) throw new Error('rollout fixture was not discovered');
  let cursor: Parameters<typeof source.read>[1] = 0;
  const events = [];
  for (let page = 0; page < 16; page += 1) {
    const result = await source.read(session, cursor);
    events.push(...result.events);
    if (JSON.stringify(result.cursor) === JSON.stringify(cursor)) break;
    cursor = result.cursor;
  }
  for (const event of events) store.appendEvent(event);
  return { threadId: session.threadId, events };
}

async function listInputs(store: EventStore, threadId: string) {
  const module = createSessionInventoryModule({
    sessionOutputs: {
      list: vi.fn().mockResolvedValue({
        status: 'found',
        page: { version: 'session-outputs/v1', items: [], partial: false },
      }),
    } as never,
    canReadSession: () => true,
    readWholeSessionEvents: (
      sessionId,
      frozenHighWater,
      continuation,
      group,
      limit,
    ) =>
      store.listSessionInventoryEvents(sessionId, {
        frozenHighWater,
        continuation,
        group,
        limit,
      }),
  });
  const result = await module.read({
    scope: { kind: 'whole-session', sessionId: threadId },
    authority: sessionReadAuthorityFromRequest('owner', undefined, undefined),
    current: () => true,
  });
  if (result.status !== 'found') throw new Error('expected projection');
  return (
    result.projection.groups.find((group) => group.id === 'inputs')?.items ?? []
  ).map((item) => {
    if (item.kind !== 'thread-authored-input')
      throw new Error(`unexpected ${item.kind}`);
    return item;
  });
}

describe('Session inventory authored inputs', () => {
  test('lists only inputs the exact input read can serve, for an imported Codex rollout', async () => {
    const store = new EventStore(
      join(tempRoot('station-inventory-store-'), 'orchestration.sqlite'),
    );
    try {
      const { threadId, events } = await importRollout(store);
      // The case is reached: the real importer wrote a prompt-less start.
      const starts = events.filter((event) => event.method === 'turn.started');
      expect(
        starts.map((event) => ({
          turnId: event.turnId,
          prompt: 'prompt' in event ? event.prompt : undefined,
        })),
      ).toEqual([
        { turnId: 't1', prompt: 'question' },
        { turnId: 't2', prompt: undefined },
        { turnId: 't3', prompt: 'again' },
      ]);

      const inputs = await listInputs(store, threadId);

      expect(inputs.map((item) => item.turnId)).toEqual(['t1', 't3']);
      // The invariant the drill-down relies on: every listed input is one
      // the exact read serves, at the turn the listing named.
      for (const item of inputs) {
        const descriptor = store.userInputEventById(item.eventId);
        expect(descriptor).toMatchObject({
          eventId: item.eventId,
          threadId,
          turnId: item.turnId,
        });
      }
    } finally {
      store.close?.();
    }
  });
  test('lists no input for a whitespace-only prompt, which the exact read also refuses', async () => {
    const store = new EventStore(
      join(tempRoot('station-inventory-store-'), 'orchestration.sqlite'),
    );
    try {
      const threadId = 'station:1:session:whitespace';
      // Station's own chat writer records the typed prompt and an attachment
      // array. SQLite's trim() keeps "\n" and "\t", so only a shared rule
      // keeps the listing and the read in step on these.
      const prompts = ['\n', '\n\t ', ' ', 'Continue'];
      prompts.forEach((prompt, index) =>
        store.appendEvent({
          provider: 'codex',
          threadId,
          createdAt: `2026-10-24T16:00:0${index}.000Z`,
          eventId: `ws-${index}`,
          turnId: `ws-turn-${index}`,
          method: 'turn.started',
          prompt,
          attachments: [],
        } as never),
      );
      const inputs = await listInputs(store, threadId);
      expect(inputs.map((item) => item.eventId)).toEqual(['ws-3']);
      for (const index of [0, 1, 2])
        expect(() => store.userInputEventById(`ws-${index}`)).toThrow();
      expect(store.userInputEventById('ws-3')).toMatchObject({
        prompt: 'Continue',
      });
    } finally {
      store.close?.();
    }
  });

  test('lists no prompt over the chat limit, which the exact read refuses; one at the limit is listed and read', async () => {
    const path = join(
      tempRoot('station-inventory-store-'),
      'orchestration.sqlite',
    );
    const store = new EventStore(path);
    try {
      const threadId = 'station:1:session:oversized';
      const lengths = [CHAT_INPUT_MAX_CHARS + 1, CHAT_INPUT_MAX_CHARS];
      lengths.forEach((_length, index) =>
        store.appendEvent({
          provider: 'codex',
          threadId,
          createdAt: `2026-10-24T16:00:0${index}.000Z`,
          eventId: `long-${index}`,
          turnId: `long-turn-${index}`,
          method: 'turn.started',
          prompt: 'placeholder',
          attachments: [],
        } as never),
      );
      // Today's routes refuse a longer prompt, ingress refuses a payload over
      // 64 KB, and importers keep 32 KB, so an over-limit prompt exists only
      // in a row written before those bounds. Make these two rows that: the
      // writer's payload, with only the prompt grown.
      const legacy = new DatabaseSync(path);
      try {
        const grow = legacy.prepare(
          `UPDATE orchestration_events
              SET payload = json_set(payload, '$.prompt', ?)
            WHERE id = ?`,
        );
        lengths.forEach((length, index) =>
          grow.run('x'.repeat(length), `long-${index}`),
        );
      } finally {
        legacy.close();
      }
      const inputs = await listInputs(store, threadId);
      expect(inputs.map((item) => item.eventId)).toEqual(['long-1']);
      expect(store.userInputEventById('long-1')?.prompt).toHaveLength(
        CHAT_INPUT_MAX_CHARS,
      );
      expect(() => store.userInputEventById('long-0')).toThrow(
        'Invalid user-input event descriptor',
      );
    } finally {
      store.close?.();
    }
  });

  test('lists no input whose attachment descriptor the exact read refuses, and still lists well-formed ones', async () => {
    const store = new EventStore(
      join(tempRoot('station-inventory-store-'), 'orchestration.sqlite'),
    );
    try {
      const threadId = 'station:1:session:attachments';
      const good = {
        kind: 'image',
        name: 'screen.png',
        mimeType: 'image/png',
        size: 1200,
        blobRef: `sha256-${'a'.repeat(64)}`,
      };
      // Shapes an older writer or an import left in real stores: an
      // unsupported type, a kind that disagrees with its type, an empty
      // size, an unsafe name, a missing field, and a non-object entry.
      const malformed = [
        { ...good, mimeType: 'application/x-unknown' },
        { ...good, kind: 'file' },
        { ...good, size: 0 },
        { ...good, name: '../escape.png' },
        { kind: 'image', name: 'screen.png', mimeType: 'image/png' },
        'screen.png',
      ];
      const starts: Array<{ id: string; attachments: unknown[] }> = [
        { id: 'att-good', attachments: [good] },
        ...malformed.map((attachment, index) => ({
          id: `att-bad-${index}`,
          attachments: [good, attachment],
        })),
      ];
      starts.forEach(({ id, attachments }, index) =>
        store.appendEvent({
          provider: 'codex',
          threadId,
          createdAt: `2026-10-24T16:00:${String(index).padStart(2, '0')}.000Z`,
          eventId: id,
          turnId: `${id}-turn`,
          method: 'turn.started',
          prompt: 'See attached',
          attachments,
        } as never),
      );
      // The store's listing over every row (the module's first page holds
      // only two), then the projection a client receives.
      const listed = store.listSessionInventoryEvents(threadId, {
        group: 'inputs',
      });
      expect(listed.continuation).toBeUndefined();
      expect(listed.events.map((event) => event.id)).toEqual(['att-good']);
      const inputs = await listInputs(store, threadId);
      expect(inputs.map((item) => item.eventId)).toEqual(['att-good']);
      expect(inputs[0]?.attachmentDescriptors).toEqual([
        {
          kind: 'attachment',
          name: 'screen.png',
          mediaType: 'image/png',
          length: 1200,
        },
      ]);
      expect(store.userInputEventById('att-good')).toMatchObject({
        prompt: 'See attached',
        attachments: [
          { name: 'screen.png', mimeType: 'image/png', size: 1200 },
        ],
      });
      // Reached: each malformed row was stored, and the read refuses it.
      malformed.forEach((_attachment, index) =>
        expect(() => store.userInputEventById(`att-bad-${index}`)).toThrow(
          'Invalid user-input event descriptor',
        ),
      );
    } finally {
      store.close?.();
    }
  });
});
