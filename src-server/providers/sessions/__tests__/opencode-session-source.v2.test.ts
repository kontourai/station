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
import { OpenCodeFixtureWriter } from './opencode-fixture.js';
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
});
