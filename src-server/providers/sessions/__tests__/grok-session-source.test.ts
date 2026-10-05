import {
  appendFileSync,
  mkdirSync,
  realpathSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  AttachedSessionCursor,
  AttachedSessionDescriptor,
} from '../attached-session-source.js';
import { GrokSessionSource } from '../grok-session-source.js';
import {
  BASE_MS,
  grokSession,
  oneTurn,
  sessionDir,
  Writer,
  writeSummary,
} from './grok-session-fixtures.js';

const makeTempDir = trackTempDirs();

function fixtureRoot(): string {
  return realpathSync(makeTempDir('station-grok-'));
}

async function discoverOne(source: GrokSessionSource) {
  const discovery = await source.discover();
  expect(discovery.sessions).toHaveLength(1);
  return discovery.sessions[0]!;
}

async function drain(
  source: GrokSessionSource,
  session: AttachedSessionDescriptor,
  cursor: AttachedSessionCursor = 0,
) {
  const events = [];
  const outcomes: string[] = [];
  for (let page = 0; page < 128; page += 1) {
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

describe('GrokSessionSource', () => {
  test('missing Grok home or sessions directory yields no sessions', async () => {
    const root = fixtureRoot();
    await expect(
      new GrokSessionSource({ homeDir: join(root, 'absent') }).discover(),
    ).resolves.toEqual({ outcome: 'missing_root', sessions: [] });
    mkdirSync(join(root, 'grok'));
    await expect(
      new GrokSessionSource({ homeDir: join(root, 'grok') }).discover(),
    ).resolves.toEqual({ outcome: 'missing_root', sessions: [] });
  });

  test('takes cwd from summary.json even when the directory name is the lossy long-path form', async () => {
    const home = fixtureRoot();
    const cwd = `/work/${'deep/'.repeat(60)}project`;
    const { sessionId } = grokSession(home, {
      cwd,
      // Grok's encoded-name fallback for >255 bytes: slug plus hash.
      dirName: 'project-0123456789abcdef',
    });
    const session = await discoverOne(new GrokSessionSource({ homeDir: home }));
    expect(session).toMatchObject({
      provider: 'grok-build',
      sessionId,
      cwd,
      createdAt: '2026-09-17T16:15:00.123Z',
      affinity: { kind: 'grok-config-home', ref: expect.any(String) },
    });
    expect(session.threadId).toMatch(/^external:grok-build:[a-f0-9]{64}$/);
    expect(JSON.stringify(session)).not.toContain(home);
  });

  test('lists only prompted top-level sessions, newest first', async () => {
    const home = fixtureRoot();
    const probe = new Writer('probe-session');
    grokSession(home, {
      sessionId: 'probe-session',
      cwd: '/station/runtime/acp-workspaces/probe/abc',
      lines: probe.hook(),
    });
    // A session directory that has no log yet.
    sessionDir(home, '/work/empty', 'empty-session');
    const child = new Writer('child-session');
    grokSession(home, {
      sessionId: 'child-session',
      lines: child.user('Explore', 0),
      summary: { session_kind: 'subagent' },
    });
    const older = grokSession(home, { sessionId: 'older-session' });
    const newer = grokSession(home, { sessionId: 'newer-session' });
    utimesSync(older.dir, new Date(BASE_MS), new Date(BASE_MS));
    utimesSync(
      newer.dir,
      new Date(BASE_MS + 60_000),
      new Date(BASE_MS + 60_000),
    );

    const discovery = await new GrokSessionSource({ homeDir: home }).discover();
    expect(discovery.outcome).toBe('ok');
    expect(discovery.sessions.map((session) => session.sessionId)).toEqual([
      'newer-session',
      'older-session',
    ]);
  });

  test('a probe that later receives a prompt is listed on the next poll', async () => {
    const home = fixtureRoot();
    const writer = new Writer('late-session');
    const { file, dir } = grokSession(home, {
      sessionId: 'late-session',
      lines: writer.hook(),
    });
    const source = new GrokSessionSource({ homeDir: home });
    expect((await source.discover()).sessions).toEqual([]);
    appendFileSync(file, writer.user('Now a question', 0));
    // Grok renames a fresh summary.json into the directory on each update.
    utimesSync(dir, new Date(BASE_MS + 5000), new Date(BASE_MS + 5000));
    expect((await source.discover()).sessions).toHaveLength(1);
  });

  test('maps prompts, reasoning, messages, tools, plans, usage and completion', async () => {
    const home = fixtureRoot();
    const sessionId = 'mapped-session';
    const w = new Writer(sessionId);
    const lines =
      w.hook() +
      w.user('First part', 0) +
      w.user('Second part', 0) +
      w.thought('Considering') +
      w.message('Looking now.') +
      w.toolCall('call-1', 'run_terminal_cmd', { command: 'ls' }) +
      w.toolBackfill('call-1', { command: 'ls', description: 'list' }) +
      w.toolResult('call-1', 'completed', 'file-a') +
      w.toolCall('call-2', 'read_file', { target_file: 'missing' }) +
      w.toolResult('call-2', 'failed', 'not found') +
      w.plan([
        { content: 'Step one', status: 'completed' },
        { content: 'Step two', status: 'in_progress' },
      ]) +
      w.message('Done.') +
      w.turnCompleted() +
      w.user('Wake up', 1, { hideFromScrollback: true }) +
      w.message('Background task finished.') +
      w.compaction() +
      w.turnCompleted('cancelled');
    grokSession(home, { sessionId, lines });
    const source = new GrokSessionSource({ homeDir: home });
    const session = await discoverOne(source);
    const { events, outcomes } = await drain(source, session);
    expect(outcomes.at(-1)).toBe('ok');
    const firstTurn = `${sessionId}-2`;
    const secondTurn = `${sessionId}-14`;
    expect(events.map((event) => event.method)).toEqual([
      'turn.started',
      'content.reasoning-delta',
      'content.text-delta',
      'tool.started',
      'tool.completed',
      'tool.started',
      'tool.completed',
      'plan.updated',
      'content.text-delta',
      'token-usage.updated',
      'turn.completed',
      'turn.started',
      'content.text-delta',
      'extension.notification',
      'token-usage.updated',
      'turn.completed',
    ]);
    expect(events[0]).toMatchObject({
      provider: 'grok-build',
      threadId: session.threadId,
      turnId: firstTurn,
      prompt: 'First part\n\nSecond part',
      createdAt: new Date(BASE_MS + 2000).toISOString(),
    });
    expect(events[2]).toMatchObject({ delta: 'Looking now.' });
    expect(events[3]).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'run_terminal_cmd',
      toolKind: 'execute',
      arguments: { command: 'ls' },
    });
    expect(events[4]).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'run_terminal_cmd',
      status: 'success',
      output: 'file-a',
    });
    expect(events[6]).toMatchObject({
      toolCallId: 'call-2',
      toolName: 'read_file',
      status: 'error',
      output: 'not found',
    });
    expect(events[7]).toMatchObject({
      entries: [
        { content: 'Step one', status: 'completed' },
        { content: 'Step two', status: 'in_progress' },
      ],
    });
    // A later message in the same turn opens a paragraph.
    expect(events[8]).toMatchObject({ delta: '\n\nDone.' });
    expect(events[9]).toMatchObject({
      turnId: firstTurn,
      promptTokens: 1200,
      completionTokens: 80,
      totalTokens: 1280,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
    });
    expect(events[10]).toMatchObject({
      turnId: firstTurn,
      finishReason: 'stop',
    });
    expect(events[11]).toMatchObject({
      turnId: secondTurn,
      metadata: { hiddenInput: true },
    });
    expect(events[11]).not.toHaveProperty('prompt');
    // The new turn's first message opens no paragraph.
    expect(events[12]).toMatchObject({ delta: 'Background task finished.' });
    expect(events[13]).toMatchObject({
      namespace: 'grok-session',
      type: 'context-compacted',
    });
    expect(events[15]).toMatchObject({
      turnId: secondTurn,
      finishReason: 'cancelled',
    });
    expect(new Set(events.map((event) => event.eventId)).size).toBe(
      events.length,
    );
  });

  test('an interjection after activity is a steer on the open turn', async () => {
    const home = fixtureRoot();
    const w = new Writer('steer-session');
    grokSession(home, {
      sessionId: 'steer-session',
      lines:
        w.user('Start', 0) +
        w.message('Working.') +
        w.user('Also check tests', 0, { interjection: true }) +
        w.turnCompleted(),
    });
    const source = new GrokSessionSource({ homeDir: home });
    const { events } = await drain(source, await discoverOne(source));
    const starts = events.filter((event) => event.method === 'turn.started');
    expect(starts).toMatchObject([
      { turnId: 'steer-session-1', prompt: 'Start' },
      {
        turnId: 'steer-session-1',
        inputKind: 'steer',
        prompt: 'Also check tests',
      },
    ]);
  });

  test('resumes from its byte cursor after an append without replaying events', async () => {
    const home = fixtureRoot();
    const { sessionId, file, writer } = grokSession(home, {
      sessionId: 'resume-session',
      lines: '',
    });
    writeFileSync(file, oneTurn(writer, 'One', 'Answer one'));
    const source = new GrokSessionSource({ homeDir: home });
    const session = await discoverOne(source);
    const first = await drain(source, session);
    expect(first.events.map((event) => event.method)).toEqual([
      'turn.started',
      'content.text-delta',
      'token-usage.updated',
      'turn.completed',
    ]);

    appendFileSync(file, oneTurn(writer, 'Two', 'Answer two'));
    const restarted = new GrokSessionSource({ homeDir: home });
    const again = await discoverOne(restarted);
    expect(again.sessionId).toBe(sessionId);
    const second = await drain(restarted, again, first.cursor);
    expect(second.events).toMatchObject([
      { method: 'turn.started', prompt: 'Two' },
      { method: 'content.text-delta', delta: 'Answer two' },
      { method: 'token-usage.updated' },
      { method: 'turn.completed' },
    ]);
    const ids = new Set(first.events.map((event) => event.eventId));
    expect(second.events.some((event) => ids.has(event.eventId))).toBe(false);
  });

  test('event and byte pages reproduce the unbounded event sequence exactly', async () => {
    const home = fixtureRoot();
    const w = new Writer('paged-session');
    const lines =
      w.user('Long', 0) +
      w.thought('a'.repeat(300)) +
      w.message('b'.repeat(300)) +
      w.toolCall('call-1', 'run_terminal_cmd', { command: 'x' }) +
      w.toolResult('call-1', 'completed', 'c'.repeat(120)) +
      w.turnCompleted();
    grokSession(home, { sessionId: 'paged-session', lines });
    const unbounded = new GrokSessionSource({ homeDir: home });
    const expected = (await drain(unbounded, await discoverOne(unbounded)))
      .events;
    const paged = new GrokSessionSource({
      homeDir: home,
      maxEvents: 1,
      maxBytes: 1024,
      maxLineBytes: 1023,
    });
    const actual = await drain(paged, await discoverOne(paged));
    expect(actual.outcomes).toContain('byte_limit');
    expect(actual.events).toEqual(expected);
  });

  test('waits for a torn last line and imports it once its newline lands', async () => {
    const home = fixtureRoot();
    const w = new Writer('torn-session');
    const answer = w.message('Complete answer');
    const { file } = grokSession(home, {
      sessionId: 'torn-session',
      lines: w.user('Ask', 0) + answer.slice(0, 40),
    });
    const source = new GrokSessionSource({ homeDir: home });
    const session = await discoverOne(source);
    const first = await drain(source, session);
    expect(first.outcomes.at(-1)).toBe('incomplete_tail');
    expect(first.events).toEqual([]);
    appendFileSync(file, answer.slice(40));
    const second = await drain(source, session, first.cursor);
    expect(second.events).toMatchObject([
      { method: 'turn.started', prompt: 'Ask' },
      { method: 'content.text-delta', delta: 'Complete answer' },
    ]);
  });

  test('skips an oversized line with a reported limit and keeps reading', async () => {
    const home = fixtureRoot();
    const w = new Writer('large-session');
    grokSession(home, {
      sessionId: 'large-session',
      lines:
        w.user('Ask', 0) +
        w.toolCall('call-1', 'read_file', { target_file: 'big' }) +
        w.toolResult('call-1', 'completed', 'z'.repeat(4096)) +
        w.message('After'),
    });
    const source = new GrokSessionSource({
      homeDir: home,
      maxBytes: 1024,
      maxLineBytes: 1023,
    });
    const { events, outcomes } = await drain(source, await discoverOne(source));
    expect(outcomes).toContain('line_limit');
    expect(events.map((event) => event.method)).toEqual([
      'turn.started',
      'tool.started',
      'content.text-delta',
    ]);
  });

  test('caps candidates and uncached inspections, reporting the limit', async () => {
    const home = fixtureRoot();
    for (let index = 0; index < 4; index += 1) {
      const { dir } = grokSession(home, { sessionId: `session-${index}` });
      const at = new Date(BASE_MS + index * 1000);
      utimesSync(dir, at, at);
    }
    const capped = await new GrokSessionSource({
      homeDir: home,
      maxCandidates: 2,
    }).discover();
    expect(capped.outcome).toBe('candidate_limit');
    expect(capped.sessions.map((session) => session.sessionId)).toEqual([
      'session-3',
      'session-2',
    ]);

    const throttled = new GrokSessionSource({
      homeDir: home,
      maxInspections: 3,
    });
    const first = await throttled.discover();
    expect(first.outcome).toBe('candidate_limit');
    expect(first.sessions).toHaveLength(3);
    const second = await throttled.discover();
    expect(second.outcome).toBe('ok');
    expect(second.sessions).toHaveLength(4);

    const traversal = await new GrokSessionSource({
      homeDir: home,
      maxTraversalEntries: 3,
    }).discover();
    expect(traversal.outcome).toBe('candidate_limit');
  });

  test('an unrecognized log format is skipped with one warning, not guessed', async () => {
    const home = fixtureRoot();
    for (const id of ['foreign-a', 'foreign-b']) {
      grokSession(home, {
        sessionId: id,
        lines: `${JSON.stringify({ type: 'user', text: 'Hello' })}\n`,
      });
    }
    const warnings: unknown[] = [];
    const source = new GrokSessionSource({
      homeDir: home,
      logger: { warn: (...args) => warnings.push(args) },
    });
    const first = await source.discover();
    expect(first).toEqual({ outcome: 'malformed_record', sessions: [] });
    await source.discover();
    expect(warnings).toHaveLength(1);
  });

  test('a summary whose id does not name its directory is skipped as unrecognized', async () => {
    const home = fixtureRoot();
    const { dir } = grokSession(home, { sessionId: 'named-session' });
    writeSummary(dir, { id: 'other-session', cwd: '/work/project' });
    const warnings: unknown[] = [];
    const discovery = await new GrokSessionSource({
      homeDir: home,
      logger: { warn: (...args) => warnings.push(args) },
    }).discover();
    expect(discovery).toEqual({ outcome: 'malformed_record', sessions: [] });
    expect(warnings).toHaveLength(1);
  });

  test('reports a malformed middle line and continues past it', async () => {
    const home = fixtureRoot();
    const w = new Writer('broken-session');
    grokSession(home, {
      sessionId: 'broken-session',
      lines: `${w.user('Ask', 0)}{"timestamp":1,"method":\n${w.message('Still here')}`,
    });
    const source = new GrokSessionSource({ homeDir: home });
    const { events, outcomes } = await drain(source, await discoverOne(source));
    expect(outcomes).toContain('malformed_record');
    expect(events.map((event) => event.method)).toEqual([
      'turn.started',
      'content.text-delta',
    ]);
  });

  test('rejects stale handles, replaced logs and nonzero bare cursors', async () => {
    const home = fixtureRoot();
    const { file, writer } = grokSession(home, { sessionId: 'swap-session' });
    const source = new GrokSessionSource({ homeDir: home });
    const session = await discoverOne(source);
    await expect(
      new GrokSessionSource({ homeDir: home }).read(session),
    ).resolves.toMatchObject({ outcome: 'unknown_source', events: [] });
    await expect(source.read(session, 5)).resolves.toMatchObject({
      outcome: 'rejected_candidate',
      cursor: 5,
    });
    const replacement = `${file}.next`;
    writeFileSync(replacement, writer.user('Replaced', 0));
    renameSync(replacement, file);
    await expect(source.read(session)).resolves.toMatchObject({
      outcome: 'rejected_candidate',
      events: [],
    });
  });

  test('names the Grok session a Station ACP session owns', () => {
    const source = new GrokSessionSource({ homeDir: fixtureRoot() });
    expect(
      source.ownedNativeSessionId({
        provider: 'acp',
        resumeCursor: { acpSessionId: 'native-1', connectionId: 'grok-build' },
      }),
    ).toBe('native-1');
    expect(
      source.ownedNativeSessionId({
        provider: 'claude',
        resumeCursor: { acpSessionId: 'native-1' },
      }),
    ).toBeUndefined();
    expect(
      source.ownedNativeSessionId({
        provider: 'acp',
        resumeCursor: 'native-1',
      }),
    ).toBeUndefined();
  });
});
