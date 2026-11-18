import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { foldUsageEvents } from '@kontourai/station-shared/usage-fold';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AttachedSessionCursor } from '../attached-session-source.js';
import { CodexRolloutSessionSource } from '../codex-rollout-session-source.js';
import { readLeadingLine } from '../transcript-file-io.js';

const readChunk = vi.hoisted(() =>
  vi.fn<
    (
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => number
  >(),
);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readSync: readChunk.mockImplementation((...args) =>
      actual.readSync(...args),
    ),
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

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
  readChunk
    .mockReset()
    .mockImplementation((...args) => realFs.readSync(...args));
  vi.mocked(openSync).mockReset().mockImplementation(realFs.openSync);
  vi.mocked(closeSync).mockReset().mockImplementation(realFs.closeSync);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('CodexRolloutSessionSource', () => {
  test('bounds repeated discovery and read validation to the leading record and observes a rewritten head', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    writeFileSync(
      path,
      line(meta('bounded-head')) + 'x'.repeat(8 * 1024 * 1024),
    );
    const source = new CodexRolloutSessionSource({ homeDir: root });
    let actualBytes = 0;
    await readChunk.withImplementation(
      (descriptor, buffer, offset, length, position) => {
        const bytesRead = realFs.readSync(
          descriptor,
          buffer,
          offset,
          length,
          position,
        );
        actualBytes += bytesRead;
        return bytesRead;
      },
      async () => {
        const first = await discoverOne(source);
        expect(await discoverOne(source)).toEqual(first);
        expect(await source.read(first, -1)).toMatchObject({
          outcome: 'rejected_candidate',
          events: [],
          cursor: -1,
        });
        expect(actualBytes).toBeLessThanOrEqual(3 * 4096);
        expect(readChunk).toHaveBeenCalledTimes(3);
        writeFileSync(path, line(meta('rewritten-head')));
        expect(await source.read(first)).toMatchObject({
          outcome: 'rejected_candidate',
          events: [],
        });
        expect((await discoverOne(source)).sessionId).toBe('rewritten-head');
      },
    );
  });

  test.each([4095, 4096, 4097, 128 * 1024])(
    'accepts a %i-byte leading record with UTF-8 split across reads and a newline at the cap',
    async (length) => {
      const root = fixtureRoot();
      const path = rolloutPath(root);
      const content = `${'a'.repeat(length - 2)}é`;
      writeFileSync(path, `${content}\nignored`);
      expect(readLeadingLine(path, length)).toBe(content);
      const head = JSON.stringify(meta('boundary', '/workspace/é'));
      writeFileSync(
        path,
        `${head}${' '.repeat(length - Buffer.byteLength(head))}\nignored`,
      );
      const source = new CodexRolloutSessionSource({
        homeDir: root,
        maxLineBytes: length,
      });
      expect((await discoverOne(source)).cwd).toBe('/workspace/é');
    },
  );

  test.each([
    { content: '', expected: undefined },
    { content: ' \r\nignored', expected: undefined },
    { content: 'é', expected: 'é' },
    { content: 'x'.repeat(4096), expected: 'x'.repeat(4096) },
    { content: 'x'.repeat(4097), expected: null },
    { content: `${'x'.repeat(4097)}\n`, expected: null },
    { content: Buffer.from([0xc3, 0x28, 0x0a]), expected: '�(' },
  ])(
    'preserves EOF, blank, oversized and malformed UTF-8 handling ($content.length bytes)',
    ({ content, expected }) => {
      const path = rolloutPath(fixtureRoot());
      writeFileSync(path, content);
      expect(readLeadingLine(path, 4096)).toBe(expected);
      for (const call of readChunk.mock.calls) {
        expect(Number(call[4]) + call[3]).toBeLessThanOrEqual(4097);
      }
    },
  );

  test('continues short reads on one descriptor and closes it after EOF or a read failure', () => {
    const path = rolloutPath(fixtureRoot());
    writeFileSync(path, 'éabc');
    readChunk.withImplementation(
      (descriptor, buffer, offset, length, position) =>
        realFs.readSync(
          descriptor,
          buffer,
          offset,
          Math.min(length, 1),
          position,
        ),
      () => expect(readLeadingLine(path, 4096)).toBe('éabc'),
    );
    expect(openSync).toHaveBeenCalledTimes(1);
    expect(closeSync).toHaveBeenCalledTimes(1);
    expect(readChunk).toHaveBeenCalledTimes(6);
    readChunk.withImplementation(
      () => {
        throw new Error('read failed');
      },
      () => {
        expect(() => readLeadingLine(path, 4096)).toThrow('read failed');
      },
    );
    expect(closeSync).toHaveBeenCalledTimes(2);
  });

  test('bounds retained prefix storage across one-byte short reads', () => {
    const path = rolloutPath(fixtureRoot());
    const limit = 8192;
    const head = 'a'.repeat(limit);
    writeFileSync(path, `${head}\nignored`);
    const storage = new Set<ArrayBufferLike>();
    readChunk.withImplementation(
      (descriptor, buffer, offset, length, position) => {
        storage.add(buffer.buffer);
        return realFs.readSync(
          descriptor,
          buffer,
          offset,
          Math.min(length, 1),
          position,
        );
      },
      () => expect(readLeadingLine(path, limit)).toBe(head),
    );
    expect(
      [...storage].reduce((bytes, buffer) => bytes + buffer.byteLength, 0),
    ).toBeLessThanOrEqual(limit + 1);
  });

  test('does not combine replacement bytes across chunks and handles truncation at EOF', () => {
    const path = rolloutPath(fixtureRoot());
    const replacement = `${path}.replacement`;
    writeFileSync(path, `${'a'.repeat(4096)}original\n`);
    writeFileSync(replacement, `${'b'.repeat(4096)}replacement\n`);
    readChunk.mockImplementationOnce(
      (descriptor, buffer, offset, length, position) => {
        const bytes = realFs.readSync(
          descriptor,
          buffer,
          offset,
          length,
          position,
        );
        renameSync(replacement, path);
        return bytes;
      },
    );
    expect(readLeadingLine(path, 8192)).toBe(`${'a'.repeat(4096)}original`);
    readChunk.mockImplementationOnce(
      (descriptor, buffer, offset, length, position) => {
        const bytes = realFs.readSync(
          descriptor,
          buffer,
          offset,
          length,
          position,
        );
        truncateSync(path, 4096);
        return bytes;
      },
    );
    expect(readLeadingLine(path, 8192)).toBe('b'.repeat(4096));
    expect(openSync).toHaveBeenCalledTimes(2);
    expect(closeSync).toHaveBeenCalledTimes(2);
  });

  test('rejects a file swapped during secure open and closes the rejected descriptor', () => {
    const path = rolloutPath(fixtureRoot());
    const replacement = `${path}.replacement`;
    writeFileSync(path, line(meta('original')));
    writeFileSync(replacement, line(meta('replacement')));
    vi.mocked(openSync).mockImplementationOnce((file, flags, mode) => {
      renameSync(replacement, path);
      return realFs.openSync(file, flags, mode);
    });
    expect(() => readLeadingLine(path, 4096)).toThrow(
      'changed during secure open',
    );
    expect(readChunk).not.toHaveBeenCalled();
    expect(closeSync).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed or incomplete leading JSON until the record is completed', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    const head = JSON.stringify(meta('partial-head'));
    const source = new CodexRolloutSessionSource({ homeDir: root });
    writeFileSync(path, head.slice(0, -1));
    expect(await source.discover()).toEqual({
      outcome: 'malformed_record',
      sessions: [],
    });
    appendFileSync(path, '}');
    expect((await discoverOne(source)).sessionId).toBe('partial-head');
    writeFileSync(path, Buffer.from([0xff, 0x0a]));
    expect(await source.discover()).toEqual({
      outcome: 'malformed_record',
      sessions: [],
    });
  });

  test('binds descriptors to one opaque Codex home across restart and rejects foreign or replaced homes', async () => {
    const root = fixtureRoot();
    writeFileSync(rolloutPath(root), line(meta('affinity')));
    const source = new CodexRolloutSessionSource({ homeDir: root });
    const session = await discoverOne(source);

    expect(session.affinity).toMatchObject({
      kind: 'codex-config-home',
      ref: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(session.affinity)).not.toContain(root);
    expect(source.resolveSourceHome(session.affinity)).toBe(realpathSync(root));

    const restarted = new CodexRolloutSessionSource({ homeDir: root });
    const rediscovered = await discoverOne(restarted);
    expect(rediscovered.affinity).toEqual(session.affinity);
    expect(restarted.resolveSourceHome(session.affinity)).toBe(
      realpathSync(root),
    );

    const otherRoot = fixtureRoot();
    writeFileSync(rolloutPath(otherRoot), line(meta('other')));
    const other = new CodexRolloutSessionSource({ homeDir: otherRoot });
    const otherSession = await discoverOne(other);
    expect(other.resolveSourceHome(session.affinity)).toBeNull();
    expect(
      await source.read({ ...session, affinity: otherSession.affinity }),
    ).toMatchObject({ outcome: 'unknown_source', events: [] });
    expect(
      source.resolveSourceHome({
        kind: 'claude-config-home',
        ref: session.affinity!.ref,
      }),
    ).toBeNull();
    expect(
      source.resolveSourceHome({ kind: 'codex-config-home', ref: 'bad' }),
    ).toBeNull();

    const movedRoot = `${root}-original`;
    roots.push(movedRoot);
    renameSync(root, movedRoot);
    writeFileSync(rolloutPath(root), line(meta('replacement')));
    expect(source.resolveSourceHome(session.affinity)).toBeNull();
    expect(await source.read(session)).toMatchObject({
      outcome: 'rejected_candidate',
      events: [],
    });
  });

  test('an isolated history root does not scan the authenticated CLI home', async () => {
    const authenticatedHome = fixtureRoot();
    const isolatedHistory = fixtureRoot();
    writeFileSync(rolloutPath(authenticatedHome), line(meta('host-session')));
    vi.stubEnv('CODEX_HOME', authenticatedHome);
    vi.stubEnv('STATION_EXTERNAL_CODEX_SOURCE_ROOT', isolatedHistory);
    try {
      expect(
        (await new CodexRolloutSessionSource().discover()).sessions,
      ).toHaveLength(0);
      expect(
        (
          await new CodexRolloutSessionSource({
            homeDir: authenticatedHome,
          }).discover()
        ).sessions,
      ).toHaveLength(1);
      expect(process.env.CODEX_HOME).toBe(authenticatedHome);
      // Nor any home Station configures.
      const listConfiguredHomes = vi.fn(async () => [authenticatedHome]);
      expect(
        (
          await new CodexRolloutSessionSource({
            listConfiguredHomes,
          }).discover()
        ).sessions,
      ).toHaveLength(0);
      expect(listConfiguredHomes).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
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

  test('a compaction the rollout records shows in the projected transcript as a marker (station#3415)', async () => {
    const root = fixtureRoot();
    writeFileSync(
      rolloutPath(root),
      [
        meta(),
        envelope('event_msg', { type: 'task_started', turn_id: 't1' }),
        envelope('event_msg', { type: 'user_message', message: 'question' }),
        envelope('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'before' }],
        }),
        envelope('event_msg', { type: 'context_compacted' }),
        envelope('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'after' }],
        }),
        envelope('event_msg', { type: 'task_complete', turn_id: 't1' }),
        envelope('compacted', { message: 'summary of the earlier turns' }),
      ]
        .map(line)
        .join(''),
    );
    const source = new CodexRolloutSessionSource({ homeDir: root });
    const { events } = await drain(source, await discoverOne(source));

    const messages = projectRuntimeEventsToMessages(events, {
      stableIds: true,
    });
    expect(
      messages.map((message) => [
        message.id,
        message.role,
        message.parts.map((part) => `${part.type}:${part.text}`).join('|'),
        message.metadata?.answerEligible === true,
      ]),
    ).toEqual([
      [expect.any(String), 'user', 'text:question', false],
      // One canonical answer row for the turn: the compaction does not split it.
      [
        `${events[0]!.eventId}:assistant`,
        'assistant',
        'text:before\n\nafter',
        true,
      ],
      // The mid-turn compaction follows its turn once the turn closed...
      [
        expect.any(String),
        'system',
        'transcript-marker:Context compacted during this turn',
        false,
      ],
      // ...and the `compacted` record after it is a between-turns marker.
      [
        expect.any(String),
        'system',
        'transcript-marker:Context compacted',
        false,
      ],
    ]);
    // Never the engine's own summary text: the marker label is Station's.
    expect(JSON.stringify(messages)).not.toContain('summary of the earlier');
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

  test('preserves ambiguous initial input and classifies only post-activity input as a steer across restart', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    writeFileSync(
      path,
      [
        meta('steer'),
        envelope('event_msg', { type: 'task_started', turn_id: 't1' }),
        envelope('event_msg', { type: 'user_message', message: 'first' }),
        envelope('event_msg', {
          type: 'user_message',
          message: 'second initial input',
        }),
        envelope('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'working' }],
        }),
      ]
        .map(line)
        .join(''),
    );
    const firstSource = new CodexRolloutSessionSource({ homeDir: root });
    const firstSession = await discoverOne(firstSource);
    const first = await firstSource.read(firstSession);

    expect(first.events).toContainEqual(
      expect.objectContaining({
        method: 'runtime.warning',
        turnId: 't1',
        code: 'external_input_phase_unknown',
        details: expect.objectContaining({ inputText: 'second initial input' }),
      }),
    );
    expect(first.events).not.toContainEqual(
      expect.objectContaining({ inputKind: 'steer' }),
    );
    expect(first.cursor).toMatchObject({
      sourceState: { version: 1, activityObserved: true },
    });

    appendFileSync(
      path,
      line(
        envelope('event_msg', {
          type: 'user_message',
          message: 'later steer',
        }),
      ),
    );
    const restarted = new CodexRolloutSessionSource({ homeDir: root });
    const restartedSession = await discoverOne(restarted);
    const second = await restarted.read(restartedSession, first.cursor);
    expect(second.events).toEqual([
      expect.objectContaining({
        method: 'turn.started',
        turnId: 't1',
        inputKind: 'steer',
        prompt: 'later steer',
        metadata: expect.objectContaining({ inputPhase: 'after-activity' }),
      }),
    ]);
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

  test('consecutive assistant messages in a turn import as separate paragraphs, across pages', async () => {
    const root = fixtureRoot();
    const path = rolloutPath(root);
    const assistant = (id: string, ...texts: string[]) =>
      envelope('response_item', {
        type: 'message',
        id,
        role: 'assistant',
        content: texts.map((text) => ({ type: 'output_text', text })),
      });
    writeFileSync(
      path,
      [
        meta('paragraphs'),
        envelope('event_msg', { type: 'task_started', turn_id: 't1' }),
        envelope('event_msg', { type: 'user_message', message: 'go' }),
        assistant('m1', 'I opened the PR.'),
        assistant('m2', 'The focused tests', ' pass.'),
        envelope('event_msg', { type: 'task_complete', turn_id: 't1' }),
        envelope('event_msg', { type: 'task_started', turn_id: 't2' }),
        envelope('event_msg', { type: 'user_message', message: 'more' }),
        assistant('m3', 'Next turn.'),
        envelope('event_msg', { type: 'task_complete', turn_id: 't2' }),
      ]
        .map(line)
        .join(''),
    );
    // One event per page: the "turn already has text" fact must survive the
    // cursor between the two message lines.
    const source = new CodexRolloutSessionSource({
      homeDir: root,
      maxEvents: 1,
    });
    const session = await discoverOne(source);

    const result = await drain(source, session);
    expect(
      result.events
        .filter((event) => event.method === 'content.text-delta')
        .map((event) => event.delta),
    ).toEqual([
      'I opened the PR.',
      '\n\nThe focused tests',
      ' pass.',
      'Next turn.',
    ]);
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

  test('discovers every configured Codex home and resolves each affinity to its own home', async () => {
    const defaultHome = fixtureRoot();
    const profileHome = fixtureRoot();
    const turn = (prompt: string) =>
      [
        envelope('event_msg', { type: 'task_started', turn_id: 't1' }),
        envelope('event_msg', { type: 'user_message', message: prompt }),
      ]
        .map(line)
        .join('');
    writeFileSync(
      rolloutPath(defaultHome),
      line(meta('default-only')) + turn('in default'),
    );
    writeFileSync(
      rolloutPath(profileHome),
      line(meta('profile-only')) + turn('in profile'),
    );
    // The same conversation copied into both homes is one session.
    writeFileSync(
      rolloutPath(defaultHome, 'shared.jsonl'),
      line(meta('shared')) + turn('shared'),
    );
    writeFileSync(
      rolloutPath(profileHome, 'shared.jsonl'),
      line(meta('shared')) + turn('shared'),
    );
    let configured: string[] = [profileHome, profileHome];
    const source = new CodexRolloutSessionSource({
      homeDir: defaultHome,
      listConfiguredHomes: async () => configured,
    });
    const discovery = await source.discover();
    expect(discovery.outcome).toBe('ok');
    expect(discovery.sessions).toHaveLength(4);
    const byId = new Map(
      discovery.sessions
        .filter((s) => s.sessionId !== 'shared')
        .map((s) => [s.sessionId, s]),
    );

    const defaultOnly = byId.get('default-only')!;
    const profileOnly = byId.get('profile-only')!;
    expect(profileOnly.affinity).not.toEqual(defaultOnly.affinity);
    expect(source.resolveSourceHome(profileOnly.affinity)).toBe(
      realpathSync(profileHome),
    );
    expect(source.resolveSourceHome(defaultOnly.affinity)).toBe(
      realpathSync(defaultHome),
    );
    // A conversation copied into two homes is two threads, one per home, each
    // continuing in its own home: once both copies continue they have forked.
    const shared = discovery.sessions.filter((s) => s.sessionId === 'shared');
    expect(shared).toHaveLength(2);
    const sharedDefault = shared.find(
      (s) => s.affinity?.ref === defaultOnly.affinity?.ref,
    )!;
    const sharedProfile = shared.find(
      (s) => s.affinity?.ref === profileOnly.affinity?.ref,
    )!;
    expect(sharedDefault.threadId).not.toBe(sharedProfile.threadId);
    // The default home keeps the thread id a single-home source gives it.
    const defaultAlone = await new CodexRolloutSessionSource({
      homeDir: defaultHome,
    }).discover();
    expect(
      defaultAlone.sessions.find((s) => s.sessionId === 'shared')?.threadId,
    ).toBe(sharedDefault.threadId);

    // The default copy failing to parse for one discovery leaves the profile
    // copy's thread exactly as it was: no copy takes over another's thread.
    const sharedDefaultPath = rolloutPath(defaultHome, 'shared.jsonl');
    writeFileSync(sharedDefaultPath, 'not json\n');
    const degraded = await source.discover();
    expect(degraded.sessions.filter((s) => s.sessionId === 'shared')).toEqual([
      sharedProfile,
    ]);
    writeFileSync(sharedDefaultPath, line(meta('shared')) + turn('shared'));

    const read = await drain(source, profileOnly);
    expect(JSON.stringify(read.events)).toContain('in profile');

    // A home Station no longer configures stops resolving after rediscovery.
    configured = [];
    const narrowed = await source.discover();
    expect(narrowed.sessions.map((s) => s.sessionId).sort()).toEqual([
      'default-only',
      'shared',
    ]);
    expect(
      narrowed.sessions.find((s) => s.sessionId === 'shared')?.threadId,
    ).toBe(sharedDefault.threadId);
    expect(source.resolveSourceHome(profileOnly.affinity)).toBeNull();
  });

  test('after a restart, an affinity for a configured home resolves without waiting for a discovery', async () => {
    const defaultHome = fixtureRoot();
    const profileHome = fixtureRoot();
    writeFileSync(rolloutPath(profileHome), line(meta('profile-session')));
    const options = {
      homeDir: defaultHome,
      listConfiguredHomes: async () => [profileHome],
    };
    const before = await discoverOne(new CodexRolloutSessionSource(options));

    const restarted = new CodexRolloutSessionSource(options);
    expect(restarted.resolveSourceHome(before.affinity)).toBeNull();
    await expect(
      restarted.resolveSourceHomeWithRefresh(before.affinity),
    ).resolves.toBe(realpathSync(profileHome));
    // A home no longer configured still refuses after the refresh.
    await expect(
      new CodexRolloutSessionSource({
        homeDir: defaultHome,
      }).resolveSourceHomeWithRefresh(before.affinity),
    ).resolves.toBeNull();
  });

  test('each home has its own candidate budget, so a busy profile home cannot evict default-home sessions', async () => {
    const defaultHome = fixtureRoot();
    const busyProfile = fixtureRoot();
    const old = rolloutPath(defaultHome, 'old.jsonl');
    writeFileSync(old, line(meta('default-old')));
    utimesSync(old, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    for (const name of ['p1', 'p2', 'p3']) {
      const path = rolloutPath(busyProfile, `${name}.jsonl`);
      writeFileSync(path, line(meta(name)));
      utimesSync(
        path,
        new Date(1_800_000_000_000),
        new Date(1_800_000_000_000),
      );
    }
    const discovery = await new CodexRolloutSessionSource({
      homeDir: defaultHome,
      maxCandidates: 2,
      listConfiguredHomes: async () => [busyProfile],
    }).discover();
    expect(discovery.outcome).toBe('candidate_limit');
    const ids = discovery.sessions.map((s) => s.sessionId);
    expect(ids).toContain('default-old');
    expect(ids.filter((id) => id.startsWith('p'))).toHaveLength(2);
  });

  test('the total candidate ceiling holds at max, refuses max+1, and stops walking homes once full', async () => {
    const homes = [fixtureRoot(), fixtureRoot(), fixtureRoot()];
    for (const [index, home] of homes.entries())
      for (const name of index === 2 ? ['c1'] : [`h${index}a`, `h${index}b`])
        writeFileSync(rolloutPath(home, `${name}.jsonl`), line(meta(name)));
    const scanHome = vi.spyOn(
      CodexRolloutSessionSource.prototype as unknown as {
        scanHome: (root: string) => unknown;
      },
      'scanHome',
    );
    const at = (configured: string[]) =>
      new CodexRolloutSessionSource({
        homeDir: homes[0],
        maxCandidates: 2,
        maxTotalCandidates: 4,
        listConfiguredHomes: async () => configured,
      }).discover();

    const exactlyFull = await at([homes[1]!]);
    expect(exactlyFull.outcome).toBe('ok');
    expect(exactlyFull.sessions).toHaveLength(4);

    scanHome.mockClear();
    const oneMore = await at([homes[1]!, homes[2]!]);
    expect(oneMore.outcome).toBe('candidate_limit');
    expect(oneMore.sessions.map((s) => s.sessionId).sort()).toEqual([
      'h0a',
      'h0b',
      'h1a',
      'h1b',
    ]);
    // The third home is not walked once the total is full.
    expect(scanHome).toHaveBeenCalledTimes(2);
    expect(
      () =>
        new CodexRolloutSessionSource({
          homeDir: homes[0],
          maxTotalCandidates: 513,
        }),
    ).toThrow(/maxTotalCandidates/);
  });

  test('a refresh runs only for a well-formed Codex affinity, and concurrent ones share one home-list read', async () => {
    const defaultHome = fixtureRoot();
    const profileHome = fixtureRoot();
    writeFileSync(rolloutPath(profileHome), line(meta('profile-session')));
    const listConfiguredHomes = vi.fn(async () => [profileHome]);
    const options = { homeDir: defaultHome, listConfiguredHomes };
    const affinity = (await discoverOne(new CodexRolloutSessionSource(options)))
      .affinity!;
    listConfiguredHomes.mockClear();

    const source = new CodexRolloutSessionSource(options);
    for (const malformed of [
      { kind: 'claude-config-home', ref: affinity.ref },
      { kind: 'codex-config-home', ref: 'not-a-digest' },
      { kind: 'codex-config-home', ref: affinity.ref, extra: true },
    ])
      await expect(
        source.resolveSourceHomeWithRefresh(malformed as never),
      ).resolves.toBeNull();
    expect(listConfiguredHomes).not.toHaveBeenCalled();

    const answers = await Promise.all([
      source.resolveSourceHomeWithRefresh(affinity),
      source.resolveSourceHomeWithRefresh(affinity),
      source.resolveSourceHomeWithRefresh(affinity),
    ]);
    expect(answers).toEqual(Array(3).fill(realpathSync(profileHome)));
    expect(listConfiguredHomes).toHaveBeenCalledTimes(1);
  });

  test('a failing or oversized home list keeps the default home and reports the limit', async () => {
    const defaultHome = fixtureRoot();
    writeFileSync(rolloutPath(defaultHome), line(meta('default')));
    const failing = new CodexRolloutSessionSource({
      homeDir: defaultHome,
      listConfiguredHomes: async () => {
        throw new Error('config unreadable');
      },
    });
    expect((await failing.discover()).sessions.map((s) => s.sessionId)).toEqual(
      ['default'],
    );

    const extra = fixtureRoot();
    writeFileSync(rolloutPath(extra), line(meta('extra')));
    const capped = await new CodexRolloutSessionSource({
      homeDir: defaultHome,
      maxHomes: 1,
      listConfiguredHomes: async () => [extra, 'relative/home'],
    }).discover();
    expect(capped.outcome).toBe('candidate_limit');
    expect(capped.sessions.map((s) => s.sessionId)).toEqual(['default']);
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
    const prompt = started?.method === 'turn.started' ? started.prompt : '';
    // A truncated source prompt stays inline text, not a reference.
    expect(typeof prompt).toBe('string');
    expect(Buffer.byteLength(String(prompt))).toBeLessThan(
      escapedPrompt.length,
    );
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
