import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import {
  EventStore,
  SessionWorkItemObservationCorruptionError,
} from '../event-store.js';
import type { SessionWorkItemCandidate } from '../session-work-item-candidate.js';
import {
  mintWorkItemResultProjectorProvenanceForReviewedLoader,
  WorkItemResultProjector,
} from '../work-item-result-projector.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function candidate(): SessionWorkItemCandidate {
  const projected = new WorkItemResultProjector().project({
    associationId: 'association-a',
    sessionId: 'session-a',
    conversationId: 'session-a',
    turnId: 'turn-a',
    toolCallId: 'call-a',
    terminalStatus: 'success',
    provenance: mintWorkItemResultProjectorProvenanceForReviewedLoader(),
    githubArguments: {
      owner: 'kontourai',
      repo: 'station',
      title: 'Capture issue work',
    },
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          id: '1234567890',
          url: 'https://github.com/kontourai/station/issues/235',
        }),
      },
    ],
  });
  if (!projected) throw new Error('expected official candidate');
  return projected;
}

function completion(
  eventId = 'event-a',
  status: 'success' | 'error' | 'cancelled' = 'success',
): Extract<CanonicalRuntimeEvent, { method: 'tool.completed' }> {
  return {
    eventId,
    provider: 'claude',
    threadId: 'session-a',
    turnId: 'turn-a',
    createdAt: '2026-08-28T12:00:00.000Z',
    method: 'tool.completed',
    itemId: 'item-a',
    toolCallId: 'call-a',
    toolName: 'github.create_issue',
    status,
  };
}

function open(
  input: { admissionFault?: () => void; savepointOpenFault?: () => void } = {},
): { store: EventStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'station-work-item-store-'));
  directories.push(directory);
  const path = join(directory, 'orchestration.sqlite');
  const store = new EventStore(
    path,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    input.admissionFault,
    input.savepointOpenFault,
  );
  store.upsertSession({
    provider: 'claude',
    threadId: 'session-a',
    status: 'ready',
    createdAt: '2026-08-28T11:00:00.000Z',
    updatedAt: '2026-08-28T11:00:00.000Z',
  });
  return { store, path };
}

