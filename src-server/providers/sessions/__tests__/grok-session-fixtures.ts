import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BASE_MS = Date.parse('2026-09-17T16:15:00.000Z');

/*
 * Fixtures reproduce the Grok Build CLI writer (xai-org/grok-build,
 * xai-grok-shell/src/session/storage): one directory per session under the
 * URL-encoded cwd, a `summary.json` index entry, and `updates.jsonl` lines
 * `{"timestamp":<unix seconds>,"method":...,"params":{sessionId,update,_meta}}`.
 * Key order and field names match lines observed from Grok 1.0.46; all text
 * is synthetic.
 */

export class Writer {
  private seq = 0;
  constructor(
    readonly sessionId: string,
    private readonly promptId = `${sessionId}-prompt`,
  ) {}

  private line(
    method: string,
    update: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): string {
    this.seq += 1;
    const agentTimestampMs = BASE_MS + this.seq * 1000;
    return `${JSON.stringify({
      timestamp: Math.floor(agentTimestampMs / 1000),
      method,
      params: {
        sessionId: this.sessionId,
        update,
        _meta: {
          eventId: `${this.sessionId}-${this.seq}`,
          agentTimestampMs,
          ...meta,
        },
      },
    })}\n`;
  }

  private streamMeta(updateType: string): Record<string, unknown> {
    return {
      totalTokens: 100,
      promptId: this.promptId,
      streamStartMs: BASE_MS,
      turnStartMs: BASE_MS,
      updateType,
    };
  }

  user(text: string, promptIndex: number, extra: Record<string, unknown> = {}) {
    return this.line(
      'session/update',
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
        _meta: { modelId: 'grok-build', promptIndex, ...extra },
      },
      {},
    );
  }

  thought(text: string) {
    return this.line(
      'session/update',
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text },
      },
      { ...this.streamMeta('AgentThoughtChunk'), chunkId: this.seq },
    );
  }

  message(text: string) {
    return this.line(
      'session/update',
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
      { ...this.streamMeta('AgentMessageChunk'), chunkId: this.seq },
    );
  }

  toolCall(id: string, name: string, input: Record<string, unknown>) {
    return this.line(
      'session/update',
      {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: `Run ${name}`,
        rawInput: input,
        _meta: {
          'x.ai/tool': {
            version: 1,
            name,
            kind: 'execute',
            namespace: 'builtin',
            label: name,
            read_only: false,
          },
        },
      },
      this.streamMeta('ToolCall'),
    );
  }

  toolBackfill(id: string, input: Record<string, unknown>) {
    return this.line(
      'session/update',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        kind: 'execute',
        title: 'Run command',
        locations: [],
        rawInput: input,
        _meta: { 'x.ai/tool': { version: 1, name: 'run_terminal_cmd' } },
      },
      this.streamMeta('ToolCallUpdate'),
    );
  }

  toolResult(id: string, status: 'completed' | 'failed', text: string) {
    return this.line(
      'session/update',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status,
        content: [{ type: 'content', content: { type: 'text', text } }],
        rawOutput: { type: 'Result', Result: { output: text } },
      },
      this.streamMeta('ToolCallUpdate'),
    );
  }

  plan(entries: Array<{ content: string; status: string }>) {
    return this.line(
      'session/update',
      {
        sessionUpdate: 'plan',
        entries: entries.map((entry) => ({ ...entry, priority: 'medium' })),
      },
      this.streamMeta('Plan'),
    );
  }

  turnCompleted(stopReason = 'end_turn') {
    return this.line(
      '_x.ai/session/update',
      {
        sessionUpdate: 'turn_completed',
        prompt_id: this.promptId,
        stop_reason: stopReason,
        usage: {
          inputTokens: 1200,
          outputTokens: 80,
          totalTokens: 1280,
          cachedReadTokens: 1000,
          cacheCreationTokens: 0,
          reasoningTokens: 20,
          modelCalls: 2,
          apiDurationMs: 900,
          costUsdTicks: 4,
          modelUsage: {},
          numTurns: 2,
        },
        elapsed_ms: 1000,
      },
      {},
    );
  }

  hook() {
    return this.line(
      '_x.ai/session/update',
      {
        sessionUpdate: 'hook_execution',
        event_name: 'SessionStart',
        runs: [],
      },
      {},
    );
  }

  compaction() {
    return this.line(
      '_x.ai/session/update',
      {
        sessionUpdate: 'compaction_checkpoint',
        checkpoint_id: 'checkpoint-1',
        prompt_index_at_compaction: 1,
        checkpoint_file: 'compaction_checkpoints/checkpoint-1.json',
        schema_version: 1,
        created_at: '2026-09-17T16:20:00.000000Z',
      },
      {},
    );
  }
}

export function sessionDir(
  home: string,
  cwd: string,
  sessionId: string,
  dirName = encodeURIComponent(cwd),
): string {
  const dir = join(home, 'sessions', dirName, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeSummary(
  dir: string,
  info: { id: string; cwd: string },
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      info,
      agent_id: 'agent',
      session_summary: 'Synthetic session',
      created_at: '2026-09-17T16:15:00.123456Z',
      updated_at: '2026-09-17T16:16:00.123456Z',
      num_messages: 3,
      num_chat_messages: 3,
      current_model_id: 'grok-build',
      chat_format_version: 1,
      grok_home: '~/.grok',
      agent_name: 'grok-build-plan',
      sandbox_profile: 'off',
      ...extra,
    }),
  );
}

export function grokSession(
  home: string,
  options: {
    sessionId?: string;
    cwd?: string;
    lines?: string;
    dirName?: string;
    summary?: Record<string, unknown>;
  } = {},
) {
  const sessionId = options.sessionId ?? '01a0b170-0000-7000-8000-000000000001';
  const cwd = options.cwd ?? '/work/project';
  const dir = sessionDir(home, cwd, sessionId, options.dirName);
  writeSummary(dir, { id: sessionId, cwd }, options.summary);
  const writer = new Writer(sessionId);
  const file = join(dir, 'updates.jsonl');
  writeFileSync(file, options.lines ?? writer.user('Hello', 0));
  return { sessionId, cwd, dir, file, writer };
}

export function oneTurn(
  writer: Writer,
  prompt: string,
  answer: string,
): string {
  return (
    writer.user(prompt, 0) + writer.message(answer) + writer.turnCompleted()
  );
}
