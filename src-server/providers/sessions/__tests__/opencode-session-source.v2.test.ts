import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  AttachedSessionCursor,
  AttachedSessionDescriptor,
} from '../attached-session-source.js';
import { OpenCodeSessionSource } from '../opencode-session-source.js';
import { OPENCODE_SCHEMA, OpenCodeFixtureWriter } from './opencode-fixture.js';
import {
  OPENCODE_V2_SCHEMA,
  OPENCODE_V2_SCHEMA_WITHOUT_PARTS,
  OpenCodeV2FixtureWriter,
  v2Content,
} from './opencode-v2-fixture.js';

const tempDir = trackTempDirs();
const writers: Array<{ close(): void }> = [];

function fixtureRoot(): string {
  return realpathSync(tempDir('station-opencode-v2-'));
}

function writer(
  dataDir: string,
  schema = OPENCODE_V2_SCHEMA,
): OpenCodeV2FixtureWriter {
  const created = new OpenCodeV2FixtureWriter(dataDir, 'opencode.db', schema);
  writers.push(created);
  return created;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const open of writers.splice(0)) {
    try {
      open.close();
    } catch {
      // Already closed by the test.
    }
  }
});

async function drain(
  source: OpenCodeSessionSource,
  session: AttachedSessionDescriptor,
  cursor: AttachedSessionCursor = 0,
) {
  const events: CanonicalRuntimeEvent[] = [];
  const outcomes: string[] = [];
  for (let page = 0; page < 64; page += 1) {
    const result = await source.read(session, cursor);
    events.push(...result.events);
    outcomes.push(result.outcome);
    if (JSON.stringify(result.cursor) === JSON.stringify(cursor)) {
      return { events, outcomes, cursor: result.cursor };
    }
    cursor = result.cursor;
  }
  throw new Error('fixture did not reach a stable cursor');
}

/**
 * One complete OpenCode 2.x turn: a prompt, a tool step, the answer step and
 * the idle row that closes it, with rows that carry no turn in between.
 */
function writeTurn(
  store: OpenCodeV2FixtureWriter,
  sessionId: string,
  prompt: string,
  partRows = false,
) {
  const user = store.user(sessionId, prompt);
  store.other(sessionId, 'synthetic', {
    text: 'model-facing reminder',
    description: 'reminder',
    metadata: {},
  });
  const first = store.assistant(sessionId, {
    partRows,
    finish: 'tool-calls',
    content: [
      v2Content.reasoning('Thinking about it.'),
      v2Content.tool('call-read', 'read', {
        status: 'completed',
        input: { path: '/workspace/a.txt' },
        output: 'file contents',
      }),
      v2Content.tool('call-bash', 'bash', {
        status: 'error',
        input: { command: 'false' },
        error: 'exit status 1',
      }),
    ],
    tokens: { input: 100, output: 10, reasoning: 5, read: 1000, write: 50 },
  });
  const second = store.assistant(sessionId, {
    partRows,
    finish: 'stop',
    content: [
      v2Content.text('First paragraph.'),
      v2Content.text('Second paragraph.'),
    ],
    tokens: { input: 20, output: 30, reasoning: 0, read: 1100, write: 0 },
  });
  const idle = store.idle(sessionId, 'succeeded');
  return { user, first, second, idle };
}

function shape(events: CanonicalRuntimeEvent[]) {
  return events.map((event) => ({
    method: event.method,
    ...('turnId' in event ? { turnId: event.turnId } : {}),
  }));
}

function semantic(events: CanonicalRuntimeEvent[]) {
  return events.map((event) => {
    const {
      eventId: _eventId,
      createdAt: _createdAt,
      threadId: _threadId,
      ...rest
    } = event as unknown as Record<string, unknown>;
    if ('itemId' in rest && typeof rest.itemId === 'string') {
      rest.itemId = rest.itemId.includes(':') ? 'content-item' : rest.itemId;
    }
    if ('turnId' in rest) rest.turnId = 'turn';
    return rest;
  });
}

