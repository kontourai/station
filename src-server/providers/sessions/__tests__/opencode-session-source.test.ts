import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { assembleTurnProvenanceEnvelopes } from '@kontourai/station-shared/turn-provenance-fold';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  AttachedSessionCursor,
  AttachedSessionDescriptor,
} from '../attached-session-source.js';
import { OpenCodeSessionSource } from '../opencode-session-source.js';
import { OPENCODE_SCHEMA, OpenCodeFixtureWriter } from './opencode-fixture.js';

const tempDir = trackTempDirs();
const writers: OpenCodeFixtureWriter[] = [];

function fixtureRoot(): string {
  return realpathSync(tempDir('station-opencode-'));
}

function writer(
  dataDir: string,
  fileName?: string,
  schema?: string,
): OpenCodeFixtureWriter {
  const created = new OpenCodeFixtureWriter(dataDir, fileName, schema);
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

/** One complete two-step turn: tool round trip, then the answer. */
function writeTurn(
  store: OpenCodeFixtureWriter,
  sessionId: string,
  prompt: string,
) {
  const user = store.user(sessionId, [
    prompt,
    { text: 'synthetic reminder', synthetic: true },
  ]);
  const first = store.assistant(sessionId, user, { finish: 'tool-calls' });
  store.part(sessionId, first, { type: 'step-start', snapshot: 'snap' });
  store.part(sessionId, first, {
    type: 'reasoning',
    text: 'Thinking about it.',
    time: { start: 1, end: 2 },
  });
  store.tool(sessionId, first, 'call-read', 'read', {
    status: 'completed',
    input: { filePath: '/workspace/a.txt' },
    output: 'file contents',
    title: 'a.txt',
    metadata: { preview: 'file contents' },
    time: { start: 1, end: 2 },
  });
  store.tool(sessionId, first, 'call-bash', 'bash', {
    status: 'error',
    input: { command: 'false' },
    error: 'exit status 1',
    time: { start: 1, end: 2 },
  });
  store.stepFinish(sessionId, first, {
    input: 100,
    output: 10,
    reasoning: 5,
    read: 1000,
    write: 50,
  });
  const second = store.assistant(sessionId, user, { finish: 'stop' });
  store.text(sessionId, second, 'First paragraph.');
  store.text(sessionId, second, 'Second paragraph.');
  store.stepFinish(sessionId, second, {
    input: 20,
    output: 30,
    reasoning: 0,
    read: 1100,
    write: 0,
  });
  return { user, first, second };
}

describe('OpenCodeSessionSource', () => {
  test('discovers a prompted top-level session and maps one turn to canonical events', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    store.session('ses_empty', '/workspace/project');
    store.session('ses_child', '/workspace/project', { parentId: 'ses_main' });
    store.session('ses_archived', '/workspace/project', { archived: true });
    for (const sessionId of ['ses_child', 'ses_archived']) {
      const user = store.user(sessionId, ['hidden']);
      store.assistant(sessionId, user, { finish: 'stop' });
    }
    const { user } = writeTurn(store, 'ses_main', 'Fix the bug');

    const source = new OpenCodeSessionSource({ dataDir });
    const discovery = await source.discover();
    expect(discovery.outcome).toBe('ok');
    expect(discovery.sessions).toHaveLength(1);
    const session = discovery.sessions[0]!;
    expect(session).toMatchObject({
      provider: 'opencode',
      sessionId: 'ses_main',
      cwd: '/workspace/project',
      affinity: { kind: 'opencode-data-home', ref: expect.any(String) },
    });
    expect(session.threadId).toMatch(/^external:opencode:[a-f0-9]{64}$/);
    expect(JSON.stringify(session)).not.toContain(dataDir);

    const result = await source.read(session);
    expect(result.outcome).toBe('ok');
    expect(
      result.events.map((event) => ({
        method: event.method,
        ...('turnId' in event ? { turnId: event.turnId } : {}),
      })),
    ).toEqual([
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
        arguments: { filePath: '/workspace/a.txt' },
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
    // Both steps of the turn, summed once at its close; completion counts
    // reasoning, which OpenCode stores apart from output.
    expect(byMethod('token-usage.updated')[0]).toMatchObject({
      promptTokens: 120,
      completionTokens: 45,
      cacheReadTokens: 2100,
      cacheWriteTokens: 50,
    });
    expect(byMethod('turn.completed')[0]).toMatchObject({
      finishReason: 'stop',
    });
    expect(new Set(result.events.map((event) => event.eventId)).size).toBe(
      result.events.length,
    );
    // The per-answer envelope shows OpenCode usage only because its scope is
    // declared per-turn; an undeclared engine reads as a disclosed gap.
    expect(
      assembleTurnProvenanceEnvelopes(result.events)[0]?.usage,
    ).toMatchObject({
      state: 'observed',
      value: { inputTokens: 120, outputTokens: 45 },
    });
    expect(await source.read(session, result.cursor)).toMatchObject({
      outcome: 'ok',
      events: [],
      cursor: result.cursor,
    });
  });

  test('resumes from its cursor across an event-limited page and a later turn without duplicates', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    writeTurn(store, 'ses_main', 'First');

    const whole = new OpenCodeSessionSource({ dataDir });
    const wholeSession = (await whole.discover()).sessions[0]!;
    const expected = (await whole.read(wholeSession)).events;

    const paged = new OpenCodeSessionSource({ dataDir, maxEvents: 3 });
    const session = (await paged.discover()).sessions[0]!;
    const first = await drain(paged, session);
    expect(first.events.map((event) => event.eventId)).toEqual(
      expected.map((event) => event.eventId),
    );

    const second = writeTurn(store, 'ses_main', 'Second');
    const resumed = await drain(paged, session, first.cursor);
    expect(
      resumed.events.filter((event) => event.method === 'turn.started'),
    ).toMatchObject([{ turnId: second.user, prompt: 'Second' }]);
    expect(
      resumed.events.filter((event) => event.method === 'turn.completed'),
    ).toHaveLength(1);
    const ids = [...first.events, ...resumed.events].map(
      (event) => event.eventId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('waits on an in-flight assistant message and imports it once OpenCode completes it', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const user = store.user('ses_main', ['Long task']);
    const running = store.assistant('ses_main', user, { completed: false });
    store.text('ses_main', running, 'partial answer');

    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const before = await source.read(session);
    expect(before.outcome).toBe('incomplete_tail');
    expect(before.events.map((event) => event.method)).toEqual([
      'turn.started',
    ]);

    store.completeAssistant('ses_main', running, user, 'stop');
    const after = await source.read(session, before.cursor);
    expect(after.events.map((event) => event.method)).toEqual([
      'content.text-delta',
      'turn.completed',
    ]);
  });

  test('a prompt queued during a reply does not settle the reply early', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const first = store.user('ses_main', ['First']);
    const running = store.assistant('ses_main', first, { completed: false });
    store.text('ses_main', running, 'Partial answer.');
    // OpenCode writes a queued prompt at once, before the reply finishes.
    const queued = store.user('ses_main', ['Queued']);

    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const before = await source.read(session);
    expect(before.outcome).toBe('incomplete_tail');
    expect(before.events.map((event) => event.method)).toEqual([
      'turn.started',
    ]);

    store.text('ses_main', running, 'REST-OF-ANSWER');
    store.stepFinish('ses_main', running, {
      input: 7,
      output: 3,
      reasoning: 0,
      read: 0,
      write: 0,
    });
    store.completeAssistant('ses_main', running, first, 'stop');
    const reply = store.assistant('ses_main', queued, { finish: 'stop' });
    store.text('ses_main', reply, 'Second answer.');
    const after = await drain(source, session, before.cursor);
    expect(
      after.events.map((event) => [
        event.method,
        'turnId' in event ? event.turnId : undefined,
        event.method === 'content.text-delta' ? event.delta : undefined,
      ]),
    ).toEqual([
      ['content.text-delta', first, 'Partial answer.'],
      ['content.text-delta', first, '\n\nREST-OF-ANSWER'],
      ['token-usage.updated', first, undefined],
      ['turn.completed', first, undefined],
      ['turn.started', queued, undefined],
      ['content.text-delta', queued, 'Second answer.'],
      ['turn.completed', queued, undefined],
    ]);
  });

  test('a later assistant message settles a reply whose writer died mid-write', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const first = store.user('ses_main', ['First']);
    const dead = store.assistant('ses_main', first, { completed: false });
    store.text('ses_main', dead, 'Cut off');
    const second = store.user('ses_main', ['Again']);
    const reply = store.assistant('ses_main', second, { finish: 'stop' });
    store.text('ses_main', reply, 'Done.');

    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const { events, outcomes } = await drain(source, session);
    expect(outcomes).not.toContain('incomplete_tail');
    expect(
      events
        .filter((event) => event.method === 'content.text-delta')
        .map((event) =>
          event.method === 'content.text-delta' ? event.delta : '',
        ),
    ).toEqual(['Cut off', 'Done.']);
  });

  test('counts reasoning once for current and OpenCode 1.3-era usage rows', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    const tokens = { input: 100, output: 40, reasoning: 15, read: 0, write: 0 };
    const cases = [
      // [session version, row shape, expected completion]
      ['1.18.18', 'current', 55],
      ['1.18.18', 'legacy', 40],
      ['1.3.13', 'legacy', 40],
      ['1.3.13', 'absent', 40],
      ['1.18.18', 'absent', 55],
    ] as const;
    for (const [index, [version, shape]] of cases.entries()) {
      const id = `ses_${index}`;
      store.session(id, '/workspace/project', { version });
      const user = store.user(id, ['Count']);
      const reply = store.assistant(id, user, { finish: 'stop' });
      store.stepFinish(id, reply, tokens, shape);
    }
    const source = new OpenCodeSessionSource({ dataDir });
    const sessions = (await source.discover()).sessions;
    for (const [index, [, , completion]] of cases.entries()) {
      const session = sessions.find(
        (item) => item.sessionId === `ses_${index}`,
      )!;
      const usage = (await source.read(session)).events.find(
        (event) => event.method === 'token-usage.updated',
      );
      expect(usage).toMatchObject({
        promptTokens: 100,
        completionTokens: completion,
      });
    }
  });

  test('holds no read snapshot across its yields, so OpenCode can truncate its WAL mid-read', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    writeTurn(store, 'ses_main', 'One');
    writeTurn(store, 'ses_main', 'Two');
    const checkpoints: Array<Record<string, unknown>> = [];
    const source = new OpenCodeSessionSource({
      dataDir,
      readYieldEveryMessages: 1,
      yieldFn: async () => {
        // The read is suspended mid-page: OpenCode commits and checkpoints.
        store.touch('ses_main');
        checkpoints.push(
          store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Record<
            string,
            unknown
          >,
        );
      },
    });
    const session = (await source.discover()).sessions[0]!;
    const result = await source.read(session);
    expect(
      result.events.filter((event) => event.method === 'turn.completed'),
    ).toHaveLength(2);
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of checkpoints) {
      expect(checkpoint).toMatchObject({ busy: 0 });
    }
  });

  test('holds a trailing user message until OpenCode answers it', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const user = store.user('ses_main', ['Queued question']);

    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const pending = await source.read(session);
    expect(pending).toMatchObject({ outcome: 'incomplete_tail', events: [] });

    const answer = store.assistant('ses_main', user, { finish: 'stop' });
    store.text('ses_main', answer, 'Answered.');
    const answered = await source.read(session, pending.cursor);
    expect(answered.events.map((event) => event.method)).toEqual([
      'turn.started',
      'content.text-delta',
      'turn.completed',
    ]);
  });

  test('maps an aborted message to turn.aborted and closes a turn superseded by the next prompt', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const first = store.user('ses_main', ['One']);
    store.assistant('ses_main', first, {
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
    });
    const second = store.user('ses_main', ['Two']);
    // Never completed; the next prompt shows OpenCode moved on.
    store.assistant('ses_main', second, { completed: false });
    const third = store.user('ses_main', ['Three']);
    const failed = store.assistant('ses_main', third, {
      error: { name: 'APIError', data: { message: 'rate limited' } },
    });
    void failed;

    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const { events } = await drain(source, session);
    expect(
      events.map((event) => [
        event.method,
        'turnId' in event ? event.turnId : undefined,
      ]),
    ).toEqual([
      ['turn.started', first],
      ['turn.aborted', first],
      ['turn.started', second],
      ['turn.completed', second],
      ['turn.started', third],
      ['runtime.error', third],
      ['turn.completed', third],
    ]);
    expect(events[1]).toMatchObject({ reason: 'Aborted' });
    expect(events[3]).toMatchObject({
      finishReason: 'other',
      metadata: { closedBy: 'next-prompt' },
    });
    expect(events[5]).toMatchObject({ message: 'rate limited' });
  });

  test('reports no sessions and logs nothing when OpenCode has no store', async () => {
    const warn = vi.fn();
    const root = fixtureRoot();
    const missingDir = new OpenCodeSessionSource({
      dataDir: join(root, 'absent'),
      warn,
    });
    expect(await missingDir.discover()).toEqual({
      outcome: 'missing_root',
      sessions: [],
    });
    mkdirSync(join(root, 'empty'));
    const emptyDir = new OpenCodeSessionSource({
      dataDir: join(root, 'empty'),
      warn,
    });
    expect(await emptyDir.discover()).toEqual({
      outcome: 'missing_root',
      sessions: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test('fails closed with one warning when the transcript tables change shape', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(
      dataDir,
      'opencode-stable.db',
      OPENCODE_SCHEMA.replace(
        '`data` text NOT NULL,\n\tCONSTRAINT `fk_part_message_id',
        '`data` text NOT NULL, `seq` integer,\n\tCONSTRAINT `fk_part_message_id',
      ),
    );
    store.session('ses_main', '/workspace/project');
    writeTurn(store, 'ses_main', 'Hello');
    const warn = vi.fn();
    const source = new OpenCodeSessionSource({ dataDir, warn });

    expect(await source.discover()).toEqual({
      outcome: 'rejected_candidate',
      sessions: [],
    });
    // OpenCode keeps writing; every later poll looks again and stays quiet.
    store.touch('ses_main');
    expect(await source.discover()).toEqual({
      outcome: 'rejected_candidate',
      sessions: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({
      database: 'opencode-stable.db',
      reason: 'unsupported_schema',
      detail: 'part:columns',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(dataDir);
  });

  test('rechecks the schema when OpenCode migrates a store it already read', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    writeTurn(store, 'ses_main', 'Hello');
    const warn = vi.fn();
    const source = new OpenCodeSessionSource({ dataDir, warn });
    expect((await source.discover()).sessions).toHaveLength(1);
    store.db.exec('ALTER TABLE part ADD COLUMN extra text');
    expect(await source.discover()).toEqual({
      outcome: 'rejected_candidate',
      sessions: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('fails closed when a required session column is missing', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    writer(
      dataDir,
      'opencode-stable.db',
      OPENCODE_SCHEMA.replace('\t`time_archived` integer, ', '\t'),
    );
    const warn = vi.fn();
    const source = new OpenCodeSessionSource({ dataDir, warn });
    expect((await source.discover()).outcome).toBe('rejected_candidate');
    expect(warn.mock.calls[0]![1]).toMatchObject({
      detail: 'session:missing:time_archived',
    });
  });

  test('refuses bounds past their ceilings and accepts the ceilings themselves', () => {
    for (const [name, ceiling] of [
      ['maxCandidates', 512],
      ['maxMessages', 512],
      ['maxEvents', 512],
      ['maxPartsPerMessage', 4096],
      ['readYieldEveryMessages', 512],
      ['maxBytes', 2 * 1024 * 1024],
    ] as const) {
      expect(
        () =>
          new OpenCodeSessionSource({ dataDir: '/absent', [name]: ceiling }),
      ).not.toThrow();
      expect(
        () =>
          new OpenCodeSessionSource({
            dataDir: '/absent',
            [name]: ceiling + 1,
          }),
      ).toThrow(RangeError);
      expect(
        () => new OpenCodeSessionSource({ dataDir: '/absent', [name]: 0 }),
      ).toThrow(RangeError);
    }
  });

  test('caps discovery at the candidate bound, keeping the most recently active sessions', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    for (const id of ['ses_a', 'ses_b', 'ses_c']) {
      store.session(id, '/workspace/project');
      const user = store.user(id, [id]);
      store.assistant(id, user, { finish: 'stop' });
    }
    store.touch('ses_a');
    const source = new OpenCodeSessionSource({ dataDir, maxCandidates: 2 });
    const discovery = await source.discover();
    expect(discovery.outcome).toBe('candidate_limit');
    expect(discovery.sessions.map((session) => session.sessionId)).toEqual([
      'ses_a',
      'ses_c',
    ]);
  });

  test('pages messages within the per-read message bound and omits an oversized part with a warning', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const user = store.user('ses_main', ['Big output']);
    const answer = store.assistant('ses_main', user, { finish: 'stop' });
    store.tool('ses_main', answer, 'call-big', 'read', {
      status: 'completed',
      input: {},
      output: 'x'.repeat(8 * 1024),
      title: 'big',
      metadata: {},
      time: { start: 1, end: 2 },
    });
    store.text('ses_main', answer, 'Done.');

    const source = new OpenCodeSessionSource({
      dataDir,
      maxMessages: 1,
      maxRowBytes: 4 * 1024,
    });
    const session = (await source.discover()).sessions[0]!;
    const first = await source.read(session);
    expect(first.outcome).toBe('byte_limit');
    expect(first.events.map((event) => event.method)).toEqual(['turn.started']);
    const second = await source.read(session, first.cursor);
    expect(second.outcome).toBe('line_limit');
    expect(second.events.map((event) => event.method)).toEqual([
      'content.text-delta',
      'runtime.warning',
      'turn.completed',
    ]);
    expect(second.events[1]).toMatchObject({
      code: 'external_record_bounded',
      details: { omittedPartCount: 1 },
    });
  });

  test('yields to the event loop between message batches of one read', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    writeTurn(store, 'ses_main', 'One');
    writeTurn(store, 'ses_main', 'Two');
    const yieldFn = vi.fn(async () => {});
    const source = new OpenCodeSessionSource({
      dataDir,
      readYieldEveryMessages: 2,
      yieldFn,
    });
    const session = (await source.discover()).sessions[0]!;
    const result = await source.read(session);
    expect(
      result.events.filter((event) => event.method === 'turn.completed'),
    ).toHaveLength(2);
    // Six messages: yields before the third and the fifth.
    expect(yieldFn).toHaveBeenCalledTimes(2);
  });

  test('sees a commit that leaves every file size and mtime unchanged', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    const user = store.user('ses_main', ['Question']);
    const running = store.assistant('ses_main', user, { completed: false });
    store.text('ses_main', running, 'Answer.');
    const checkpoint = () => store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const files = [store.path, `${store.path}-wal`];
    // One coarse clock tick for every write in this test.
    const tick = 1_790_000_000;
    const pinClock = () => {
      for (const file of files) utimesSync(file, tick, tick);
    };
    checkpoint();
    pinClock();
    const stats = files.map((file) => statSync(file));

    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    const first = await source.read(session);
    expect(first.outcome).toBe('incomplete_tail');

    // A coarse clock: the reply completes in place within one mtime tick.
    store.completeAssistant('ses_main', running, user, 'stop');
    checkpoint();
    pinClock();
    expect(files.map((file) => statSync(file).size)).toEqual(
      stats.map((stat) => stat.size),
    );
    expect(files.map((file) => statSync(file).mtimeMs)).toEqual(
      stats.map((stat) => stat.mtimeMs),
    );

    await source.discover();
    const second = await source.read(session, first.cursor);
    expect(second.events.map((event) => event.method)).toEqual([
      'content.text-delta',
      'turn.completed',
    ]);
  });

  test('reads a live WAL store without writing to it', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    writeTurn(store, 'ses_main', 'While the writer is open');

    // Committed but not checkpointed: only a WAL-aware reader sees it.
    const live = new OpenCodeSessionSource({ dataDir });
    const liveSession = (await live.discover()).sessions[0]!;
    expect(
      (await live.read(liveSession)).events.some(
        (event) => event.method === 'turn.completed',
      ),
    ).toBe(true);

    // The next poll's discovery releases the previous poll's connection.
    await live.discover();
    store.close();
    expect(existsSync(`${store.path}-wal`)).toBe(false);
    const digest = () =>
      createHash('sha256').update(readFileSync(store.path)).digest('hex');
    const before = digest();
    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    await drain(source, session);
    expect(digest()).toBe(before);
    // SQLite gives every WAL reader, read-only ones included, the -wal and
    // -shm files it needs; a reader appends no frames to the journal.
    const wal = `${store.path}-wal`;
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
  });

  test('rejects a cursor it did not write and a descriptor it did not discover', async () => {
    const dataDir = join(fixtureRoot(), 'opencode');
    const store = writer(dataDir);
    store.session('ses_main', '/workspace/project');
    writeTurn(store, 'ses_main', 'Hello');
    const source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    for (const cursor of [
      7,
      { offset: 1, sourceState: { version: 1 } },
      { offset: 0, sourceState: { version: 2 } },
      { offset: 0, sourceState: { version: 1, unknown: true } },
    ] as AttachedSessionCursor[]) {
      expect(await source.read(session, cursor)).toMatchObject({
        outcome: 'rejected_candidate',
        events: [],
        cursor,
      });
    }
    expect(
      await source.read({ ...session, sourceHandle: 'f'.repeat(64) }),
    ).toMatchObject({ outcome: 'unknown_source', events: [] });
  });
});
