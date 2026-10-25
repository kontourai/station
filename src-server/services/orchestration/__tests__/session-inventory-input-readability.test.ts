import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CodexRolloutSessionSource } from '../../../providers/sessions/codex-rollout-session-source.js';
import { EventStore } from '../event-store.js';
import { createSessionInventoryModule } from '../session-inventory-module.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

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
        authority: sessionReadAuthorityFromRequest(
          'owner',
          undefined,
          undefined,
        ),
        current: () => true,
      });
      if (result.status !== 'found') throw new Error('expected projection');
      const inputs = (
        result.projection.groups.find((group) => group.id === 'inputs')
          ?.items ?? []
      ).map((item) => {
        if (item.kind !== 'thread-authored-input')
          throw new Error(`unexpected ${item.kind}`);
        return item;
      });

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
});
