import { isAbsolute, join } from 'node:path';

export interface CodexRolloutTurnFixture {
  /** Provider turn identity is intentionally opaque; Codex does not require a UUID. */
  turnId: string;
  prompt: string;
  assistantText: string;
  status: 'completed' | 'in-progress';
}

export interface CodexRolloutFixtureInput {
  /** Native Codex thread/session identity used in session_meta and the filename. */
  nativeSessionId: string;
  cwd: string;
  createdAt: string;
  model: string;
  turns: readonly CodexRolloutTurnFixture[];
  cliVersion?: string;
}

export interface CodexRolloutFixture {
  nativeSessionId: string;
  /** Path relative to CODEX_HOME. */
  relativePath: string;
  /** Complete newline-terminated JSONL payload. */
  content: string;
  completedTurnIds: readonly string[];
  inProgressTurnIds: readonly string[];
}

type JsonRecord = Record<string, unknown>;

const NATIVE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_ID_BYTES = 512;
const MAX_TEXT_BYTES = 128 * 1024;

/**
 * Build a protocol-valid, authored Codex rollout. The helper creates bytes
 * only: callers own the isolated CODEX_HOME and all filesystem/process work.
 */
export function buildCodexRolloutFixture(
  input: CodexRolloutFixtureInput,
): CodexRolloutFixture {
  if (!NATIVE_UUID.test(input.nativeSessionId)) {
    throw new Error('Codex rollout fixture nativeSessionId must be a UUID.');
  }
  const cwd = boundedText(input.cwd, 'cwd');
  if (!isAbsolute(cwd)) {
    throw new Error('Codex rollout fixture cwd must be absolute.');
  }
  const model = boundedText(input.model, 'model');
  const cliVersion = boundedId(input.cliVersion ?? '0.146.1', 'cliVersion');
  const createdAtMs = Date.parse(input.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    throw new Error(
      'Codex rollout fixture createdAt must be an ISO timestamp.',
    );
  }
  if (input.turns.length === 0 || input.turns.length > 32) {
    throw new Error('Codex rollout fixture must contain 1 through 32 turns.');
  }

  const createdAt = new Date(createdAtMs).toISOString();
  const date = createdAt.slice(0, 10);
  const [year, month, day] = date.split('-');
  const filenameTimestamp = createdAt.slice(0, 19).replaceAll(':', '-');
  const records: JsonRecord[] = [
    envelope(createdAtMs, 0, 'session_meta', {
      session_id: input.nativeSessionId,
      id: input.nativeSessionId,
      timestamp: createdAt,
      cwd,
      originator: 'station-e2e-fixture',
      cli_version: cliVersion,
      source: 'cli',
      model_provider: null,
    }),
  ];
  const seenTurnIds = new Set<string>();
  const completedTurnIds: string[] = [];
  const inProgressTurnIds: string[] = [];
  let ordinal = 1;

  for (const turn of input.turns) {
    if (turn.status !== 'completed' && turn.status !== 'in-progress') {
      throw new Error('Codex rollout fixture turn status is invalid.');
    }
    const turnId = boundedId(turn.turnId, 'turnId');
    if (seenTurnIds.has(turnId)) {
      throw new Error(`Codex rollout fixture repeats turnId: ${turnId}`);
    }
    seenTurnIds.add(turnId);
    const prompt = boundedText(turn.prompt, 'prompt');
    const assistantText = boundedText(turn.assistantText, 'assistantText');
    records.push(
      envelope(createdAtMs, ordinal++, 'event_msg', {
        type: 'task_started',
        turn_id: turnId,
        model_context_window: null,
      }),
      envelope(createdAtMs, ordinal++, 'turn_context', {
        turn_id: turnId,
        cwd,
        current_date: date,
        timezone: 'UTC',
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        model,
        summary: 'auto',
      }),
      envelope(createdAtMs, ordinal++, 'event_msg', {
        type: 'user_message',
        message: prompt,
      }),
      envelope(createdAtMs, ordinal++, 'response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      }),
      envelope(createdAtMs, ordinal++, 'response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: assistantText }],
      }),
    );
    if (turn.status === 'completed') {
      records.push(
        envelope(createdAtMs, ordinal++, 'event_msg', {
          type: 'task_complete',
          turn_id: turnId,
          last_agent_message: assistantText,
        }),
      );
      completedTurnIds.push(turnId);
    } else {
      inProgressTurnIds.push(turnId);
    }
  }

  return Object.freeze({
    nativeSessionId: input.nativeSessionId,
    relativePath: join(
      'sessions',
      year!,
      month!,
      day!,
      `rollout-${filenameTimestamp}-${input.nativeSessionId}.jsonl`,
    ),
    content: `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    completedTurnIds: Object.freeze(completedTurnIds),
    inProgressTurnIds: Object.freeze(inProgressTurnIds),
  });
}

function envelope(
  createdAtMs: number,
  ordinal: number,
  type: string,
  payload: JsonRecord,
): JsonRecord {
  return {
    timestamp: new Date(createdAtMs + ordinal * 1_000).toISOString(),
    ordinal,
    type,
    payload,
  };
}

function boundedId(value: unknown, label: string): string {
  const text = boundedText(value, label);
  if (Buffer.byteLength(text) > MAX_ID_BYTES) {
    throw new Error(
      `Codex rollout fixture ${label} exceeds ${MAX_ID_BYTES} bytes.`,
    );
  }
  return text;
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > MAX_TEXT_BYTES
  ) {
    throw new Error(
      `Codex rollout fixture ${label} must be non-empty and at most ${MAX_TEXT_BYTES} bytes.`,
    );
  }
  return value;
}
