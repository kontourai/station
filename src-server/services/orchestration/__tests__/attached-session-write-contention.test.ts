import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ProjectTaskRoomGrant,
  ProjectTaskRoomGrantKind,
} from '@kontourai/station-contracts/project-task-room';
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { AttachedSessionSource } from '../../../providers/sessions/attached-session-source.js';
import { ClaudeTranscriptSessionSource } from '../../../providers/sessions/claude-transcript-session-source.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import { AttachedSessionFollowService } from '../attached-session-follow-service.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import type { ProjectTaskRoomCapabilityAuthority } from '../project-task-room-history.js';

const makeTempDir = trackTempDirs();
let directory: string;
let path: string;
let events: EventStore;
let peer: DatabaseSync;
let bus: EventBus;
const threadId = 'external:claude:yielding';
const scope = {
  projectId: '7188ca57-2ddc-4b70-9792-bb7f9a5f76a1',
  projectSlug: 'app',
  taskId: 'task-a',
};
const authority: ProjectTaskRoomCapabilityAuthority = {
  async resolve({ required }) {
    return {
      kind: 'granted',
      receipt: {
        receiptId: `receipt-${required}`,
        capability: required,
        scope,
        principal: {
          kind: 'operator',
          operatorId: 'operator',
          deviceId: 'device',
        },
        policyRevision: 'policy-1',
      },
    };
  },
};
function grant<K extends ProjectTaskRoomGrantKind>(
  capability: K,
): ProjectTaskRoomGrant<K> {
  return Object.freeze({
    schemaVersion: 'station.project-task-room-grant/v1',
    capability,
    opaqueToken: 'valid',
  }) as ProjectTaskRoomGrant<K>;
}
function event(eventId: string): CanonicalRuntimeEvent {
  return {
    eventId,
    threadId,
    provider: 'claude',
    createdAt: '2026-10-15T00:00:01.000Z',
    method: 'content.text-delta',
    itemId: 'item',
    delta: eventId,
  };
}
function follower(source: AttachedSessionSource) {
  return new AttachedSessionFollowService({
    sources: [source],
    eventStore: events,
    eventBus: bus,
    listProjects: () => [{ slug: 'app', workingDirectory: directory }],
  });
}
beforeEach(() => {
  directory = makeTempDir('station-follow-contention-');
  path = join(directory, 'orchestration.sqlite');
  events = new EventStore(path);
  peer = new DatabaseSync(path);
  bus = new EventBus();
});
afterEach(() => {
  if (peer.isTransaction) peer.exec('ROLLBACK');
  peer.close();
  events.close();
});

test.each([
  'success',
  'contended-then-successful retry',
  'budget exhaustion',
  'non-busy error',
] as const)(
  'restores the shared connection busy_timeout after %s',
  async (outcome) => {
    const database = events['db'];
    expect(database.prepare('PRAGMA busy_timeout').get()).toMatchObject({
      timeout: 5000,
    });
    if (outcome === 'non-busy error') {
      database.exec(`CREATE TRIGGER reject_background_event
        BEFORE INSERT ON orchestration_events
        BEGIN SELECT RAISE(ABORT, 'background event rejected'); END`);
    }
    const contended =
      outcome === 'contended-then-successful retry' ||
      outcome === 'budget exhaustion';
    if (contended) peer.exec('BEGIN IMMEDIATE');
    const append = vi.spyOn(events, 'appendEventIfAbsent');
    const pending = events.appendEventIfAbsentInBackground(event('timeout'));
    try {
      if (outcome === 'contended-then-successful retry') {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        expect(append).toHaveBeenCalled();
        expect(events.listEvents(threadId)).toEqual([]);
        peer.exec('ROLLBACK');
      }
      if (outcome === 'budget exhaustion') {
        await expect(pending).rejects.toThrow(/database is locked|SQLITE_BUSY/);
      } else if (outcome === 'non-busy error') {
        await expect(pending).rejects.toThrow('background event rejected');
        expect(append).toHaveBeenCalledTimes(1);
      } else {
        await expect(pending).resolves.toBe(1);
      }
      // This must be the shared main connection: PRAGMAs on the peer cannot
      // detect leaving synchronous foreground writers with a zero timeout.
      expect(database.prepare('PRAGMA busy_timeout').get()).toMatchObject({
        timeout: 5000,
      });
      events.assertNoOuterTransactionForPublication();
    } finally {
      if (peer.isTransaction) peer.exec('ROLLBACK');
      await pending.catch(() => {});
      append.mockRestore();
    }
  },
  15_000,
);