describe('EventStore Session work-item associations', () => {
  test('uses metadata-only admission before a CASE-bounded association JSON fetch', () => {
    const source = readFileSync(
      new URL('../event-store.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain(
      'SELECT rowid AS row_id, association_id, session_id, conversation_id,',
    );
    expect(source).toContain(
      "CASE\n                  WHEN typeof(association_json) = 'text'",
    );
    expect(source).toContain('END AS association_json');
  });

  test('rolls the association and event back together, then retakes and commits', () => {
    let fail = true;
    const { store } = open({
      admissionFault: () => {
        if (fail) {
          fail = false;
          throw new Error('injected work-item savepoint failure');
        }
      },
    });
    try {
      expect(
        store.stageSessionWorkItemCandidate({
          candidate: candidate(),
          current: () => true,
        }),
      ).toEqual({ kind: 'staged' });
      expect(() => store.appendEvent(completion())).toThrow(
        'injected work-item savepoint failure',
      );
      expect(store.listEvents('session-a')).toEqual([]);
      expect(
        store.listSessionWorkItemObservations({
          sessionId: 'session-a',
          conversationId: 'session-a',
        }),
      ).toEqual([]);
      expect(store.appendEvent(completion())).toBe(1);
      expect(
        store.listSessionWorkItemObservations({
          sessionId: 'session-a',
          conversationId: 'session-a',
        }),
      ).toEqual([
        expect.objectContaining({
          associationId: 'association-a',
          eventId: 'event-a',
        }),
      ]);
    } finally {
      store.close();
    }
  });

  test('does not take a candidate if opening the event savepoint fails', () => {
    let fail = true;
    const { store } = open({
      savepointOpenFault: () => {
        if (fail) {
          fail = false;
          throw new Error('injected savepoint-open failure');
        }
      },
    });
    try {
      const issued = candidate();
      expect(
        store.stageSessionWorkItemCandidate({
          candidate: issued,
          current: () => true,
        }),
      ).toEqual({ kind: 'staged' });
      expect(() => store.appendEvent(completion())).toThrow(
        'injected savepoint-open failure',
      );
      expect(store.appendEvent(completion())).toBe(1);
    } finally {
      store.close();
    }
  });

  test('commits only with its event, survives restart, and accepts an exact replay only', () => {
    const { store, path } = open();
    try {
      expect(
        store.stageSessionWorkItemCandidate({
          candidate: candidate(),
          current: () => true,
        }),
      ).toEqual({ kind: 'staged' });
      expect(store.appendEvent(completion())).toBe(1);
      const eventObservedAt = store.listEvents('session-a')[0]?.observedAt;
      const associationObservedAt = store.listSessionWorkItemObservations({
        sessionId: 'session-a',
        conversationId: 'session-a',
      })[0] as { observedAt?: string };
      expect(eventObservedAt).toEqual(associationObservedAt?.observedAt);
      expect(eventObservedAt).not.toBe(completion().createdAt);
    } finally {
      store.close();
    }
    const reopened = new EventStore(path);
    try {
      expect(
        reopened.stageSessionWorkItemCandidate({
          candidate: candidate(),
          current: () => true,
        }),
      ).toEqual({ kind: 'staged' });
      expect(reopened.appendEvent(completion())).toBe(1);
      expect(
        reopened.listSessionWorkItemObservations({
          sessionId: 'session-a',
          conversationId: 'session-a',
        }),
      ).toHaveLength(1);
      expect(() =>
        reopened.appendEvent({ ...completion(), toolName: 'conflicting.tool' }),
      ).toThrow('replay does not match');
    } finally {
      reopened.close();
    }
  });

  test('commits failed terminal closure only after append and restores it after rollback', () => {
    let fail = true;
    const { store } = open({
      admissionFault: () => {
        if (fail) {
          fail = false;
          throw new Error('failed terminal rolled back');
        }
      },
    });
    try {
      expect(
        store.stageSessionWorkItemCandidate({
          candidate: candidate(),
          current: () => true,
        }),
      ).toEqual({ kind: 'staged' });
      expect(() =>
        store.appendEvent(completion('failed-event', 'error')),
      ).toThrow('failed terminal rolled back');
      expect(store.appendEvent(completion('failed-event', 'error'))).toBe(1);
      expect(
        store.stageSessionWorkItemCandidate({
          candidate: candidate(),
          current: () => true,
        }),
      ).toEqual({ kind: 'refused', reason: 'closed' });
      expect(
        store.listSessionWorkItemObservations({
          sessionId: 'session-a',
          conversationId: 'session-a',
        }),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('returns corrupt durable observation rows only as a typed internal failure', () => {
    const { store, path } = open();
    store.close();
    const database = new DatabaseSync(path);
    try {
      database
        .prepare(
          `INSERT INTO orchestration_session_work_item_associations
           (association_id, session_id, conversation_id, event_id, turn_id, tool_call_id, observed_at, association_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'corrupt-association',
          'session-a',
          'session-a',
          'event-corrupt',
          'turn-corrupt',
          'call-corrupt',
          '2026-08-28T12:00:00.000Z',
          '{not-json',
        );
    } finally {
      database.close();
    }
    const reopened = new EventStore(path);
    try {
      expect(() =>
        reopened.listSessionWorkItemObservations({
          sessionId: 'session-a',
          conversationId: 'session-a',
        }),
      ).toThrow(SessionWorkItemObservationCorruptionError);
    } finally {
      reopened.close();
    }
  });

  test('quarantines oversized and duplicated-column-mismatched rows after restart', () => {
    const { store, path } = open();
    expect(
      store.stageSessionWorkItemCandidate({
        candidate: candidate(),
        current: () => true,
      }),
    ).toEqual({ kind: 'staged' });
    store.appendEvent(completion());
    store.close();

    const database = new DatabaseSync(path);
    database
      .prepare(
        `UPDATE orchestration_session_work_item_associations
            SET session_id = ? WHERE association_id = ?`,
      )
      .run('wrong-session', 'association-a');
    database.close();
    let reopened = new EventStore(path);
    try {
      expect(() =>
        reopened.listSessionWorkItemObservations({
          sessionId: 'wrong-session',
          conversationId: 'session-a',
        }),
      ).toThrow(SessionWorkItemObservationCorruptionError);
    } finally {
      reopened.close();
    }

    const oversized = new DatabaseSync(path);
    oversized
      .prepare(
        `UPDATE orchestration_session_work_item_associations
            SET session_id = ?, association_json = ? WHERE association_id = ?`,
      )
      .run(
        'session-a',
        JSON.stringify({ retained: 'x'.repeat(2 * 1024 * 1024) }),
        'association-a',
      );
    oversized.close();
    reopened = new EventStore(path);
    try {
      expect(() =>
        reopened.listSessionWorkItemObservations({
          sessionId: 'session-a',
          conversationId: 'session-a',
        }),
      ).toThrow(SessionWorkItemObservationCorruptionError);
    } finally {
      reopened.close();
    }
  });
});
