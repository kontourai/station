import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { projectSessionLifecycle } from '../../../services/orchestration/session-lifecycle-service.js';
import { ClaudeTranscriptSessionSource } from '../claude-transcript-session-source.js';

const dirs: string[] = [];

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-claude-transcript-'));
  dirs.push(dir);
  return dir;
}

function record(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('ClaudeTranscriptSessionSource', () => {
  test('exposes its stable source-owned kind', () => {
    const source = new ClaudeTranscriptSessionSource({
      configDir: fixtureDir(),
    });

    expect(source.provider).toBe('claude');
    expect(source.kind).toBe('claude-transcript');
  });

  test('emits byte-real Claude per-message usage, cache split, service tier, and request ID', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    // Redacted excerpt from ~/.claude/projects: values and nesting are verbatim;
    // only free text, paths, and opaque IDs are replaced.
    const transcript = join(directory, 'session-a.jsonl');
    writeFileSync(
      transcript,
      record({
        parentUuid: '233c5e72-a261-4ac3-9f4e-2fef3dbe2b0c',
        isSidechain: false,
        type: 'assistant',
        uuid: '119453a0-76b4-410c-9944-baf757dd695a',
        sessionId: 'cb771699-62d0-4f9e-a45c-0fb7d150d1bb',
        session_id: 'cb771699-62d0-4f9e-a45c-0fb7d150d1bb',
        requestId: 'req_011CdNzSXpFPWrt6sxtKNmEX',
        cwd: '[redacted]',
        timestamp: '2026-07-25T15:12:16.410Z',
        effort: 'high',
        userType: 'external',
        entrypoint: 'cli',
        version: '2.1.220',
        gitBranch: 'HEAD',
        message: {
          model: 'claude-opus-5',
          id: 'msg_011CdNzSZtX5vLk9qMo9gVwF',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '[redacted]' }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 44785,
            cache_read_input_tokens: 0,
            output_tokens: 132,
            server_tool_use: {
              web_search_requests: 0,
              web_fetch_requests: 0,
            },
            service_tier: 'standard',
            cache_creation: {
              ephemeral_1h_input_tokens: 44785,
              ephemeral_5m_input_tokens: 0,
            },
            inference_geo: 'not_available',
            iterations: [
              {
                input_tokens: 2,
                output_tokens: 132,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 44785,
                cache_creation: {
                  ephemeral_5m_input_tokens: 0,
                  ephemeral_1h_input_tokens: 44785,
                },
                type: 'message',
              },
            ],
            speed: 'standard',
          },
          diagnostics: null,
        },
      }),
    );
    writeFileSync(
      transcript,
      record({
        type: 'system',
        subtype: 'turn_duration',
        uuid: 'turn-complete',
        sessionId: 'cb771699-62d0-4f9e-a45c-0fb7d150d1bb',
        timestamp: '2026-07-25T15:12:17.410Z',
      }),
      { flag: 'a' },
    );
    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const [session] = (await source.discover()).sessions;

    const result = await source.read(session);

    expect(
      result.events.find((event) => event.method === 'token-usage.updated'),
    ).toMatchObject({
      method: 'token-usage.updated',
      turnId: '233c5e72-a261-4ac3-9f4e-2fef3dbe2b0c',
      promptTokens: 2,
      completionTokens: 132,
      totalTokens: 134,
      cacheReadTokens: 0,
      cacheWriteTokens: 44785,
      cacheWriteTokens5m: 0,
      cacheWriteTokens1h: 44785,
      serviceTier: 'standard',
    });
  });

  test('preserves absent assistant usage as no usage event rather than zero-filled usage', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    // Derived from the byte-real excerpt above by removing only `message.usage`:
    // current local transcripts have no assistant records with absent usage.
    writeFileSync(
      join(directory, 'session-a.jsonl'),
      [
        {
          type: 'assistant',
          uuid: 'assistant-with-usage',
          sessionId: 'session-a',
          cwd: '[redacted]',
          timestamp: '2026-07-12T16:59:19.303Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '[redacted]' }],
            usage: { input_tokens: 2, output_tokens: 154 },
          },
        },
        {
          type: 'assistant',
          uuid: 'assistant-without-usage',
          sessionId: 'session-a',
          cwd: '[redacted]',
          timestamp: '2026-07-12T16:59:20.303Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '[redacted]' }],
          },
        },
        {
          type: 'system',
          subtype: 'turn_duration',
          uuid: 'turn-complete',
          sessionId: 'session-a',
          timestamp: '2026-07-12T16:59:21.303Z',
        },
      ]
        .map(record)
        .join(''),
    );
    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const [session] = (await source.discover()).sessions;

    const result = await source.read(session);

    expect(result.events.map((event) => event.method)).toEqual([
      'content.text-delta',
      'content.text-delta',
      'token-usage.updated',
      'turn.completed',
    ]);
    expect(
      result.events.filter((event) => event.method === 'token-usage.updated'),
    ).toEqual([
      expect.objectContaining({
        promptTokens: 2,
        completionTokens: 154,
        totalTokens: 156,
      }),
    ]);
  });

  test('keeps split and whole reads equivalent when the next user record closes a multi-record turn', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    const transcript = join(directory, 'session-a.jsonl');
    // Redacted local-transcript shapes and usage values; paths, prose, host,
    // repository, and opaque identifiers are replaced.
    const first = [
      {
        type: 'user',
        uuid: 'turn-1',
        sessionId: 'session-a',
        cwd: '[redacted]',
        timestamp: '2026-07-25T15:12:00.000Z',
        message: { role: 'user', content: '[redacted]' },
      },
      {
        type: 'assistant',
        uuid: 'call-1',
        sessionId: 'session-a',
        timestamp: '2026-07-25T15:12:01.000Z',
        message: {
          content: [{ type: 'text', text: '[redacted]' }],
          usage: {
            input_tokens: 2,
            output_tokens: 132,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 44785,
            cache_creation: {
              ephemeral_5m_input_tokens: 0,
              ephemeral_1h_input_tokens: 44785,
            },
            service_tier: 'standard',
          },
        },
      },
      {
        type: 'assistant',
        uuid: 'call-2',
        sessionId: 'session-a',
        timestamp: '2026-07-25T15:12:02.000Z',
        message: {
          content: [{ type: 'text', text: '[redacted]' }],
          usage: {
            input_tokens: 3,
            output_tokens: 4,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 6,
            cache_creation: {
              ephemeral_5m_input_tokens: 7,
              ephemeral_1h_input_tokens: 8,
            },
            service_tier: 'standard',
          },
        },
      },
    ]
      .map(record)
      .join('');
    const second = [
      {
        type: 'user',
        uuid: 'turn-2',
        sessionId: 'session-a',
        cwd: '[redacted]',
        timestamp: '2026-07-25T15:12:03.000Z',
        message: { role: 'user', content: 'next question' },
      },
    ]
      .map(record)
      .join('');
    writeFileSync(transcript, first);
    const incremental = new ClaudeTranscriptSessionSource({ configDir: root });
    const [session] = (await incremental.discover()).sessions;
    const beforeClose = await incremental.read(session);
    expect(
      beforeClose.events.some(
        (event) => event.method === 'token-usage.updated',
      ),
    ).toBe(false);
    writeFileSync(transcript, second, { flag: 'a' });
    const afterClose = await incremental.read(session, beforeClose.cursor);
    const wholeSource = new ClaudeTranscriptSessionSource({ configDir: root });
    const [fullSession] = (await wholeSource.discover()).sessions;
    const once = await wholeSource.read(fullSession);
    const usage = [...beforeClose.events, ...afterClose.events].filter(
      (event) => event.method === 'token-usage.updated',
    );
    expect(usage).toEqual([
      expect.objectContaining({
        promptTokens: 5,
        completionTokens: 136,
        totalTokens: 141,
        cacheReadTokens: 5,
        cacheWriteTokens: 44791,
        cacheWriteTokens5m: 7,
        cacheWriteTokens1h: 44793,
        serviceTier: 'standard',
      }),
    ]);
    expect(usage).toEqual(
      once.events.filter((event) => event.method === 'token-usage.updated'),
    );
  });

  test('defers a straddled turn from a pre-aggregation object cursor after upgrade', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    const transcript = join(directory, 'session-a.jsonl');
    const first = [
      {
        type: 'user',
        uuid: 'turn-1',
        sessionId: 'session-a',
        cwd: '[redacted]',
        timestamp: '2026-07-25T15:12:00.000Z',
        message: { role: 'user', content: 'first question' },
      },
      {
        type: 'assistant',
        uuid: 'call-1',
        sessionId: 'session-a',
        timestamp: '2026-07-25T15:12:01.000Z',
        message: {
          content: [{ type: 'text', text: '[redacted]' }],
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      },
      {
        type: 'assistant',
        uuid: 'call-2',
        sessionId: 'session-a',
        timestamp: '2026-07-25T15:12:02.000Z',
        message: {
          content: [{ type: 'text', text: '[redacted]' }],
          usage: { input_tokens: 5, output_tokens: 7 },
        },
      },
    ].map(record);
    const second = record({
      type: 'user',
      uuid: 'turn-2',
      sessionId: 'session-a',
      cwd: '[redacted]',
      timestamp: '2026-07-25T15:12:03.000Z',
      message: { role: 'user', content: 'next question' },
    });
    writeFileSync(transcript, [...first, second].join(''));
    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const [session] = (await source.discover()).sessions;

    const result = await source.read(session, {
      offset: first[1].length + first[0].length,
      turnId: 'turn-1',
    });

    expect(
      result.events.filter((event) => event.method === 'token-usage.updated'),
    ).toEqual([]);
  });

  test('flushes a turn with no turn_duration exactly once when the next string user message starts', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'session-a.jsonl'),
      [
        {
          type: 'user',
          uuid: 'turn-1',
          sessionId: 'session-a',
          cwd: '[redacted]',
          timestamp: '2026-07-25T15:12:00.000Z',
          message: { role: 'user', content: 'first question' },
        },
        {
          type: 'assistant',
          uuid: 'call-1',
          sessionId: 'session-a',
          timestamp: '2026-07-25T15:12:01.000Z',
          message: {
            content: [{ type: 'text', text: '[redacted]' }],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        },
        {
          type: 'user',
          uuid: 'turn-2',
          sessionId: 'session-a',
          cwd: '[redacted]',
          timestamp: '2026-07-25T15:12:02.000Z',
          message: { role: 'user', content: 'second question' },
        },
      ]
        .map(record)
        .join(''),
    );
    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const [session] = (await source.discover()).sessions;

    const result = await source.read(session);

    expect(
      result.events.filter((event) => event.method === 'token-usage.updated'),
    ).toEqual([
      expect.objectContaining({
        turnId: 'turn-1',
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 5,
      }),
    ]);
  });

  test('drops a token count that is not a safe non-negative integer', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'session-a.jsonl'),
      [
        {
          type: 'user',
          uuid: 'turn-1',
          sessionId: 'session-a',
          cwd: '[redacted]',
          timestamp: '2026-07-25T15:12:00.000Z',
          message: { role: 'user', content: 'first question' },
        },
        {
          type: 'assistant',
          uuid: 'call-1',
          sessionId: 'session-a',
          timestamp: '2026-07-25T15:12:01.000Z',
          message: {
            content: [{ type: 'text', text: '[redacted]' }],
            usage: {
              input_tokens: 1.5,
              output_tokens: 9_007_199_254_740_992,
              cache_read_input_tokens: 4,
            },
          },
        },
        {
          type: 'user',
          uuid: 'turn-2',
          sessionId: 'session-a',
          cwd: '[redacted]',
          timestamp: '2026-07-25T15:12:02.000Z',
          message: { role: 'user', content: 'second question' },
        },
      ]
        .map(record)
        .join(''),
    );
    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const [session] = (await source.discover()).sessions;

    const result = await source.read(session);

    // The valid dimension is still observed; the fractional and unsafe ones are
    // absent rather than rounded, so the persisted accumulator stays restorable
    // under the durable cursor's validator.
    const [usage] = result.events.filter(
      (event) => event.method === 'token-usage.updated',
    );
    expect(usage).toEqual(
      expect.objectContaining({ turnId: 'turn-1', cacheReadTokens: 4 }),
    );
    expect(usage).not.toHaveProperty('promptTokens');
    expect(usage).not.toHaveProperty('completionTokens');
  });

  test('keeps a turn_duration-flushed turn at one event while later turns use the next-user boundary', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'session-a.jsonl'),
      [
        {
          type: 'user',
          uuid: 'turn-1',
          sessionId: 'session-a',
          cwd: '[redacted]',
          timestamp: '2026-07-25T15:12:00.000Z',
          message: { role: 'user', content: 'first question' },
        },
        {
          type: 'assistant',
          uuid: 'call-1',
          sessionId: 'session-a',
          timestamp: '2026-07-25T15:12:01.000Z',
          message: {
            content: [{ type: 'text', text: '[redacted]' }],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        },
        {
          type: 'system',
          subtype: 'turn_duration',
          uuid: 'complete-1',
          sessionId: 'session-a',
          timestamp: '2026-07-25T15:12:02.000Z',
        },
        {
          type: 'user',
          uuid: 'turn-2',
          sessionId: 'session-a',
          cwd: '[redacted]',
          timestamp: '2026-07-25T15:12:03.000Z',
          message: { role: 'user', content: 'second question' },
        },
        {
          type: 'assistant',
          uuid: 'call-2',
          sessionId: 'session-a',
          timestamp: '2026-07-25T15:12:04.000Z',
          message: {
            content: [{ type: 'text', text: '[redacted]' }],
            usage: { input_tokens: 5, output_tokens: 7 },
          },
        },
        {
          type: 'user',
          uuid: 'turn-3',
          sessionId: 'session-a',
          cwd: '[redacted]',
          timestamp: '2026-07-25T15:12:05.000Z',
          message: { role: 'user', content: 'third question' },
        },
      ]
        .map(record)
        .join(''),
    );
    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const [session] = (await source.discover()).sessions;

    const result = await source.read(session);
    const usage = result.events.filter(
      (event) => event.method === 'token-usage.updated',
    );

    expect(usage).toEqual([
      expect.objectContaining({
        turnId: 'turn-1',
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 5,
      }),
      expect.objectContaining({
        turnId: 'turn-2',
        promptTokens: 5,
        completionTokens: 7,
        totalTokens: 12,
      }),
    ]);
  });

  test('discovers only regular JSONL transcripts below the canonical projects root', async () => {
    const root = fixtureDir();
    const projects = join(root, 'projects');
    const nested = join(projects, 'encoded-project');
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, 'session-a.jsonl'),
      record({
        type: 'user',
        uuid: 'user-1',
        sessionId: 'session-a',
        cwd: '/workspace/project',
        timestamp: '2026-07-22T00:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
    );
    writeFileSync(join(nested, 'ignore.txt'), 'not a transcript');
    const outside = join(root, 'outside.jsonl');
    writeFileSync(outside, '{}\n');
    symlinkSync(outside, join(nested, 'escaped.jsonl'));

    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const discovered = await source.discover();

    expect(discovered.outcome).toBe('rejected_candidate');
    expect(discovered.sessions).toHaveLength(1);
    expect(discovered.sessions[0]).toMatchObject({
      provider: 'claude',
      sessionId: 'session-a',
      threadId: expect.stringMatching(/^external:claude:[a-f0-9]+$/),
      cwd: '/workspace/project',
    });
    expect(discovered.sessions[0].threadId).not.toContain('session-a');
    expect(JSON.stringify(discovered)).not.toContain(outside);
  });

  test('defers an incomplete trailing record until its terminating newline arrives', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    const transcript = join(directory, 'session-a.jsonl');
    writeFileSync(
      transcript,
      record({
        type: 'user',
        uuid: 'user-1',
        sessionId: 'session-a',
        cwd: '/workspace/project',
        timestamp: '2026-07-22T00:00:00.000Z',
        message: { role: 'user', content: 'first' },
      }) +
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          sessionId: 'session-a',
          timestamp: '2026-07-22T00:00:01.000Z',
          message: { content: [{ type: 'text', text: 'second' }] },
        }),
    );
    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const [session] = (await source.discover()).sessions;

    const first = await source.read(session);
    expect(first.events.map((event) => event.method)).toEqual(['turn.started']);
    expect(first.outcome).toBe('incomplete_tail');

    writeFileSync(transcript, '\n', { flag: 'a' });
    const second = await source.read(session, first.cursor);
    expect(second.events.map((event) => event.method)).toEqual([
      'content.text-delta',
    ]);
  });

  test('uses absolute file offsets for UUID-less records across incremental reads', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    const transcript = join(directory, 'session-a.jsonl');
    const uuidLess = record({
      type: 'user',
      sessionId: 'session-a',
      cwd: '/workspace/project',
      timestamp: '2026-07-22T00:00:00.000Z',
      message: { role: 'user', content: 'same text' },
    });
    writeFileSync(transcript, uuidLess);
    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const [session] = (await source.discover()).sessions;

    const first = await source.read(session);
    writeFileSync(transcript, uuidLess, { flag: 'a' });
    const second = await source.read(session, first.cursor);

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(second.events[0].eventId).not.toBe(first.events[0].eventId);
  });

  test('maps supported Claude records with deterministic canonical IDs and bounded content', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'session-a.jsonl'),
      [
        {
          type: 'user',
          uuid: 'user-1',
          sessionId: 'session-a',
          cwd: '/workspace/project',
          timestamp: '2026-07-22T00:00:00.000Z',
          message: { role: 'user', content: 'question' },
        },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          sessionId: 'session-a',
          timestamp: '2026-07-22T00:00:01.000Z',
          message: {
            content: [
              { type: 'thinking', thinking: 'reasoning' },
              { type: 'text', text: 'answer' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { path: '/private/path' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'tool-result-1',
          sessionId: 'session-a',
          timestamp: '2026-07-22T00:00:02.000Z',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
            ],
          },
        },
        {
          type: 'system',
          subtype: 'turn_duration',
          uuid: 'complete-1',
          sessionId: 'session-a',
          timestamp: '2026-07-22T00:00:03.000Z',
        },
      ]
        .map(record)
        .join(''),
    );
    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const [session] = (await source.discover()).sessions;

    const first = await source.read(session);
    const second = await source.read(session);

    expect(first.events.map((event) => event.method)).toEqual([
      'turn.started',
      'content.reasoning-delta',
      'content.text-delta',
      'tool.started',
      'tool.completed',
      'turn.completed',
    ]);
    expect(new Set(first.events.map((event) => event.turnId))).toEqual(
      new Set(['user-1']),
    );
    expect(
      projectSessionLifecycle({
        session: {
          provider: 'claude',
          threadId: session.threadId,
          status: 'running',
          createdAt: session.createdAt,
          updatedAt: session.createdAt,
        },
        events: first.events.slice(0, -1),
      }).lifecycleState,
    ).toBe('running');
    expect(first.events.map((event) => event.eventId)).toEqual(
      second.events.map((event) => event.eventId),
    );
    expect(
      first.events.every((event) =>
        event.eventId.startsWith('attached:claude:'),
      ),
    ).toBe(true);
    expect(
      first.events.find((event) => event.method === 'tool.started'),
    ).toMatchObject({
      toolName: 'Read',
      arguments: { path: '/private/path' },
    });
  });

  test('continues a multi-event JSONL line without dropping events at the cap', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'session-a.jsonl'),
      [
        {
          type: 'user',
          uuid: 'user-1',
          sessionId: 'session-a',
          cwd: '/workspace/project',
          timestamp: '2026-07-22T00:00:00.000Z',
          message: { role: 'user', content: 'question' },
        },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          sessionId: 'session-a',
          timestamp: '2026-07-22T00:00:01.000Z',
          message: {
            content: [
              { type: 'thinking', thinking: 'reasoning' },
              { type: 'text', text: 'answer' },
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
            ],
          },
        },
      ]
        .map(record)
        .join(''),
    );
    const source = new ClaudeTranscriptSessionSource({
      configDir: root,
      maxEvents: 2,
    });
    const [session] = (await source.discover()).sessions;

    const first = await source.read(session);
    const second = await source.read(session, first.cursor);

    expect(
      [...first.events, ...second.events].map((event) => event.method),
    ).toEqual([
      'turn.started',
      'content.reasoning-delta',
      'content.text-delta',
      'tool.started',
    ]);
    expect(
      new Set([...first.events, ...second.events].map((event) => event.eventId))
        .size,
    ).toBe(4);
  });

  test('uses a bounded recent window for a large transcript instead of rejecting it', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    const transcript = join(directory, 'session-a.jsonl');
    const leading = record({
      type: 'user',
      uuid: 'user-1',
      sessionId: 'session-a',
      cwd: '/workspace/project',
      timestamp: '2026-07-22T00:00:00.000Z',
      message: { role: 'user', content: 'initial' },
    });
    const ignored = Array.from({ length: 20 }, (_, index) =>
      record({ type: 'unknown', uuid: `unknown-${index}` }),
    ).join('');
    const recent = record({
      type: 'assistant',
      uuid: 'assistant-recent',
      sessionId: 'session-a',
      timestamp: '2026-07-22T00:00:01.000Z',
      message: { content: [{ type: 'text', text: 'recent answer' }] },
    });
    writeFileSync(transcript, leading + ignored + recent);
    const source = new ClaudeTranscriptSessionSource({
      configDir: root,
      maxBytes: recent.length + 16,
      maxLineBytes: 512,
    });
    const [session] = (await source.discover()).sessions;

    const result = await source.read(session);

    expect(result.outcome).toBe('byte_limit');
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'content.text-delta',
          delta: 'recent answer',
        }),
      ]),
    );
  });

  test('keeps the newest bounded candidates when more transcripts exist than the cap', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    for (let index = 1; index <= 3; index += 1) {
      const transcript = join(directory, `session-${index}.jsonl`);
      writeFileSync(
        transcript,
        record({
          type: 'user',
          uuid: `user-${index}`,
          sessionId: `session-${index}`,
          cwd: '/workspace/project',
          timestamp: '2026-07-22T00:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        }),
      );
      utimesSync(transcript, index, index);
    }

    const discovered = await new ClaudeTranscriptSessionSource({
      configDir: root,
      maxCandidates: 2,
    }).discover();

    expect(discovered.outcome).toBe('candidate_limit');
    expect(discovered.sessions.map((item) => item.sessionId)).toEqual([
      'session-3',
      'session-2',
    ]);
  });

  test('bounds traversal even when a large tree contains no JSONL candidates', async () => {
    const root = fixtureDir();
    const projects = join(root, 'projects');
    mkdirSync(projects, { recursive: true });
    for (let directory = 0; directory < 5; directory += 1) {
      const nested = join(projects, `directory-${directory}`);
      mkdirSync(nested);
      for (let file = 0; file < 10; file += 1) {
        writeFileSync(join(nested, `file-${file}.txt`), 'ignored');
      }
    }

    const discovered = await new ClaudeTranscriptSessionSource({
      configDir: root,
      maxCandidates: 2,
      maxTraversalEntries: 12,
    }).discover();

    expect(discovered).toEqual({ outcome: 'candidate_limit', sessions: [] });
  });

  test('expires source handles that are absent from the next discovery snapshot', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    const transcript = join(directory, 'session-a.jsonl');
    writeFileSync(
      transcript,
      record({
        type: 'user',
        uuid: 'user-1',
        sessionId: 'session-a',
        cwd: '/workspace/project',
        timestamp: '2026-07-22T00:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
    );
    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const [session] = (await source.discover()).sessions;

    rmSync(transcript);
    await source.discover();

    await expect(source.read(session)).resolves.toEqual({
      outcome: 'unknown_source',
      events: [],
      cursor: 0,
    });
  });

  // archive#1997: a fresh cursor over a large window must not parse the whole
  // slab as one synchronous run — the interior yield is what keeps identity
  // probes answering during boot backfill of big transcripts.
  test('read() yields to the event loop while parsing a large window', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    const transcript = join(directory, 'session-a.jsonl');
    const lines: string[] = [];
    lines.push(
      record({
        type: 'user',
        uuid: 'user-0',
        sessionId: 'session-a',
        cwd: '/workspace/project',
        timestamp: '2026-07-22T00:00:00.000Z',
        message: { role: 'user', content: 'start' },
      }),
    );
    for (let i = 1; i <= 20; i += 1) {
      lines.push(
        record({
          type: 'assistant',
          uuid: `assistant-${i}`,
          sessionId: 'session-a',
          timestamp: `2026-07-22T00:00:${String(i).padStart(2, '0')}.000Z`,
          message: { content: [{ type: 'text', text: `chunk ${i}` }] },
        }),
      );
    }
    writeFileSync(transcript, lines.join(''));
    let yields = 0;
    const source = new ClaudeTranscriptSessionSource({
      configDir: root,
      readYieldEveryLines: 4,
      yieldFn: async () => {
        yields += 1;
      },
    });
    const [session] = (await source.discover()).sessions;
    const result = await source.read(session);
    // 21 lines at a cadence of 4 → five interior yields, and the parse still
    // returns the full event set (yielding must not drop or reorder lines).
    expect(yields).toBe(5);
    expect(result.events.length).toBe(21);
  });

  test('read() does not yield for a small under-cadence read', async () => {
    const root = fixtureDir();
    const directory = join(root, 'projects', 'encoded-project');
    mkdirSync(directory, { recursive: true });
    const transcript = join(directory, 'session-a.jsonl');
    writeFileSync(
      transcript,
      record({
        type: 'user',
        uuid: 'user-0',
        sessionId: 'session-a',
        cwd: '/workspace/project',
        timestamp: '2026-07-22T00:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
    );
    let yields = 0;
    const source = new ClaudeTranscriptSessionSource({
      configDir: root,
      yieldFn: async () => {
        yields += 1;
      },
    });
    const [session] = (await source.discover()).sessions;
    await source.read(session);
    expect(yields).toBe(0);
  });
});