// Cold following first appends the envelope; a warm poll first upserts the
// Session. Both must let the real room worker's under-lock authorization run.
test.each(['envelope', 'session'] as const)(
  'yields the follower %s write to a locked real room and persists the page afterwards',
  async (phase) => {
    let page: CanonicalRuntimeEvent[] = [];
    const descriptor = {
      provider: 'claude',
      sessionId: 'yielding',
      threadId,
      cwd: directory,
      createdAt: '2026-10-15T00:00:00.000Z',
      sourceHandle: 'yielding',
    };
    const source: AttachedSessionSource = {
      provider: 'claude',
      kind: 'fixture-transcript',
      async discover() {
        return { outcome: 'ok', sessions: [descriptor] };
      },
      async read() {
        return { outcome: 'ok', events: page, cursor: page.length };
      },
    };
    const service = follower(source);
    if (phase === 'session') await service.pollNow();
    page = [event('durable-after-room')];
    let checks = 0;
    let armed = false;
    let enter!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const authorized = new Promise<void>((resolve) => {
      release = resolve;
    });
    const room = events.createProjectTaskRoomHistory({
      capabilities: {
        async resolve(input) {
          if (armed && ++checks === 3) {
            enter();
            await authorized;
          }
          return authority.resolve(input);
        },
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: Promise<PromiseSettledResult<void>[]> | undefined;
    const append = events.appendEventIfAbsent.bind(events);
    const upsert = events.upsertSession.bind(events);
    const appendSpy = vi.spyOn(events, 'appendEventIfAbsent');
    const upsertSpy = vi.spyOn(events, 'upsertSession');
    let attempted = false;
    try {
      if (phase === 'session')
        expect(await room.open({ grant: grant('discover') })).toMatchObject({
          kind: 'opened',
        });
      armed = true;
      const writing =
        phase === 'envelope'
          ? room.open({ grant: grant('discover') })
          : room.append({
              grant: grant('message-write'),
              intent: {
                proposalId: 'during-import',
                occurredAt: '2026-10-15T00:00:01.000Z',
                body: { kind: 'human-message', text: 'under lock' },
              },
            });
      await locked;
      let started = 0;
      const beforeWrite = () => {
        if (attempted) return;
        attempted = true;
        started = performance.now();
        // Schedule authorization only when the actual SQLite writer is about
        // to collide, after discovery/path I/O has finished. Keep the real
        // synchronous implementation, including its lock acquisition.
        timer = setTimeout(release, 10);
      };
      if (phase === 'envelope')
        appendSpy.mockImplementation((input) => {
          beforeWrite();
          return append(input);
        });
      else
        upsertSpy.mockImplementation((input) => {
          beforeWrite();
          return upsert(input);
        });
      poll = Promise.allSettled([service.pollNow()]);
      expect(await writing).toMatchObject({
        kind: phase === 'envelope' ? 'opened' : 'committed',
      });
      expect(attempted).toBe(true);
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(await poll).toEqual([{ status: 'fulfilled', value: undefined }]);
      expect(events.listEvents(threadId).map((row) => row.id)).toContain(
        'durable-after-room',
      );
      expect(
        events.readSessions().find((row) => row.threadId === threadId)
          ?.resumeCursor,
      ).toMatchObject({ cursor: 1 });
      expect(
        await room.append({
          grant: grant('message-write'),
          intent: {
            proposalId: 'after-import',
            occurredAt: '2026-10-15T00:00:02.000Z',
            body: { kind: 'human-message', text: 'still writable' },
          },
        }),
      ).toMatchObject({ kind: 'committed' });
    } finally {
      clearTimeout(timer);
      release();
      await poll;
      appendSpy.mockRestore();
      upsertSpy.mockRestore();
      await service.stop();
      await room.close();
    }
    events.close();
    events = new EventStore(path);
    expect(events.listEvents(threadId).map((row) => row.id)).toContain(
      'durable-after-room',
    );
  },
  15_000,
);

test.each(['session', 'event', 'cursor'] as const)(
  'recovers a real transcript after the %s write exhausts its yielding budget',
  async (phase) => {
    const configDir = join(directory, 'claude');
    const project = join(configDir, 'projects', 'encoded');
    mkdirSync(project, { recursive: true });
    const transcript = join(project, 'recovery.jsonl');
    const line = (id: string) =>
      `${JSON.stringify({ type: 'user', uuid: id, sessionId: 'recovery', cwd: directory, timestamp: '2026-10-15T00:00:00.000Z', message: { role: 'user', content: id } })}\n`;
    writeFileSync(transcript, line('original'));
    const source = new ClaudeTranscriptSessionSource({ configDir });
    const service = follower(source);
    await service.pollNow();
    const [session] = events.readSessions();
    expect(session).toBeDefined();
    const priorCursor = session!.resumeCursor;
    appendFileSync(transcript, line('new-first') + line('new-second'));
    const [descriptor] = (await source.discover()).sessions;
    expect(descriptor).toBeDefined();
    const expected = (await source.read(descriptor!)).events;
    const oldIds = new Set(
      events.listEvents(session!.threadId).map((row) => row.id),
    );
    const additions = expected.filter((row) => !oldIds.has(row.eventId));
    expect(additions.length).toBeGreaterThan(1);
    let ticked = false;
    let transactionClosed = false;
    let tick: ReturnType<typeof setTimeout> | undefined;
    const hold = () => {
      peer.exec('BEGIN IMMEDIATE');
      tick = setTimeout(() => {
        ticked = true;
        events.assertNoOuterTransactionForPublication();
        transactionClosed = true;
      }, 10);
    };
    const stopHolding = bus.subscribe((published) => {
      if (published.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
      const observed = published.data?.event as
        | CanonicalRuntimeEvent
        | undefined;
      const target = phase === 'event' ? additions[0] : additions.at(-1);
      if (phase !== 'session' && observed?.eventId === target?.eventId) hold();
    });
    if (phase === 'session') hold();
    try {
      await expect(service.pollNow()).rejects.toThrow(
        /database is locked|SQLITE_BUSY/,
      );
      expect(ticked).toBe(true);
      expect(transactionClosed).toBe(true);
      expect(
        events.readSessions().find((row) => row.threadId === session!.threadId)
          ?.resumeCursor,
      ).toEqual(priorCursor);
      const partial = events
        .listEvents(session!.threadId)
        .filter((row) => !oldIds.has(row.id));
      expect(partial.map((row) => row.id)).toEqual(
        phase === 'session'
          ? []
          : (phase === 'event' ? additions.slice(0, 1) : additions).map(
              (row) => row.eventId,
            ),
      );
    } finally {
      clearTimeout(tick);
      stopHolding();
      if (peer.isTransaction) peer.exec('ROLLBACK');
      await service.stop();
    }
    // Discard every process-local seen/cursor cache and reopen SQLite. Only
    // durable progress and the actual transcript can recover the failed page.
    events.close();
    events = new EventStore(path);
    const restarted = follower(
      new ClaudeTranscriptSessionSource({ configDir }),
    );
    try {
      await restarted.pollNow();
      await restarted.pollNow();
      const imported = events
        .listEvents(session!.threadId)
        .filter((row) => expected.some((item) => item.eventId === row.id));
      expect(imported.map((row) => row.id)).toEqual(
        expected.map((row) => row.eventId),
      );
      expect(new Set(imported.map((row) => row.sequence)).size).toBe(
        imported.length,
      );
      expect(
        events.readSessions().find((row) => row.threadId === session!.threadId)
          ?.resumeCursor,
      ).not.toEqual(priorCursor);
    } finally {
      await restarted.stop();
    }
  },
  15_000,
);

test('keeps concurrent background appends in Session order and idempotent while the first backs off', async () => {
  peer.exec('BEGIN IMMEDIATE');
  const first = events.appendEventIfAbsentInBackground(event('first'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 25);
    });
    events.assertNoOuterTransactionForPublication();
    peer.exec('ROLLBACK');
    const later = [
      events.appendEventIfAbsentInBackground(event('second')),
      events.appendEventIfAbsentInBackground(event('first')),
      events.appendEventIfAbsentInBackground(event('third')),
    ];
    expect(await Promise.all([first, ...later])).toEqual([1, 2, undefined, 3]);
    expect(events.listEvents(threadId).map((row) => row.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  } finally {
    clearTimeout(timer);
    if (peer.isTransaction) peer.exec('ROLLBACK');
    await first;
  }
});

test('retries a scheduled search import from its durable watermark after yielding budget exhaustion', async () => {
  events.appendEvent({
    eventId: 'search-owner',
    sessionId: threadId,
    threadId,
    provider: 'claude',
    method: 'session.started',
    createdAt: '2026-10-15T00:00:00.000Z',
    metadata: { userId: LOCAL_OPERATOR_PRINCIPAL_ID, agentSlug: 'claude' },
  });
  for (let index = 0; index < 501; index += 1) {
    events.appendEvent({
      eventId: `search-${index}`,
      threadId,
      provider: 'claude',
      method: 'turn.completed',
      turnId: `turn-${index}`,
      createdAt: '2026-10-15T00:00:01.000Z',
      outputText: `searchable ${index}`,
    });
  }
  events.close();
  peer.exec(
    'DELETE FROM orchestration_message_search_v3; DELETE FROM orchestration_message_search_v2; DELETE FROM orchestration_message_search_projection_v3; DELETE FROM orchestration_message_search_backfill_v3; DELETE FROM orchestration_message_search_projection; DELETE FROM orchestration_message_search_backfill;',
  );
  events = new EventStore(path);
  const watermark = () =>
    (
      peer
        .prepare(
          'SELECT last_global_sequence AS value FROM orchestration_message_search_backfill_v3 WHERE id=1',
        )
        .get() as { value: number }
    ).value;
  expect(watermark()).toBe(500);
  peer.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  let tickElapsed = Infinity;
  const tick = setTimeout(() => {
    tickElapsed = performance.now() - started;
    events.assertNoOuterTransactionForPublication();
  }, 10);
  try {
    // More than one five-second retry budget, less than two. A later pass
    // must still be scheduled without restarting or advancing the watermark.
    await new Promise<void>((resolve) => setTimeout(resolve, 5_300));
    expect(tickElapsed).toBeLessThan(1_500);
    expect(watermark()).toBe(500);
    peer.exec('ROLLBACK');
    await expect.poll(watermark, { timeout: 5_000 }).toBe(502);
    expect(
      peer
        .prepare(
          'SELECT COUNT(*) AS total FROM orchestration_message_search_v3',
        )
        .get(),
    ).toMatchObject({ total: 501 });
  } finally {
    clearTimeout(tick);
    if (peer.isTransaction) peer.exec('ROLLBACK');
  }
}, 15_000);

test('retries colliding alias deletion on the next poll after budget exhaustion', async () => {
  const descriptor = {
    provider: 'claude',
    sessionId: 'yielding',
    threadId,
    cwd: directory,
    createdAt: '2026-10-15T00:00:00.000Z',
    sourceHandle: 'yielding',
  };
  const source: AttachedSessionSource = {
    provider: 'claude',
    kind: 'fixture-transcript',
    ownedNativeSessionId(session) {
      return typeof session.resumeCursor === 'string'
        ? session.resumeCursor
        : undefined;
    },
    async discover() {
      return { outcome: 'ok', sessions: [descriptor] };
    },
    async read() {
      return { outcome: 'ok', events: [event('alias-event')], cursor: 1 };
    },
  };
  const service = follower(source);
  try {
    await service.pollNow();
    events.upsertSession({
      threadId: 'station-owned',
      provider: 'claude',
      status: 'ready',
      resumeCursor: 'yielding',
      createdAt: descriptor.createdAt,
      updatedAt: descriptor.createdAt,
    });
    peer.exec('BEGIN IMMEDIATE');
    let ticked = false;
    const tick = setTimeout(() => {
      ticked = true;
    }, 10);
    try {
      await expect(service.pollNow()).rejects.toThrow(
        /database is locked|SQLITE_BUSY/,
      );
      expect(ticked).toBe(true);
      expect(
        events.readSessions().some((row) => row.threadId === threadId),
      ).toBe(true);
    } finally {
      clearTimeout(tick);
      peer.exec('ROLLBACK');
    }
    await service.pollNow();
    expect(events.readSessions().map((row) => row.threadId)).toEqual([
      'station-owned',
    ]);
    expect(events.listEvents(threadId)).toEqual([]);
  } finally {
    await service.stop();
  }
}, 15_000);
