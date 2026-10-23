/**
 * #4003 Task memory's store over the real orchestration SQLite database, as
 * `EventStore` migrates and opens it. Every write is read back through the
 * store; the database's own CHECKs and append-only triggers are probed
 * through a second connection to the same file.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TASK_MEMORY_LIMITS } from '@kontourai/station-contracts/task-memory';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
});

const TASK = { taskId: 'task-1', taskCreatedAt: '2026-10-20T00:00:00.000Z' };
const SESSION = { kind: 'session', sessionId: 'session-1' } as const;
const PERSON = { kind: 'person', principalId: 'owner-1' } as const;

function setup() {
  const directory = makeTempDir('station-task-memory-store-');
  const path = join(directory, 'orchestration.sqlite');
  const events = new EventStore(path);
  closers.push(() => void events.close());
  const memory = events.taskMemoryStore();
  const write = { ...TASK, projectId: 'project-1', author: SESSION };
  return {
    path,
    memory,
    summary: (
      text: string,
      baseRevision: number,
      author: typeof SESSION | typeof PERSON = SESSION,
    ) => memory.updateSummary({ ...write, author, text, baseRevision }),
    record: (
      record: Parameters<typeof memory.writeRecord>[0]['write'],
      author: typeof SESSION | typeof PERSON = SESSION,
    ) => memory.writeRecord({ ...write, author, write: record }),
  };
}

describe('the Task summary', () => {
  test('a write names the revision it read; a stale base is refused with the current text', () => {
    const s = setup();
    expect(s.memory.readSummary(TASK)).toBeUndefined();
    const first = s.summary('Parser fixed.', 0);
    expect(first).toMatchObject({
      kind: 'updated',
      summary: { revision: 1, text: 'Parser fixed.', author: SESSION },
    });
    // Another writer still holding revision 0 loses, and is handed revision 1.
    const stale = s.summary('My older view.', 0, PERSON);
    expect(stale).toEqual({
      kind: 'stale-base',
      current: first.kind === 'updated' ? first.summary : undefined,
    });
    // A base past the current one is just as stale.
    expect(s.summary('From the future.', 5)).toMatchObject({
      kind: 'stale-base',
      current: { revision: 1 },
    });
    expect(s.summary('Merged view.', 1, PERSON)).toMatchObject({
      kind: 'updated',
      summary: { revision: 2, author: PERSON },
    });
    expect(s.memory.readSummary(TASK)).toMatchObject({
      revision: 2,
      text: 'Merged view.',
    });
    // Every revision is kept, newest first.
    expect(s.memory.listSummaryRevisions({ ...TASK, limit: 10 })).toMatchObject(
      {
        total: 2,
        revisions: [{ revision: 2 }, { revision: 1, text: 'Parser fixed.' }],
      },
    );
  });

  test('the same text again writes no new revision', () => {
    const s = setup();
    s.summary('Same.', 0);
    expect(s.summary('Same.', 1)).toMatchObject({
      kind: 'updated',
      unchanged: true,
      summary: { revision: 1 },
    });
    expect(s.memory.listSummaryRevisions({ ...TASK, limit: 10 }).total).toBe(1);
  });

  test('over the cap is refused and nothing is cut; exactly the cap is stored', () => {
    const s = setup();
    const limit = TASK_MEMORY_LIMITS.summaryChars;
    expect(limit).toBe(4000);
    expect(s.summary('x'.repeat(limit + 1), 0)).toEqual({
      kind: 'refused',
      refusal: { kind: 'summary-too-long', length: 4001, limit: 4000 },
    });
    expect(s.memory.readSummary(TASK)).toBeUndefined();
    expect(s.summary('x'.repeat(limit), 0)).toMatchObject({ kind: 'updated' });
    expect(s.memory.readSummary(TASK)?.text).toHaveLength(4000);
    expect(s.summary('  ', 1)).toEqual({
      kind: 'refused',
      refusal: { kind: 'summary-empty' },
    });
    expect(s.summary('ok', -1)).toEqual({
      kind: 'refused',
      refusal: { kind: 'base-revision-invalid' },
    });
  });

  test('a refused authority re-check writes nothing', () => {
    const s = setup();
    expect(
      s.memory.updateSummary({
        ...TASK,
        projectId: 'project-1',
        author: SESSION,
        text: 'Late.',
        baseRevision: 0,
        beforeCommit: () => false,
      }),
    ).toEqual({ kind: 'stale' });
    expect(s.memory.readSummary(TASK)).toBeUndefined();
  });

  test('a re-created Task starts with no memory', () => {
    const s = setup();
    s.summary('Old incarnation.', 0);
    s.record({ kind: 'question', key: 'q', text: 'Old?' });
    const next = {
      taskId: TASK.taskId,
      taskCreatedAt: '2026-10-21T00:00:00.000Z',
    };
    expect(s.memory.readSummary(next)).toBeUndefined();
    expect(s.memory.listRecords(next)).toEqual([]);
    expect(s.memory.countOpenQuestions([next])).toEqual(new Map());
    expect(s.memory.countOpenQuestions([TASK])).toEqual(
      new Map([['task-1', 1]]),
    );
  });
});

describe('Task records', () => {
  test('set creates, set again supersedes, and every version is kept', () => {
    const s = setup();
    expect(
      s.record({ kind: 'decision', key: 'storage', text: 'Use JSON files.' }),
    ).toMatchObject({
      kind: 'recorded',
      record: {
        kind: 'decision',
        key: 'storage',
        version: 1,
        action: 'set',
        state: 'active',
        importance: 'standing',
      },
    });
    s.record({ kind: 'decision', key: 'storage', text: 'Use SQLite.' }, PERSON);
    expect(s.memory.listRecords(TASK)).toMatchObject([
      { key: 'storage', version: 2, text: 'Use SQLite.', author: PERSON },
    ]);
    expect(
      s.memory
        .listRecordVersions({ ...TASK, kind: 'decision', key: 'storage' })
        .map((record) => [record.version, record.text]),
    ).toEqual([
      [1, 'Use JSON files.'],
      [2, 'Use SQLite.'],
    ]);
  });

  test('importance defaults to standing for every kind and a supersede keeps the earlier choice', () => {
    const s = setup();
    for (const kind of ['decision', 'question', 'dead_end'] as const)
      expect(s.record({ kind, key: 'k', text: 't' })).toMatchObject({
        record: { importance: 'standing' },
      });
    s.record({
      kind: 'dead_end',
      key: 'narrow',
      text: 'a',
      importance: 'on_topic',
    });
    expect(
      s.record({ kind: 'dead_end', key: 'narrow', text: 'b' }),
    ).toMatchObject({ record: { version: 2, importance: 'on_topic' } });
  });

  test('a question is open until answered; the answer keeps the question', () => {
    const s = setup();
    s.record({ kind: 'question', key: 'scope', text: 'Ship the CLI too?' });
    expect(s.memory.listOpenQuestions(TASK)).toMatchObject([
      {
        record: { key: 'scope', state: 'open' },
        askedBySessionId: 'session-1',
      },
    ]);
    expect(
      s.record(
        { kind: 'question', key: 'scope', action: 'answer', text: 'No.' },
        PERSON,
      ),
    ).toMatchObject({
      record: {
        version: 2,
        action: 'answer',
        state: 'answered',
        text: 'Ship the CLI too?',
        answer: 'No.',
        author: PERSON,
      },
    });
    expect(s.memory.listOpenQuestions(TASK)).toEqual([]);
    expect(
      s.record({
        kind: 'question',
        key: 'scope',
        action: 'answer',
        text: 'Again.',
      }),
    ).toEqual({
      kind: 'refused',
      refusal: { kind: 'question-not-open', state: 'answered' },
    });
    expect(
      s.record({
        kind: 'question',
        key: 'missing',
        action: 'answer',
        text: 'x',
      }),
    ).toEqual({ kind: 'refused', refusal: { kind: 'record-missing' } });
    expect(
      s.record({ kind: 'decision', key: 'scope', action: 'answer', text: 'x' }),
    ).toEqual({ kind: 'refused', refusal: { kind: 'answer-not-a-question' } });
  });

  test('retire keeps the record in history with its reason; set brings it back', () => {
    const s = setup();
    s.record({ kind: 'dead_end', key: 'regex', text: 'A regex cannot nest.' });
    expect(
      s.record({ kind: 'dead_end', key: 'regex', action: 'retire' }),
    ).toEqual({ kind: 'refused', refusal: { kind: 'reason-required' } });
    expect(
      s.record({
        kind: 'dead_end',
        key: 'regex',
        action: 'retire',
        reason: 'Nesting was dropped.',
      }),
    ).toMatchObject({
      record: {
        version: 2,
        state: 'retired',
        text: 'A regex cannot nest.',
        reason: 'Nesting was dropped.',
      },
    });
    expect(
      s.record({
        kind: 'dead_end',
        key: 'regex',
        action: 'retire',
        reason: 'x',
      }),
    ).toEqual({ kind: 'refused', refusal: { kind: 'record-retired' } });
    expect(s.memory.listStandingRecords(TASK).deadEnds).toEqual([]);
    expect(
      s.record({
        kind: 'dead_end',
        key: 'regex',
        text: 'It cannot nest after all.',
      }),
    ).toMatchObject({ record: { version: 3, state: 'active' } });
    expect(
      s.memory
        .listRecordVersions({ ...TASK, kind: 'dead_end', key: 'regex' })
        .map((record) => record.state),
    ).toEqual(['active', 'retired', 'active']);
  });

  test('live caps refuse a new key with "supersede or retire one"; supersede, retire and answer free or keep slots', () => {
    const s = setup();
    const caps = TASK_MEMORY_LIMITS.liveRecords;
    expect(caps).toEqual({ decision: 40, question: 20, dead_end: 30 });
    for (let i = 0; i < 40; i += 1)
      expect(
        s.record({ kind: 'decision', key: `d-${i}`, text: `Decision ${i}.` })
          .kind,
      ).toBe('recorded');
    const refused = s.record({
      kind: 'decision',
      key: 'd-40',
      text: 'One more.',
    });
    expect(refused).toEqual({
      kind: 'refused',
      refusal: { kind: 'live-cap', recordKind: 'decision', limit: 40 },
    });
    // Superseding a live key takes no new slot.
    expect(
      s.record({ kind: 'decision', key: 'd-0', text: 'Decision 0, revised.' })
        .kind,
    ).toBe('recorded');
    // Another kind has its own cap.
    expect(s.record({ kind: 'dead_end', key: 'd-40', text: 'x' }).kind).toBe(
      'recorded',
    );
    s.record({
      kind: 'decision',
      key: 'd-1',
      action: 'retire',
      reason: 'Gone.',
    });
    expect(
      s.record({ kind: 'decision', key: 'd-40', text: 'Now it fits.' }).kind,
    ).toBe('recorded');
    // Reviving a retired key needs a slot too.
    expect(
      s.record({ kind: 'decision', key: 'd-1', text: 'Back.' }),
    ).toMatchObject({ refusal: { kind: 'live-cap' } });

    for (let i = 0; i < 20; i += 1)
      s.record({ kind: 'question', key: `q-${i}`, text: `Q${i}?` });
    expect(
      s.record({ kind: 'question', key: 'q-20', text: 'Q20?' }),
    ).toMatchObject({
      refusal: { kind: 'live-cap', recordKind: 'question', limit: 20 },
    });
    s.record({ kind: 'question', key: 'q-0', action: 'answer', text: 'Yes.' });
    expect(s.record({ kind: 'question', key: 'q-20', text: 'Q20?' }).kind).toBe(
      'recorded',
    );
  });

  test('a key must be a short slug and the text is bounded; nothing invalid is written', () => {
    const s = setup();
    for (const key of ['Bad Key', 'a--b', '-a', 'a-', '', 'é', 'x'.repeat(65)])
      expect(s.record({ kind: 'decision', key, text: 't' })).toEqual({
        kind: 'refused',
        refusal: { kind: 'key-invalid', limit: 64 },
      });
    expect(
      s.record({ kind: 'decision', key: 'x'.repeat(64), text: 't' }).kind,
    ).toBe('recorded');
    expect(
      s.record({ kind: 'decision', key: 'long', text: 'y'.repeat(1001) }),
    ).toEqual({
      kind: 'refused',
      refusal: { kind: 'text-too-long', length: 1001, limit: 1000 },
    });
    expect(
      s.record({
        kind: 'decision',
        key: 'imp',
        text: 't',
        action: 'retire',
        reason: 'r',
        importance: 'standing',
      }),
    ).toMatchObject({
      refusal: { kind: 'field-not-allowed', field: 'importance' },
    });
    expect(s.memory.listRecords(TASK).map((record) => record.key)).toEqual([
      'x'.repeat(64),
    ]);
  });

  test('the read API: standing decisions and dead ends, and open questions with who asked', () => {
    const s = setup();
    s.record({ kind: 'decision', key: 'a', text: 'Standing.' });
    s.record({
      kind: 'decision',
      key: 'b',
      text: 'Narrow.',
      importance: 'on_topic',
    });
    s.record({ kind: 'dead_end', key: 'c', text: 'Failed.' });
    s.record({ kind: 'decision', key: 'd', text: 'Gone.' });
    s.record({ kind: 'decision', key: 'd', action: 'retire', reason: 'r' });
    s.record({ kind: 'question', key: 'e', text: 'Person asks?' }, PERSON);
    const standing = s.memory.listStandingRecords(TASK);
    expect(standing.decisions.map((record) => record.key)).toEqual(['a']);
    expect(standing.deadEnds.map((record) => record.key)).toEqual(['c']);
    expect(s.memory.listOpenQuestions(TASK)).toEqual([
      { record: expect.objectContaining({ key: 'e', author: PERSON }) },
    ]);
  });
});

describe('the database holds the shape on its own', () => {
  test('rows are append-only and an invalid shape is refused by the CHECKs', () => {
    const s = setup();
    s.summary('One.', 0);
    s.record({ kind: 'question', key: 'q', text: 'Open?' });
    const db = new DatabaseSync(s.path);
    closers.push(() => db.close());
    expect(() => db.exec('UPDATE task_summary_revisions SET text = 1')).toThrow(
      /append-only/,
    );
    expect(() => db.exec('DELETE FROM task_record_versions')).toThrow(
      /append-only/,
    );
    const insert = (columns: Record<string, string | number | null>) => {
      const row = {
        project_id: 'p',
        task_id: 'task-x',
        task_created_at: 't',
        ordinal: 1,
        kind: 'decision',
        record_key: 'k',
        version: 1,
        action: 'set',
        state: 'active',
        importance: 'standing',
        text: 'x',
        answer: null,
        reason: null,
        author_kind: 'session',
        author_id: 's',
        created_at: 'now',
        ...columns,
      };
      const names = Object.keys(row);
      db.prepare(
        `INSERT INTO task_record_versions (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      ).run(...Object.values(row));
    };
    const bads: Array<Record<string, string | number | null>> = [
      { record_key: 'Bad Key' },
      { record_key: 'a--b' },
      { kind: 'question', state: 'active' },
      { state: 'open' },
      { action: 'answer', version: 2, state: 'answered' },
      { action: 'retire', version: 2, state: 'retired' },
      { version: 1, action: 'retire', state: 'retired', reason: 'r' },
      { text: 'y'.repeat(1001) },
    ];
    for (const bad of bads)
      expect(() => insert(bad), JSON.stringify(bad)).toThrow(/CHECK/);
    expect(() => insert({})).not.toThrow();
  });
});

describe('dismissed learning candidates (#4003 layer 4)', () => {
  const dismiss = (
    memory: ReturnType<typeof setup>['memory'],
    candidate: { kind: 'decision' | 'dead_end'; key: string; version: number },
  ) =>
    memory.dismissLearningCandidate({
      ...TASK,
      ...candidate,
      projectId: 'project-1',
      principalId: 'owner-1',
    });

  test('a dismissal survives reopening the database, and dismissing again writes nothing', async () => {
    const s = setup();
    s.record({ kind: 'decision', key: 'storage-engine', text: 'SQLite.' });
    s.record({ kind: 'dead_end', key: 'naive-retry', text: 'No backoff.' });
    expect(
      dismiss(s.memory, { kind: 'dead_end', key: 'naive-retry', version: 1 }),
    ).toMatchObject({
      kind: 'dismissed',
      dismissal: { key: 'naive-retry', version: 1, principalId: 'owner-1' },
    });

    // A second EventStore over the same file: what a restart reads.
    const reopened = new EventStore(s.path);
    closers.push(() => void reopened.close());
    expect(
      reopened.taskMemoryStore().listLearningDismissals(TASK),
    ).toMatchObject([{ kind: 'dead_end', key: 'naive-retry', version: 1 }]);
    expect(
      dismiss(reopened.taskMemoryStore(), {
        kind: 'dead_end',
        key: 'naive-retry',
        version: 1,
      }).kind,
    ).toBe('already-dismissed');
    expect(
      reopened.taskMemoryStore().listLearningDismissals(TASK),
    ).toHaveLength(1);
    // Another incarnation of the Task has no dismissals.
    expect(
      reopened.taskMemoryStore().listLearningDismissals({
        ...TASK,
        taskCreatedAt: '2026-10-21T00:00:00.000Z',
      }),
    ).toEqual([]);
  });

  test('only the current active, standing version can be dismissed', () => {
    const s = setup();
    s.record({ kind: 'decision', key: 'storage-engine', text: 'SQLite.' });
    s.record({ kind: 'decision', key: 'storage-engine', text: 'SQLite, WAL.' });
    s.record({
      kind: 'decision',
      key: 'log-format',
      text: 'JSON lines.',
      importance: 'on_topic',
    });
    s.record({ kind: 'dead_end', key: 'naive-retry', text: 'No backoff.' });
    s.record({
      kind: 'dead_end',
      key: 'naive-retry',
      action: 'retire',
      reason: 'Fixed upstream.',
    });
    for (const candidate of [
      { kind: 'decision', key: 'storage-engine', version: 1 },
      { kind: 'decision', key: 'log-format', version: 1 },
      { kind: 'dead_end', key: 'naive-retry', version: 2 },
      { kind: 'dead_end', key: 'missing', version: 1 },
    ] as const)
      expect([candidate.key, dismiss(s.memory, candidate).kind]).toEqual([
        candidate.key,
        'not-a-candidate',
      ]);
    expect(s.memory.listLearningDismissals(TASK)).toEqual([]);
    expect(
      dismiss(s.memory, { kind: 'decision', key: 'storage-engine', version: 2 })
        .kind,
    ).toBe('dismissed');
  });

  test('the table is append-only at the database', () => {
    const s = setup();
    s.record({ kind: 'decision', key: 'storage-engine', text: 'SQLite.' });
    dismiss(s.memory, { kind: 'decision', key: 'storage-engine', version: 1 });
    const raw = new DatabaseSync(s.path);
    closers.push(() => raw.close());
    expect(() => raw.exec('DELETE FROM task_learning_dismissals')).toThrow(
      /append-only/,
    );
    expect(() =>
      raw.exec("UPDATE task_learning_dismissals SET principal_id = 'x'"),
    ).toThrow(/append-only/);
  });
});