describe('OpenCodeSessionSource on an OpenCode 2.x store', () => {
  test('discovers a prompted top-level session and maps one turn to canonical events', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    store.session('ses_unprompted', '/workspace/project');
    store.other('ses_unprompted', 'model-switched', {
      model: { id: 'model-b', providerID: 'provider-a' },
    });
    store.session('ses_child', '/workspace/project', { parentId: 'ses_main' });
    store.session('ses_archived', '/workspace/project', { archived: true });
    for (const sessionId of ['ses_child', 'ses_archived']) {
      writeTurn(store, sessionId, 'hidden');
    }
    const { user } = writeTurn(store, 'ses_main', 'Fix the bug');

    const warn = vi.fn();
    const source = new OpenCodeSessionSource({ dataDir, warn });
    const discovery = await source.discover();
    expect(warn).not.toHaveBeenCalled();
    expect(discovery.outcome).toBe('ok');
    expect(discovery.sessions.map((session) => session.sessionId)).toEqual([
      'ses_main',
    ]);
    const session = discovery.sessions[0]!;
    expect(session).toMatchObject({
      provider: 'opencode',
      cwd: '/workspace/project',
      affinity: { kind: 'opencode-data-home', ref: expect.any(String) },
    });
    expect(session.threadId).toMatch(/^external:opencode:[a-f0-9]{64}$/);

    const result = await source.read(session);
    expect(result.outcome).toBe('ok');
    expect(shape(result.events)).toEqual([
      { method: 'turn.started', turnId: user },
      { method: 'content.reasoning-delta', turnId: user },
      { method: 'tool.started', turnId: user },
      { method: 'tool.completed', turnId: user },
      { method: 'tool.started', turnId: user },
      { method: 'tool.completed', turnId: user },
      { method: 'content.text-delta', turnId: user },
      { method: 'content.text-delta', turnId: user },
      { method: 'token-usage.updated', turnId: user },
      { method: 'turn.completed', turnId: user },
    ]);
    const byMethod = (method: string) =>
      result.events.filter((event) => event.method === method);
    expect(byMethod('turn.started')[0]).toMatchObject({
      prompt: 'Fix the bug',
      provider: 'opencode',
      threadId: session.threadId,
    });
    expect(byMethod('tool.started')).toMatchObject([
      {
        toolCallId: 'call-read',
        toolName: 'read',
        arguments: { path: '/workspace/a.txt' },
      },
      { toolCallId: 'call-bash', toolName: 'bash' },
    ]);
    expect(byMethod('tool.completed')).toMatchObject([
      { toolCallId: 'call-read', status: 'success', output: 'file contents' },
      { toolCallId: 'call-bash', status: 'error', error: 'exit status 1' },
    ]);
    expect(
      byMethod('content.text-delta').map((event) =>
        event.method === 'content.text-delta' ? event.delta : '',
      ),
    ).toEqual(['First paragraph.', '\n\nSecond paragraph.']);
    // Both steps, summed once at the idle row; completion counts reasoning,
    // which OpenCode 2.x stores apart from output.
    expect(byMethod('token-usage.updated')[0]).toMatchObject({
      promptTokens: 120,
      completionTokens: 45,
      cacheReadTokens: 2100,
      cacheWriteTokens: 50,
    });
    // The idle row closes the turn with the last step's finish.
    expect(byMethod('turn.completed')[0]).toMatchObject({
      finishReason: 'stop',
    });
    expect(new Set(result.events.map((event) => event.eventId)).size).toBe(
      result.events.length,
    );
    expect(await source.read(session, result.cursor)).toMatchObject({
      outcome: 'ok',
      events: [],
      cursor: result.cursor,
    });
  });

  test('folds session_part rows the way inline content maps, and reads a store without the part table', async () => {
    const root = fixtureRoot();
    const read = async (
      schema: string,
      partRows: boolean,
      folder: string,
    ): Promise<CanonicalRuntimeEvent[]> => {
      const dataDir = join(root, folder, 'opencode');
      const store = writer(dataDir, schema);
      store.session('ses_main', '/workspace/project');
      writeTurn(store, 'ses_main', 'Fix the bug', partRows);
      const source = new OpenCodeSessionSource({ dataDir });
      const session = (await source.discover()).sessions[0]!;
      const result = await source.read(session);
      expect(result.outcome).toBe('ok');
      return result.events;
    };
    const inline = await read(OPENCODE_V2_SCHEMA, false, 'inline');
    const parts = await read(OPENCODE_V2_SCHEMA, true, 'parts');
    const noPartTable = await read(
      OPENCODE_V2_SCHEMA_WITHOUT_PARTS,
      false,
      'pre-2.3',
    );
    expect(inline.length).toBe(10);
    expect(semantic(parts)).toEqual(semantic(inline));
    expect(semantic(noPartTable)).toEqual(semantic(inline));
  });

  // Review: each write input stands alone. In a 2.0-2.2 store (no
  // session_part) a step streams by rewriting its own message row, which is
  // then the only signal; a session row moving alone is another.
  test("reports a streaming message row's own write in a store without part rows", async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir, OPENCODE_V2_SCHEMA_WITHOUT_PARTS);
    store.session('ses_main', '/workspace/project');
    store.user('ses_main', 'Long task');
    const step = store.assistant('ses_main', {
      completed: false,
      content: [v2Content.text('Partial')],
    });
    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const before = await source.read(session);
    expect(before.outcome).toBe('incomplete_tail');
    const sessionTime = (
      store.db
        .prepare('SELECT time_updated AS t FROM session_v2 WHERE id = ?')
        .get('ses_main') as { t: number }
    ).t;

    const streamed = store.tick();
    expect(streamed).toBeGreaterThan(sessionTime);
    store.db
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.content', json(?)), time_updated = ? WHERE id = ?",
      )
      .run(
        JSON.stringify([v2Content.text('Partial, still streaming')]),
        streamed,
        step,
      );
    const after = await source.read(session, before.cursor);
    expect(after.events).toEqual([]);
    expect(after.sourceWriteAt).toBe(new Date(streamed).toISOString());
  });

  test("reports the session row's own write when nothing else moved", async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir, OPENCODE_V2_SCHEMA_WITHOUT_PARTS);
    store.session('ses_main', '/workspace/project');
    store.user('ses_main', 'Long task');
    store.assistant('ses_main', {
      completed: false,
      content: [v2Content.text('Partial')],
    });
    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const before = await source.read(session);
    const touched = store.tick();
    store.db
      .prepare('UPDATE session_v2 SET time_updated = ? WHERE id = ?')
      .run(touched, 'ses_main');
    const after = await source.read(session, before.cursor);
    expect(after.sourceWriteAt).toBe(new Date(touched).toISOString());
  });

  // A step still streaming into its part rows moves only those rows; the
  // source reports that write so an open turn reads as still running.
  test('reports the newest write of a step still streaming into its part rows', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    store.user('ses_main', 'Long task');
    const step = store.assistant('ses_main', {
      completed: false,
      partRows: true,
      content: [v2Content.text('Partial')],
    });
    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const before = await source.read(session);
    expect(before.outcome).toBe('incomplete_tail');

    const streamed = store.tick();
    store.db
      .prepare(
        'UPDATE session_part SET data = ?, time_updated = ? WHERE message_id = ? AND ordinal = 0',
      )
      .run(
        JSON.stringify(v2Content.text('Partial, still streaming')),
        streamed,
        step,
      );
    const after = await source.read(session, before.cursor);
    expect(after.events).toEqual([]);
    expect(after.sourceWriteAt).toBe(new Date(streamed).toISOString());
  });

  test('waits on an in-flight step, imports it once completed, and resumes without duplicates', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const user = store.user('ses_main', 'First');
    const step = store.assistant('ses_main', {
      completed: false,
      content: [v2Content.text('Partial')],
    });

    const source = new OpenCodeSessionSource({ dataDir, maxEvents: 3 });
    const session = (await source.discover()).sessions[0]!;
    const first = await drain(source, session);
    expect(first.outcomes).toContain('incomplete_tail');
    expect(shape(first.events)).toEqual([
      { method: 'turn.started', turnId: user },
    ]);

    store.updateAssistant('ses_main', step, {
      finish: 'stop',
      content: [v2Content.text('Partial, then whole.')],
      tokens: { input: 1, output: 2, reasoning: 0, read: 0, write: 0 },
    });
    store.idle('ses_main', 'succeeded');
    const second = await drain(source, session, first.cursor);
    expect(shape(second.events)).toEqual([
      { method: 'content.text-delta', turnId: user },
      { method: 'token-usage.updated', turnId: user },
      { method: 'turn.completed', turnId: user },
    ]);
    expect(second.events[0]).toMatchObject({ delta: 'Partial, then whole.' });

    const later = writeTurn(store, 'ses_main', 'Second');
    const third = await drain(source, session, second.cursor);
    expect(
      third.events.filter((event) => event.method === 'turn.started'),
    ).toMatchObject([{ turnId: later.user, prompt: 'Second' }]);
    const ids = [...first.events, ...second.events, ...third.events].map(
      (event) => event.eventId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a later step settles one whose writer died mid-write', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    store.user('ses_main', 'Go');
    store.assistant('ses_main', {
      completed: false,
      content: [v2Content.text('Cut off')],
    });
    store.assistant('ses_main', {
      finish: 'stop',
      content: [v2Content.text('Resumed')],
    });
    store.idle('ses_main', 'succeeded');
    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const result = await source.read(session);
    expect(result.outcome).toBe('ok');
    expect(
      result.events
        .filter((event) => event.method === 'content.text-delta')
        .map((event) =>
          event.method === 'content.text-delta' ? event.delta : '',
        ),
    ).toEqual(['Cut off', '\n\nResumed']);
  });

  test('maps interrupted and failed idle rows, a steered prompt and a compaction', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const interrupted = store.user('ses_main', 'Stop me');
    store.assistant('ses_main', {
      error: { type: 'aborted', message: 'The operation was aborted.' },
      finish: 'error',
    });
    store.idle('ses_main', 'interrupted');
    const failed = store.user('ses_main', 'Quota');
    store.assistant('ses_main', {
      error: { type: 'provider.quota', message: 'rate limited' },
      finish: 'error',
    });
    store.idle('ses_main', 'failed', {
      type: 'provider.quota',
      message: 'rate limited',
    });
    const queued = store.user('ses_main', 'First ask');
    store.assistant('ses_main', {
      finish: 'stop',
      content: [v2Content.text('Answer')],
    });
    const steered = store.user('ses_main', 'Also this');
    store.compaction('ses_main', 'completed');
    store.assistant('ses_main', { finish: 'length' });
    store.idle('ses_main', 'succeeded');
    store.compaction('ses_main', 'running');

    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const result = await source.read(session);
    // The running compaction at the tail is not settled yet.
    expect(result.outcome).toBe('incomplete_tail');
    expect(shape(result.events)).toEqual([
      { method: 'turn.started', turnId: interrupted },
      { method: 'turn.aborted', turnId: interrupted },
      { method: 'turn.started', turnId: failed },
      { method: 'runtime.error', turnId: failed },
      { method: 'turn.completed', turnId: failed },
      { method: 'turn.started', turnId: queued },
      { method: 'content.text-delta', turnId: queued },
      { method: 'turn.completed', turnId: queued },
      { method: 'turn.started', turnId: steered },
      { method: 'extension.notification' },
      { method: 'turn.completed', turnId: steered },
    ]);
    const events = result.events;
    expect(events[1]).toMatchObject({ reason: 'interrupted in OpenCode' });
    // The failure is reported once, by the idle row, not by the failed step.
    expect(events[3]).toMatchObject({ message: 'rate limited' });
    expect(events[4]).toMatchObject({ finishReason: 'other' });
    expect(events[7]).toMatchObject({
      finishReason: 'other',
      metadata: { closedBy: 'next-prompt' },
    });
    expect(events[9]).toMatchObject({ type: 'context-compacted' });
    expect(events[10]).toMatchObject({ finishReason: 'max-tokens' });
  });

  test('fails closed with one warning per changed v2 table shape', async () => {
    const cases: Array<[string, string, string]> = [
      [
        'message',
        OPENCODE_V2_SCHEMA.replace(
          '`seq` integer NOT NULL,',
          '`seq` integer NOT NULL, `extra` text,',
        ),
        'session_message:columns',
      ],
      [
        'part',
        OPENCODE_V2_SCHEMA.replace(
          '`call_id` text,',
          '`call_id` text, `extra` text,',
        ),
        'session_part:columns',
      ],
      [
        'session',
        OPENCODE_V2_SCHEMA.replace(
          '`time_archived` integer,\n          `time_suspended`',
          '`time_suspended`',
        ),
        'session_v2:missing:time_archived',
      ],
    ];
    for (const [folder, schema, detail] of cases) {
      expect(schema).not.toBe(OPENCODE_V2_SCHEMA);
      const dataDir = join(fixtureRoot(), folder, 'opencode');
      const store = writer(dataDir, schema);
      store.session('ses_main', '/workspace/project');
      store.user('ses_main', 'Hello');
      const warn = vi.fn();
      const source = new OpenCodeSessionSource({ dataDir, warn });
      expect(await source.discover()).toEqual({
        outcome: 'rejected_candidate',
        sessions: [],
      });
      store.touch('ses_main');
      await source.discover();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toMatchObject({
        database: 'opencode.db',
        reason: 'unsupported_schema',
        detail,
      });
    }
  });

  test('a store with neither layout still fails closed as session:missing', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(join(dataDir, 'opencode.db'));
    writers.push(db);
    db.exec('CREATE TABLE `session_message` (`id` text PRIMARY KEY);');
    const warn = vi.fn();
    const source = new OpenCodeSessionSource({ dataDir, warn });
    expect((await source.discover()).outcome).toBe('rejected_candidate');
    expect(warn.mock.calls[0]![1]).toMatchObject({ detail: 'session:missing' });
  });

  test('never reinterprets a cursor position written for the other layout', async () => {
    const root = fixtureRoot();
    const v1Dir = join(root, 'v1', 'opencode');
    const v1 = new OpenCodeFixtureWriter(v1Dir, 'opencode.db');
    writers.push(v1);
    v1.session('ses_main', '/workspace/project');
    const v1User = v1.user('ses_main', ['Hello']);
    v1.assistant('ses_main', v1User, { finish: 'stop' });
    const v1Source = new OpenCodeSessionSource({ dataDir: v1Dir });
    const v1Session = (await v1Source.discover()).sessions[0]!;
    const v1Read = await v1Source.read(v1Session);
    expect(v1Read.outcome).toBe('ok');

    const v2Dir = join(root, 'v2', 'opencode');
    const store = writer(v2Dir);
    store.session('ses_main', '/workspace/project');
    writeTurn(store, 'ses_main', 'Hello');
    const source = new OpenCodeSessionSource({ dataDir: v2Dir });
    const session = (await source.discover()).sessions[0]!;
    const v2Read = await source.read(session);
    expect(v2Read.outcome).toBe('ok');

    expect(await source.read(session, v1Read.cursor)).toMatchObject({
      outcome: 'rejected_candidate',
      events: [],
    });
    expect(await v1Source.read(v1Session, v2Read.cursor)).toMatchObject({
      outcome: 'rejected_candidate',
      events: [],
    });
  });
  test('reports an unknown message type as malformed and keeps reading the rest', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const first = writeTurn(store, 'ses_main', 'Before');
    store.other('ses_main', 'assistant-next', { text: 'a future row type' });
    const second = writeTurn(store, 'ses_main', 'After');
    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const result = await drain(source, session);
    expect(result.outcomes[0]).toBe('malformed_record');
    expect(
      result.events.filter((event) => event.method === 'turn.started'),
    ).toMatchObject([{ turnId: first.user }, { turnId: second.user }]);
    expect(
      result.events.filter((event) => event.method === 'turn.completed'),
    ).toHaveLength(2);
  });

  test('holds a running compaction until OpenCode finishes that row in place', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const user = store.user('ses_main', 'Long one');
    const compaction = store.compaction('ses_main', 'running');
    store.assistant('ses_main', {
      finish: 'stop',
      content: [v2Content.text('Done')],
    });
    store.idle('ses_main', 'succeeded');

    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const before = await drain(source, session);
    expect(before.outcomes.at(-1)).toBe('incomplete_tail');
    expect(shape(before.events)).toEqual([
      { method: 'turn.started', turnId: user },
    ]);

    store.completeCompaction('ses_main', compaction);
    const after = await drain(source, session, before.cursor);
    expect(shape(after.events)).toEqual([
      { method: 'extension.notification' },
      { method: 'content.text-delta', turnId: user },
      { method: 'turn.completed', turnId: user },
    ]);
    expect(after.events[0]).toMatchObject({ type: 'context-compacted' });
  });

  test('passes a running compaction that a later running one superseded, since OpenCode finishes only the latest', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const user = store.user('ses_main', 'Compact twice');
    store.compaction('ses_main', 'running');
    const latest = store.compaction('ses_main', 'running');
    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const before = await drain(source, session);
    // The superseded one is passed; the latest holds the tail.
    expect(before.outcomes.at(-1)).toBe('incomplete_tail');
    expect(before.cursor).toMatchObject({ offset: 2 });
    expect(shape(before.events)).toEqual([
      { method: 'turn.started', turnId: user },
    ]);

    store.completeCompaction('ses_main', latest);
    store.idle('ses_main', 'succeeded');
    const after = await drain(source, session, before.cursor);
    expect(after.outcomes.at(-1)).toBe('ok');
    expect(shape(after.events)).toEqual([
      { method: 'extension.notification' },
      { method: 'turn.completed', turnId: user },
    ]);
  });

  test('skips the opencode-next.db an OpenCode 2.x store already imported, without a warning', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    writeTurn(store, 'ses_main', 'Hello');
    // The 2.x preview store OpenCode 2.x imports read-only and leaves in place
    // (`isNextDatabase`: project, session and session_message, no message
    // table); approximated from the 1.x DDL without `message` and `part`.
    const preview = new DatabaseSync(join(dataDir, 'opencode-next.db'));
    writers.push(preview);
    preview.exec(
      OPENCODE_SCHEMA.replace(/CREATE TABLE `message`[\s\S]*?\);\n/u, '')
        .replace(/CREATE TABLE `part`[\s\S]*?\);\n/u, '')
        .replace(/CREATE INDEX `part_[^\n]*\n/gu, '')
        .replace(/CREATE INDEX `message_[^\n]*\n/gu, ''),
    );
    expect(
      preview
        .prepare("SELECT name FROM sqlite_master WHERE name = 'message'")
        .get(),
    ).toBeUndefined();
    const warn = vi.fn();
    const source = new OpenCodeSessionSource({ dataDir, warn });
    const discovery = await source.discover();
    expect(discovery.outcome).toBe('ok');
    expect(discovery.sessions.map((session) => session.sessionId)).toEqual([
      'ses_main',
    ]);
    expect(warn).not.toHaveBeenCalled();

    // Without a 2.x store beside it, the same file still fails closed.
    store.close();
    const alone = join(fixtureRoot(), 'alone', 'opencode');
    mkdirSync(alone, { recursive: true });
    const lonePreview = new DatabaseSync(join(alone, 'opencode-next.db'));
    writers.push(lonePreview);
    lonePreview.exec(
      'CREATE TABLE `session` (`id` text PRIMARY KEY, `parent_id` text, `directory` text, `time_created` integer, `time_updated` integer, `time_archived` integer, `version` text);',
    );
    const loneWarn = vi.fn();
    const loneSource = new OpenCodeSessionSource({
      dataDir: alone,
      warn: loneWarn,
    });
    expect((await loneSource.discover()).outcome).toBe('rejected_candidate');
    expect(loneWarn.mock.calls[0]![1]).toMatchObject({
      database: 'opencode-next.db',
      detail: 'message:missing',
    });
  });

  test('reads a 1.x-layout opencode-next.db beside a 2.x store, keeping the 2.x copy of a session both hold', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_shared', '/workspace/project');
    writeTurn(store, 'ses_shared', 'Imported into 2.x');
    // OpenCode 1.x on the `next` channel writes opencode-next.db in the 1.x
    // layout, which also carries `session_message`, so it passes OpenCode's
    // own `isNextDatabase` check; 2.x copies only session and
    // session_message rows from it, never the 1.x transcript.
    const next = new OpenCodeFixtureWriter(dataDir, 'opencode-next.db');
    writers.push(next);
    next.session('ses_next_only', '/workspace/other');
    const nextUser = next.user('ses_next_only', ['From the next channel']);
    next.assistant('ses_next_only', nextUser, { finish: 'stop' });
    next.session('ses_shared', '/workspace/project');
    const sharedUser = next.user('ses_shared', ['Stale 1.x copy']);
    next.assistant('ses_shared', sharedUser, { finish: 'stop' });

    const warn = vi.fn();
    const source = new OpenCodeSessionSource({ dataDir, warn });
    const discovery = await source.discover();
    expect(warn).not.toHaveBeenCalled();
    expect(discovery.outcome).toBe('ok');
    const listed = discovery.sessions.map((session) => session.sessionId);
    expect([...listed].sort()).toEqual(['ses_next_only', 'ses_shared']);
    const nextOnly = discovery.sessions.find(
      (session) => session.sessionId === 'ses_next_only',
    )!;
    const read = await source.read(nextOnly);
    expect(read.outcome).toBe('ok');
    expect(
      read.events.filter((event) => event.method === 'turn.started'),
    ).toMatchObject([{ prompt: 'From the next channel' }]);
    const shared = discovery.sessions.find(
      (session) => session.sessionId === 'ses_shared',
    )!;
    expect(
      (await source.read(shared)).events.filter(
        (event) => event.method === 'turn.started',
      ),
    ).toMatchObject([{ prompt: 'Imported into 2.x' }]);
  });

  test('suppresses a next-store copy of any session the 2.x store holds: archived, child or promptless', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_live', '/workspace/project');
    writeTurn(store, 'ses_live', 'Still live');
    store.session('ses_archived', '/workspace/project', { archived: true });
    writeTurn(store, 'ses_archived', 'Archived in 2.x');
    store.session('ses_child', '/workspace/project', { parentId: 'ses_live' });
    store.session('ses_promptless', '/workspace/project');
    const next = new OpenCodeFixtureWriter(dataDir, 'opencode-next.db');
    writers.push(next);
    for (const sessionId of [
      'ses_archived',
      'ses_child',
      'ses_promptless',
      'ses_next_only',
    ]) {
      next.session(sessionId, '/workspace/project');
      const user = next.user(sessionId, ['Stale 1.x copy']);
      next.assistant(sessionId, user, { finish: 'stop' });
    }
    const warn = vi.fn();
    const source = new OpenCodeSessionSource({ dataDir, warn });
    const discovery = await source.discover();
    expect(warn).not.toHaveBeenCalled();
    expect(discovery.outcome).toBe('ok');
    expect(
      discovery.sessions.map((session) => session.sessionId).sort(),
    ).toEqual(['ses_live', 'ses_next_only']);
  });

  test('after a completed OpenCode migration lists only next-store sessions created since, so one deleted in 2.x stays gone', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_live', '/workspace/project');
    writeTurn(store, 'ses_live', 'Still live');
    const next = new OpenCodeFixtureWriter(dataDir, 'opencode-next.db');
    writers.push(next);
    next.session('ses_deleted_in_2x', '/workspace/project');
    const user = next.user('ses_deleted_in_2x', ['Deleted after import']);
    next.assistant('ses_deleted_in_2x', user, { finish: 'stop' });

    // Mid-migration OpenCode may not have imported every session yet, so
    // the next store is still read (per-session dedupe only).
    store.migrationState('sessions');
    const midway = new OpenCodeSessionSource({ dataDir });
    expect(
      (await midway.discover()).sessions
        .map((session) => session.sessionId)
        .sort(),
    ).toEqual(['ses_deleted_in_2x', 'ses_live']);

    const completedAt = store.migrationState('completed');
    const warn = vi.fn();
    const source = new OpenCodeSessionSource({ dataDir, warn });
    const discovery = await source.discover();
    expect(warn).not.toHaveBeenCalled();
    expect(discovery.outcome).toBe('ok');
    expect(discovery.sessions.map((session) => session.sessionId)).toEqual([
      'ses_live',
    ]);

    // OpenCode never imports the file again once the migration completed,
    // so a pinned 1.x next-channel build's later session is listed from it.
    next.advanceTo(completedAt);
    next.session('ses_after_migration', '/workspace/project');
    const later = next.user('ses_after_migration', ['Written after']);
    next.assistant('ses_after_migration', later, { finish: 'stop' });
    const after = await source.discover();
    expect(warn).not.toHaveBeenCalled();
    expect(after.sessions.map((session) => session.sessionId).sort()).toEqual([
      'ses_after_migration',
      'ses_live',
    ]);
  });

  test('answers a drained read from its cache whatever key order the cursor comes back in', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    writeTurn(store, 'ses_main', 'Hello');
    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const first = await source.read(session);
    expect(first.outcome).toBe('ok');
    const reorder = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reorder)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>)
                .reverse()
                .map(([key, item]) => [key, reorder(item)]),
            )
          : value;
    const reordered = reorder(first.cursor) as AttachedSessionCursor;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(first.cursor));
    expect(reordered).toEqual(first.cursor);

    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    const transcriptQueries = () =>
      prepare.mock.calls.filter(([sql]) =>
        /\bFROM session_message\b|\bsession_v2 WHERE id\b/u.test(String(sql)),
      ).length;
    expect(await source.read(session, reordered)).toMatchObject({
      outcome: 'ok',
      events: [],
    });
    expect(transcriptQueries()).toBe(0);
  });

  test('warns once when a running compaction has held a session past the bound', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    store.user('ses_main', 'Long one');
    store.compaction('ses_main', 'running');
    store.idle('ses_main', 'succeeded');
    const compactedAt = store.tick() - 1000;
    const warn = vi.fn();
    let now = compactedAt + 60_000;
    const source = new OpenCodeSessionSource({ dataDir, warn, now: () => now });
    const session = (await source.discover()).sessions[0]!;
    const fresh = await source.read(session);
    expect(fresh.outcome).toBe('incomplete_tail');
    expect(warn).not.toHaveBeenCalled();

    // A crashed session that is never reopened leaves the store unchanged;
    // the hold is still noticed once it passes the bound.
    now = compactedAt + 24 * 60 * 60 * 1000;
    for (let poll = 0; poll < 3; poll += 1) {
      expect((await source.read(session, fresh.cursor)).outcome).toBe(
        'incomplete_tail',
      );
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({
      database: 'opencode.db',
      reason: 'compaction_unfinished',
      threadId: session.threadId,
      sessionId: 'ses_main',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Long one');
  });

  test('reads a row with part rows and later inline content in OpenCode order: parts first', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    store.user('ses_main', 'Mixed');
    store.assistant('ses_main', {
      partRows: true,
      finish: 'stop',
      content: [v2Content.text('From parts.')],
      inlineContent: [v2Content.text('From inline.')],
    });
    store.idle('ses_main', 'succeeded');
    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const result = await source.read(session);
    expect(
      result.events
        .filter((event) => event.method === 'content.text-delta')
        .map((event) =>
          event.method === 'content.text-delta' ? event.delta : '',
        ),
    ).toEqual(['From parts.', '\n\nFrom inline.']);
  });

  test('an idle row settles an unfinished step that nothing else follows', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const user = store.user('ses_main', 'Go');
    store.assistant('ses_main', {
      completed: false,
      content: [v2Content.text('Cut off')],
    });
    store.idle('ses_main', 'interrupted');
    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const result = await source.read(session);
    expect(result.outcome).toBe('ok');
    expect(shape(result.events)).toEqual([
      { method: 'turn.started', turnId: user },
      { method: 'content.text-delta', turnId: user },
      { method: 'turn.aborted', turnId: user },
    ]);
  });

  test("carries an open turn's step finish across a page break to its idle row", async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    store.user('ses_main', 'Write a lot');
    store.assistant('ses_main', {
      finish: 'length',
      content: [v2Content.text('Truncated answer')],
    });
    store.idle('ses_main', 'succeeded');
    const source = new OpenCodeSessionSource({ dataDir, maxMessages: 2 });
    const session = (await source.discover()).sessions[0]!;
    const first = await source.read(session);
    expect(
      first.events.some((event) => event.method === 'turn.completed'),
    ).toBe(false);
    const rest = await drain(source, session, first.cursor);
    expect(
      rest.events.filter((event) => event.method === 'turn.completed'),
    ).toMatchObject([{ finishReason: 'max-tokens' }]);
  });
});
