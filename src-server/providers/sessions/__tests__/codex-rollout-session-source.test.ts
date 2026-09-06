import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldUsageEvents } from '@kontourai/station-shared/usage-fold';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AttachedSessionCursor } from '../attached-session-source.js';
import { CodexRolloutSessionSource } from '../codex-rollout-session-source.js';

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-codex-rollout-'));
  roots.push(root);
  return root;
}

function rolloutPath(root: string, name = 'rollout-a.jsonl'): string {
  const directory = join(root, 'sessions', '2026', '09', '06');
  mkdirSync(directory, { recursive: true });
  return join(directory, name);
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function meta(id = 'native-session', cwd = '/workspace'): unknown {
  return {
    timestamp: '2026-09-06T12:00:00.000Z',
    type: 'session_meta',
    payload: { id, session_id: id, cwd, source: 'cli' },
  };
}

function envelope(type: string, payload: Record<string, unknown>): unknown {
  return {
    timestamp: '2026-09-06T12:00:01.000Z',
    type,
    payload,
  };
}

async function discoverOne(source: CodexRolloutSessionSource) {
  const discovery = await source.discover();
  expect(discovery.sessions).toHaveLength(1);
  return discovery.sessions[0]!;
}

async function drain(
  source: CodexRolloutSessionSource,
  session: Awaited<ReturnType<typeof discoverOne>>,
  cursor: AttachedSessionCursor = 0,
) {
  const events = [];
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

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('CodexRolloutSessionSource', () => {
  test('maps pinned lifecycle, message, reasoning, tools, compaction, and cumulative usage without duplicate event messages', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    writeFileSync(
      path,
      [
        meta(),
        envelope('event_msg', { type: 'task_started', turn_id: 't1' }),
        envelope('event_msg', {
          type: 'user_message',
          message: 'question',
        }),
        envelope('response_item', {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'question' }],
        }),
        envelope('event_msg', {
          type: 'agent_message',
          message: 'answer',
        }),
        envelope('response_item', {
          type: 'message',
          id: 'message-1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'answer' }],
        }),
        envelope('response_item', {
          type: 'reasoning',
          id: 'reasoning-1',
          summary: [{ type: 'summary_text', text: 'public summary' }],
          content: [{ type: 'reasoning_text', text: 'private reasoning' }],
          encrypted_content: 'ciphertext',
        }),
        envelope('response_item', {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}',
        }),
        envelope('response_item', {
          type: 'function_call_output',
          call_id: 'call-1',
          output:
            '[{"type":"text","text":"/workspace"},{"type":"encrypted_content","encrypted_content":"ciphertext"}]',
        }),
        envelope('event_msg', {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 3,
              output_tokens: 5,
              total_tokens: 15,
            },
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
            },
            model_context_window: 200_000,
          },
        }),
        envelope('event_msg', { type: 'context_compacted' }),
        envelope('event_msg', { type: 'task_complete', turn_id: 't1' }),
        envelope('event_msg', { type: 'task_started', turn_id: 't2' }),
        envelope('event_msg', { type: 'user_message', message: 'again' }),
        envelope('event_msg', {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 22,
              cached_input_tokens: 7,
              output_tokens: 13,
              total_tokens: 35,
            },
            last_token_usage: {
              input_tokens: 12,
              output_tokens: 8,
              total_tokens: 20,
            },
            model_context_window: 200_000,
          },
        }),
        envelope('event_msg', {
          type: 'turn_aborted',
          turn_id: 't2',
          reason: 'interrupted',
        }),
      ]
        .map(line)
        .join(''),
    );
    const source = new CodexRolloutSessionSource({ homeDir: root });
    const session = await discoverOne(source);

    const result = await drain(source, session);
    expect(session).toMatchObject({
      provider: 'codex',
      sessionId: 'native-session',
      cwd: '/workspace',
    });
    expect(result.events.map((event) => event.method)).toEqual([
      'turn.started',
      'content.text-delta',
      'content.reasoning-delta',
      'tool.started',
      'tool.progress',
      'runtime.warning',
      'token-usage.updated',
      'extension.notification',
      'turn.completed',
      'turn.started',
      'token-usage.updated',
      'turn.aborted',
    ]);
    expect(result.events[0]).toMatchObject({
      turnId: 't1',
      prompt: 'question',
    });
    expect(
      result.events.filter((event) => event.method === 'content.text-delta'),
    ).toHaveLength(1);
    expect(result.events).not.toContainEqual(
      expect.objectContaining({ delta: 'private reasoning' }),
    );
    expect(result.events).not.toContainEqual(
      expect.objectContaining({ method: 'tool.completed' }),
    );
    expect(
      result.events.find(
        (event) =>
          event.method === 'runtime.warning' &&
          event.code === 'external_tool_result_status_unknown',
      ),
    ).toMatchObject({
      details: {
        toolCallId: 'call-1',
        toolName: 'exec_command',
        encryptedContentOmitted: true,
      },
    });
    expect(JSON.stringify(result.events)).not.toContain('ciphertext');
    const usage = result.events.filter(
      (event) => event.method === 'token-usage.updated',
    );
    expect(usage).toEqual([
      expect.objectContaining({
        turnId: 't1',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 3,
        contextWindowTokens: 200_000,
      }),
      expect.objectContaining({
        turnId: 't2',
        promptTokens: 22,
        completionTokens: 13,
        totalTokens: 35,
      }),
    ]);
    expect(foldUsageEvents(result.events)).toMatchObject({
      inputTokens: 22,
      outputTokens: 13,
      totalTokens: 35,
      cacheReadTokens: 7,
    });
  });

  test('retains tool names across pages and does not invent a verdict when rollout output omits one', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    writeFileSync(
      path,
      [
        meta(),
        envelope('event_msg', { type: 'task_started', turn_id: 't1' }),
        envelope('event_msg', { type: 'user_message', message: 'run' }),
        envelope('response_item', {
          type: 'custom_tool_call',
          call_id: 'call-1',
          name: 'shell',
          input: 'pwd',
        }),
      ]
        .map(line)
        .join(''),
    );
    const source = new CodexRolloutSessionSource({ homeDir: root });
    const session = await discoverOne(source);
    const first = await source.read(session);
    const unknownOutput = 'x'.repeat(6000);
    appendFileSync(
      path,
      line(
        envelope('response_item', {
          type: 'custom_tool_call_output',
          call_id: 'call-1',
          output: unknownOutput,
        }),
      ),
    );

    const second = await source.read(session, first.cursor);
    expect(second.events).toEqual([
      expect.objectContaining({
        method: 'tool.progress',
        turnId: 't1',
        toolCallId: 'call-1',
        message: unknownOutput,
      }),
      expect.objectContaining({
        method: 'runtime.warning',
        code: 'external_tool_result_status_unknown',
      }),
    ]);
    expect(second.events).not.toContainEqual(
      expect.objectContaining({ method: 'tool.completed' }),
    );
    expect(second.cursor).toMatchObject({
      sourceState: {
        version: 1,
        openTools: [{ callId: 'call-1', toolName: 'shell', turnId: 't1' }],
      },
    });
  });

  test('bounds escaped open-tool cursor state and reports every attribution eviction', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    const calls = Array.from({ length: 12 }, (_, index) =>
      envelope('response_item', {
        type: 'function_call',
        call_id: `${index}-${'\u0000'.repeat(180)}`,
        name: `tool-${'\u0000'.repeat(180)}`,
        arguments: '{}',
      }),
    );
    writeFileSync(
      path,
      [
        meta('tool-state'),
        envelope('event_msg', { type: 'task_started', turn_id: 't1' }),
        envelope('event_msg', { type: 'user_message', message: 'run many' }),
        ...calls,
      ]
        .map(line)
        .join(''),
    );
    const source = new CodexRolloutSessionSource({ homeDir: root });
    const session = await discoverOne(source);

    const result = await source.read(session);
    const cursor = result.cursor as Exclude<AttachedSessionCursor, number>;
    expect(
      Buffer.byteLength(JSON.stringify(cursor.sourceState)),
    ).toBeLessThanOrEqual(16 * 1024);
    expect(
      (cursor.sourceState?.openTools as unknown[] | undefined)?.length,
    ).toBeLessThan(calls.length);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        method: 'runtime.warning',
        code: 'external_tool_state_limit',
        details: expect.objectContaining({ omittedOpenToolCount: 1 }),
      }),
    );
  });

  test('paginates a line cut by the byte window without dropping it and resumes multi-event lines exactly once', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    const longAnswer = '😀'.repeat(50);
    writeFileSync(
      path,
      [
        meta('page'),
        envelope('event_msg', { type: 'task_started', turn_id: 't1' }),
        envelope('event_msg', { type: 'user_message', message: 'question' }),
        envelope('response_item', {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: longAnswer },
            { type: 'output_text', text: 'second block' },
          ],
        }),
        envelope('event_msg', { type: 'task_complete', turn_id: 't1' }),
      ]
        .map(line)
        .join(''),
    );
    const source = new CodexRolloutSessionSource({
      homeDir: root,
      maxBytes: 512,
      maxLineBytes: 480,
      maxEvents: 1,
    });
    const session = await discoverOne(source);

    const result = await drain(source, session);
    expect(result.outcomes).toContain('byte_limit');
    expect(result.events.map((event) => event.method)).toEqual([
      'turn.started',
      'content.text-delta',
      'content.text-delta',
      'turn.completed',
    ]);
    expect(
      result.events
        .filter((event) => event.method === 'content.text-delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe(`${longAnswer}second block`);
    expect(new Set(result.events.map((event) => event.eventId)).size).toBe(
      result.events.length,
    );
  });

  test('retains an exactly maximum-size line whose newline is just outside the byte window', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    const prefix = line(meta('exact-boundary'));
    const start = line(
      envelope('event_msg', {
        type: 'task_started',
        turn_id: 't1',
        padding: 'x'.repeat(256),
      }),
    );
    const maxLineBytes = Buffer.byteLength(start) - 1;
    writeFileSync(
      path,
      prefix +
        start +
        line(
          envelope('event_msg', { type: 'user_message', message: 'retained' }),
        ),
    );
    const source = new CodexRolloutSessionSource({
      homeDir: root,
      maxBytes: Buffer.byteLength(prefix) + maxLineBytes,
      maxLineBytes,
    });
    const session = await discoverOne(source);
    const result = await drain(source, session);
    expect(result.outcomes).not.toContain('line_limit');
    expect(result.events).toMatchObject([
      { method: 'turn.started', prompt: 'retained', turnId: 't1' },
    ]);
  });

  test('keeps an incomplete line at its start and imports it once after newline append', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    const partial = JSON.stringify(
      envelope('event_msg', { type: 'task_started', turn_id: 't1' }),
    );
    writeFileSync(path, line(meta('partial')) + partial);
    const source = new CodexRolloutSessionSource({ homeDir: root });
    const session = await discoverOne(source);

    const first = await source.read(session);
    expect(first.outcome).toBe('incomplete_tail');
    expect(first.events).toEqual([]);
    appendFileSync(
      path,
      `\n${line(envelope('event_msg', { type: 'user_message', message: 'go' }))}`,
    );
    const second = await source.read(session, first.cursor);
    expect(second.events).toEqual([
      expect.objectContaining({ method: 'turn.started', prompt: 'go' }),
    ]);
    const third = await source.read(session, second.cursor);
    expect(third.events).toEqual([]);
  });

  test('skips one oversized line through bounded windows and reaches the next complete record', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    writeFileSync(
      path,
      line(meta('oversize')) +
        `${JSON.stringify({ blob: 'x'.repeat(900) })}\n` +
        line(envelope('event_msg', { type: 'task_started', turn_id: 't1' })) +
        line(envelope('event_msg', { type: 'user_message', message: 'after' })),
    );
    const source = new CodexRolloutSessionSource({
      homeDir: root,
      maxBytes: 256,
      maxLineBytes: 180,
    });
    const session = await discoverOne(source);

    const result = await drain(source, session);
    expect(result.outcomes).toContain('line_limit');
    expect(result.events).toEqual([
      expect.objectContaining({ method: 'turn.started', prompt: 'after' }),
    ]);
  });

  test('rejects stale descriptors, replaced files, nonzero legacy cursors, and invalid source parser state', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    writeFileSync(path, line(meta('identity')));
    const source = new CodexRolloutSessionSource({ homeDir: root });
    const session = await discoverOne(source);

    expect(await source.read({ ...session, cwd: '/different' })).toMatchObject({
      outcome: 'unknown_source',
      events: [],
    });
    expect(await source.read(session, 1)).toMatchObject({
      outcome: 'rejected_candidate',
      events: [],
    });
    expect(
      await source.read(session, {
        offset: 0,
        sourceState: { version: 1, openTools: [{ callId: 'duplicate' }] },
      }),
    ).toMatchObject({ outcome: 'rejected_candidate', events: [] });

    rmSync(path);
    writeFileSync(path, line(meta('replacement')));
    expect(await source.read(session)).toMatchObject({
      outcome: 'rejected_candidate',
      events: [],
    });
  });

  test('keeps identical native IDs in separate Codex homes and rejects symlink traversal', async () => {
    const firstRoot = fixtureRoot();
    const secondRoot = fixtureRoot();
    writeFileSync(rolloutPath(firstRoot), line(meta('same-native-id')));
    writeFileSync(rolloutPath(secondRoot), line(meta('same-native-id')));
    const firstSource = new CodexRolloutSessionSource({ homeDir: firstRoot });
    const secondSource = new CodexRolloutSessionSource({ homeDir: secondRoot });
    const firstSession = await discoverOne(firstSource);
    const secondSession = await discoverOne(secondSource);
    expect(firstSession.threadId).not.toBe(secondSession.threadId);
    expect(firstSession.sourceHandle).not.toBe(secondSession.sourceHandle);

    const outside = rolloutPath(secondRoot, 'outside.jsonl');
    const link = rolloutPath(firstRoot, 'linked.jsonl');
    symlinkSync(outside, link);
    const discovery = await firstSource.discover();
    expect(discovery.outcome).toBe('rejected_candidate');
    expect(discovery.sessions).toHaveLength(1);
  });

  test('bounds traversal, yields while parsing, and rejects unsafe option expansion', async () => {
    const root = fixtureRoot();
    const older = rolloutPath(root, 'a.jsonl');
    const newerDirectory = join(root, 'sessions', '2027', '01', '01');
    mkdirSync(newerDirectory, { recursive: true });
    const newer = join(newerDirectory, 'b.jsonl');
    writeFileSync(older, line(meta('a')));
    writeFileSync(newer, line(meta('b')));
    utimesSync(older, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    utimesSync(newer, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
    const discovery = await new CodexRolloutSessionSource({
      homeDir: root,
      maxCandidates: 1,
    }).discover();
    expect(discovery.outcome).toBe('candidate_limit');
    expect(discovery.sessions).toHaveLength(1);
    expect(discovery.sessions[0]?.sessionId).toBe('b');

    const yieldFn = vi.fn(async () => undefined);
    const source = new CodexRolloutSessionSource({
      homeDir: root,
      readYieldEveryLines: 1,
      yieldFn,
    });
    const session = (await source.discover()).sessions[0]!;
    await source.read(session);
    expect(yieldFn).toHaveBeenCalled();
    expect(
      () =>
        new CodexRolloutSessionSource({
          homeDir: root,
          maxBytes: 2 * 1024 * 1024 + 1,
        }),
    ).toThrow(/maxBytes/);
    expect(
      () => new CodexRolloutSessionSource({ homeDir: root, maxEvents: 0 }),
    ).toThrow(/maxEvents/);
    expect(
      () =>
        new CodexRolloutSessionSource({
          homeDir: root,
          maxBytes: 256,
          maxLineBytes: 256,
        }),
    ).toThrow(/maxLineBytes/);

    const traversal = await new CodexRolloutSessionSource({
      homeDir: root,
      maxTraversalEntries: 1,
    }).discover();
    expect(traversal).toMatchObject({
      outcome: 'candidate_limit',
      sessions: [],
    });
    expect(
      await new CodexRolloutSessionSource({
        homeDir: join(root, 'missing'),
      }).discover(),
    ).toEqual({ outcome: 'missing_root', sessions: [] });
  });

  test('reports malformed records while continuing to later complete records', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    writeFileSync(
      path,
      line(meta('malformed')) +
        '{bad json}\n' +
        line(envelope('event_msg', { type: 'task_started', turn_id: 't1' })) +
        line(envelope('event_msg', { type: 'user_message', message: 'valid' })),
    );
    const source = new CodexRolloutSessionSource({ homeDir: root });
    const session = await discoverOne(source);

    const result = await source.read(session);
    expect(result.outcome).toBe('malformed_record');
    expect(result.events).toEqual([
      expect.objectContaining({ method: 'turn.started', prompt: 'valid' }),
    ]);
  });

  test('chunks large visible text into ingress-safe deterministic events and marks prompt truncation', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    const large = '😀'.repeat(12_000);
    const escapedPrompt = '\u0000'.repeat(20_000);
    writeFileSync(
      path,
      [
        meta('large'),
        envelope('event_msg', { type: 'task_started', turn_id: 't1' }),
        envelope('event_msg', {
          type: 'user_message',
          message: escapedPrompt,
        }),
        envelope('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: large }],
        }),
      ]
        .map(line)
        .join(''),
    );
    const source = new CodexRolloutSessionSource({ homeDir: root });
    const session = await discoverOne(source);

    const result = await source.read(session);
    const started = result.events.find(
      (event) => event.method === 'turn.started',
    );
    expect(started).toMatchObject({
      metadata: { sourceTextTruncated: true, source: 'codex-rollout' },
    });
    expect(
      Buffer.byteLength(
        started?.method === 'turn.started' ? (started.prompt ?? '') : '',
      ),
    ).toBeLessThan(escapedPrompt.length);
    const textEvents = result.events.filter(
      (event) => event.method === 'content.text-delta',
    );
    expect(textEvents.length).toBeGreaterThan(1);
    expect(textEvents.map((event) => event.delta).join('')).toBe(large);
    expect(
      result.events.every(
        (event) => Buffer.byteLength(JSON.stringify(event)) < 64 * 1024,
      ),
    ).toBe(true);
  });
});
