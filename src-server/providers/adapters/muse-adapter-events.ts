/**
 * Pure translation layer for the `muse exec --json` JSONL stream.
 *
 * Every function here is total: a malformed, truncated, or entirely unknown
 * line yields `null`/`{ kind: 'ignored' }` rather than throwing, because these
 * run inside a stdout data handler where a throw would tear down the turn.
 *
 * The small `isRecord`/`extractString` extractors are COPIED from
 * `codex-adapter-events.ts` rather than imported: this module must not depend
 * on the Codex adapter's lifetime or its JSON-RPC vocabulary.
 */

import type {
  MuseProviderMode,
  MuseToolTaskBinding,
} from './muse-adapter-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function extractString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function extractStringField(
  value: unknown,
  field: string,
): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return extractString(value[field]);
}

/**
 * One decoded JSONL record from `muse exec --json`.
 *
 * The envelope carries `{schema_version, id, stream, sequence, recorded_at,
 * record_type, payload{kind, ...}}`; only `record_type` and the payload are
 * load-bearing for translation, so the rest is deliberately not modeled.
 */
interface MuseRecord {
  recordType: string | null;
  payloadKind: string;
  payload: Record<string, unknown>;
}

/** Parses one stdout line. Returns `null` for blank/malformed/unshaped lines. */
export function parseMuseLine(line: string): MuseRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(decoded) || !isRecord(decoded.payload)) return null;
  const payloadKind = extractString(decoded.payload.kind);
  if (!payloadKind) return null;
  return {
    recordType: extractString(decoded.record_type),
    payloadKind,
    payload: decoded.payload,
  };
}

type MuseTurnEffect =
  | { kind: 'text-delta'; delta: string }
  | {
      kind: 'terminal';
      /** Raw `run_terminal.terminal` value, retained for the error message. */
      terminal: string | null;
      /** Raw `run_terminal.reason`, present only on some terminals. */
      reason: string | null;
      /**
       * `run_terminal.text` is the FULL turn text, not a trailing fragment —
       * callers must not append it to already-streamed deltas.
       */
      text: string | null;
      finishReason: 'stop' | 'cancelled' | 'other';
      completed: boolean;
    }
  | {
      kind: 'tool-completed';
      /** muse's own `call_id`; the tool identity the result is keyed by. */
      toolCallId: string;
      /**
       * `correlation_facts.tool_name`, or `null` when the record omits it.
       * The adapter pairs a nameless result with the `tool.started` it opened
       * for the same `call_id` and drops it otherwise.
       */
      toolName: string | null;
      /** Derived from `correlation_facts.outcome`, not guessed from presence. */
      status: 'success' | 'error';
      output: string | null;
    }
  | {
      kind: 'task-lifecycle';
      /** `task_lifecycle.event.task_id` (falls back to the payload's own). */
      taskId: string;
      /** `task_lifecycle.event.kind`: proposed/scheduled/started/completed/... */
      phase: string;
      /**
       * Tool name read from `event.task_kind` (`tool.<name>`); present only on
       * the `proposed` record of a tool task, `null` everywhere else.
       */
      toolName: string | null;
      /**
       * muse's tool `call_id`, read from `event.idempotency_key`
       * (`tool:<call_id>`); present only on a tool task's `scheduled` and
       * `side_effect_intent` records, `null` everywhere else.
       */
      toolCallId: string | null;
    }
  /**
   * #2300: `command_accepted` for muse's automatic follow-up run — the run
   * that reports background work which settled before it was submitted.
   */
  | { kind: 'background-follow-up' }
  | { kind: 'ignored' };

/**
 * #2300: the `command_accepted.client_id` muse stamps on the run it submits
 * by itself to report settled background work (live capture, muse
 * 1.3.0-R3401.1). Every run a user submits carries `client_id: null`.
 */
export const MUSE_BACKGROUND_FOLLOW_UP_CLIENT_ID =
  'muse-runtime-background-terminal';

/**
 * Maps a muse terminal to a canonical `finishReason`.
 *
 * `terminal` is the discriminator, not `reason`: in every captured run the
 * terminal carries the outcome (`"completed"`) while `reason` is `null`.
 * `reason` is only consulted when `terminal` is absent, so a future muse build
 * that moves the outcome there still classifies rather than defaulting.
 */
export function mapMuseFinishReason(
  terminal: string | null,
  reason: string | null,
): 'stop' | 'cancelled' | 'other' {
  const outcome = terminal ?? reason;
  if (outcome === 'completed') return 'stop';
  if (
    outcome === 'cancelled' ||
    outcome === 'canceled' ||
    outcome === 'interrupted' ||
    outcome === 'aborted'
  ) {
    return 'cancelled';
  }
  return 'other';
}

/**
 * Translates one decoded record into the effect the adapter should apply.
 *
 * Only two muse payload kinds carry canonical meaning today:
 *
 * - `run_output_delta{text}` -> `content.text-delta`
 * - `run_terminal{terminal,text,reason}` -> a `terminal` effect. What the
 *   adapter does with it depends on the turn (#2300): usually `turn.completed`
 *   when `terminal === 'completed'`, or `runtime.error` ONLY (never both;
 *   archive#3450) when it is not — but a completed terminal while background
 *   work the turn launched is still pending HOLDS the turn open, and muse's
 *   automatic follow-up run (and its own `run_terminal`) is delivered on the
 *   same turn. See `MuseAdapter`'s docblock.
 *
 * Everything else is dropped ON PURPOSE:
 *
 * - `command_accepted`, `session_run_linked`, `turn_input_user`, `run_started`,
 *   `run_model_configured`, `task_stream_linked` restate what Station already
 *   published from `startSession`/`sendTurn`; re-emitting them duplicates
 *   transcript rows. The one exception is a `command_accepted` whose
 *   `client_id` is {@link MUSE_BACKGROUND_FOLLOW_UP_CLIENT_ID}: nothing
 *   Station sent caused it, and it marks the start of the follow-up run that
 *   reports settled background work (#2300), so it becomes a
 *   `background-follow-up` effect (no event of its own).
 * - `tool_result` is mapped to `tool-completed`: it carries `call_id`, plus
 *   `correlation_facts.{tool_name,outcome}` and the result `text`.
 * - `task_lifecycle` (proposed/accepted/scheduled/side_effect_intent/started/
 *   output/status/completed/failed) is surfaced as a `task-lifecycle` effect
 *   so {@link observeMuseToolTask} can open a `tool.started`. Against muse
 *   0.2.1 this was dropped: its lifecycle records named no tool and carried
 *   no `call_id`, so a start could only have borrowed `task_id` and would
 *   never have paired with the result. Muse 1.3.0-R3401.1 (a live
 *   `muse exec --json` capture of a one-bash-call turn, kept verbatim as
 *   `__tests__/fixtures/muse-1.3-bash-tool-turn.jsonl`) names both on the
 *   tool's task: `proposed.task_kind` is `tool.bash`, and
 *   `scheduled.idempotency_key` / `side_effect_intent.idempotency_key` are
 *   `tool:<call_id>` — the same `call_id` its `tool_result` carries. Model
 *   and reminder tasks use other prefixes (`model.*`/`model:`,
 *   `reminder.*`/`reminder_child:`) and never open a tool.
 * - Arguments are still absent from the live stream (in the 1.3 capture the
 *   command first appears in `task_lifecycle.output`, after `started`), so
 *   `tool.started` carries no `arguments` rather than a guessed value.
 * - **No `token-usage.updated` is emitted, because the live envelope carries
 *   no usage kind to map (archive#4197 audit, muse 0.2.1-R1215.1).** Verified
 *   two ways: a live `muse exec --json --provider echo` run (full stream
 *   captured; `run_terminal` carries only `command_id`/`run_stream`/
 *   `terminal`/`text`/`reason`), and the binary's own exec-stream
 *   `payload_type` vocabulary (`run.output.delta`, `run.terminal.*`,
 *   `tool.result`, `todo.snapshot.updated`, `task.lifecycle.*`,
 *   `mcp.startup.*`, `reminder.cleanup_effect.*` — no usage member). Muse
 *   DOES account tokens internally (`provider_usage_reported` and per-run
 *   token telemetry appear in its durable session log / `muse export`
 *   structures), but that channel is not the `exec --json` stream this
 *   adapter consumes — so for muse sessions, the UI's "engine did not
 *   report token counts" statement is TRUE, and synthesizing usage from
 *   anything here would be fabrication. If a future muse build adds a usage
 *   payload kind to the exec stream, map it then — with a
 *   `PROVIDER_USAGE_SCOPE` declaration derived from that kind's actual
 *   semantics.
 */
export function translateMuseRecord(record: MuseRecord): MuseTurnEffect {
  switch (record.payloadKind) {
    case 'command_accepted':
      return extractStringField(record.payload, 'client_id') ===
        MUSE_BACKGROUND_FOLLOW_UP_CLIENT_ID
        ? { kind: 'background-follow-up' }
        : { kind: 'ignored' };
    case 'run_output_delta': {
      const delta = extractStringField(record.payload, 'text');
      if (delta === null || delta === '') return { kind: 'ignored' };
      return { kind: 'text-delta', delta };
    }
    case 'run_terminal': {
      const terminal = extractStringField(record.payload, 'terminal');
      const reason = extractStringField(record.payload, 'reason');
      return {
        kind: 'terminal',
        terminal,
        reason,
        text: extractStringField(record.payload, 'text'),
        finishReason: mapMuseFinishReason(terminal, reason),
        completed: terminal === 'completed',
      };
    }
    case 'tool_result': {
      // The payload the slice-1 comment said tool surfacing was waiting for.
      // Unlike `task_lifecycle`, this one actually describes a tool: it names
      // the tool, carries its output, and reports an outcome — so every field
      // below is read, not inferred.
      const toolCallId = extractStringField(record.payload, 'call_id');
      const facts = record.payload.correlation_facts;
      const factsRecord = isRecord(facts) ? facts : undefined;
      const toolName = factsRecord
        ? extractStringField(factsRecord, 'tool_name')
        : null;
      // Without an id there is nothing honest to attribute the result to, and
      // a synthesized id would never pair with anything. A missing name is
      // passed through as `null`: the adapter can still take it from the
      // start it opened under this `call_id`, and drops the result if none.
      if (!toolCallId) return { kind: 'ignored' };
      const outcome = factsRecord
        ? extractStringField(factsRecord, 'outcome')
        : null;
      return {
        kind: 'tool-completed',
        toolCallId,
        toolName,
        // muse reports the outcome explicitly; anything that is not an
        // observed success is reported as an error rather than assumed good.
        status: outcome === 'success' ? 'success' : 'error',
        output: extractStringField(record.payload, 'text'),
      };
    }
    case 'task_lifecycle': {
      const event = isRecord(record.payload.event)
        ? record.payload.event
        : undefined;
      const phase = event ? extractStringField(event, 'kind') : null;
      const taskId =
        (event ? extractStringField(event, 'task_id') : null) ??
        extractStringField(record.payload, 'task_id');
      if (!event || !phase || !taskId) return { kind: 'ignored' };
      return {
        kind: 'task-lifecycle',
        taskId,
        phase,
        toolName: stripNonEmptyPrefix(
          extractStringField(event, 'task_kind'),
          'tool.',
        ),
        toolCallId: stripNonEmptyPrefix(
          extractStringField(event, 'idempotency_key'),
          'tool:',
        ),
      };
    }
    default:
      return { kind: 'ignored' };
  }
}

function stripNonEmptyPrefix(
  value: string | null,
  prefix: string,
): string | null {
  if (value === null || !value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length);
  return rest.length > 0 ? rest : null;
}

/**
 * Task phases after which muse reports nothing further about the TASK. A
 * tool task's `tool_result` still follows `completed` and `failed` (results
 * are batched after the task's final phase, and a failed tool still gets
 * one), so neither closes an open tool; only `cancelled` does.
 */
const MUSE_TASK_FINAL_PHASES = new Set(['completed', 'failed', 'cancelled']);

/** What {@link observeMuseToolTask} tells the adapter to do, if anything. */
export type MuseToolTaskObservation =
  | { kind: 'started'; toolName: string; toolCallId: string }
  | { kind: 'cancelled'; toolName: string; toolCallId: string }
  /**
   * The task reached `completed` or `failed`: muse is no longer executing
   * the tool, but its `tool_result` (which carries the output) normally
   * follows, so the call stays open and pairable — it just stops being
   * in-flight work for idle supervision.
   */
  | {
      kind: 'finished';
      toolName: string;
      toolCallId: string;
      /** The task's final phase, which settle reports if no result arrives. */
      outcome: 'completed' | 'failed';
    };

/**
 * Folds one `task-lifecycle` effect into `bindings` (keyed by `task_id`) and
 * returns the tool start it completes, if any.
 *
 * A start is returned only when the same task has shown a `tool.<name>`
 * `task_kind`, a `tool:<call_id>` idempotency key, AND a `started` phase.
 * In the 1.3 capture the name and id are both known by `scheduled`, so the
 * start fires at `started`; the fold is order-independent anyway, so a
 * build that reports `started` before the binding still fires once the
 * binding lands. `started` rather than `scheduled`/`side_effect_intent` is
 * the trigger because it is the record that says the tool is executing —
 * a task still awaiting approval is not running. A muse build without these
 * fields never completes a binding, so it degrades to today's behavior: no
 * start, only the `tool_result` completion.
 *
 * Returns each binding's start at most once (`emitted`), and forgets a task
 * at its final phase. A task whose start was returned and which then reaches
 * `cancelled` returns a `cancelled` observation so the adapter can close the
 * open tool: muse reported it will not finish, so leaving it open would keep
 * the row running and the idle deadline disarmed for nothing. `completed` and
 * `failed` return `finished` instead: the row stays open for the
 * `tool_result` that normally follows, but the tool is no longer running. `maxEntries` bounds the map: oldest tasks are evicted first.
 * Once-per-`call_id` across tasks is the caller's job (the adapter keeps
 * its own per-turn record of started call ids).
 */
export function observeMuseToolTask(
  bindings: Map<string, MuseToolTaskBinding>,
  effect: Extract<MuseTurnEffect, { kind: 'task-lifecycle' }>,
  maxEntries: number,
): MuseToolTaskObservation | null {
  if (MUSE_TASK_FINAL_PHASES.has(effect.phase)) {
    const finished = bindings.get(effect.taskId);
    bindings.delete(effect.taskId);
    if (finished?.emitted && finished.toolName && finished.toolCallId) {
      const tool = {
        toolName: finished.toolName,
        toolCallId: finished.toolCallId,
      };
      return effect.phase === 'cancelled'
        ? { kind: 'cancelled', ...tool }
        : {
            kind: 'finished',
            ...tool,
            outcome: effect.phase === 'failed' ? 'failed' : 'completed',
          };
    }
    return null;
  }
  const isStart = effect.phase === 'started';
  let binding = bindings.get(effect.taskId);
  if (!binding) {
    // Only tasks that have shown tool evidence (or a start that evidence may
    // still follow) are remembered; everything else is not a tool candidate.
    if (!effect.toolName && !effect.toolCallId && !isStart) return null;
    if (bindings.size >= maxEntries) {
      const oldest = bindings.keys().next().value;
      if (oldest !== undefined) bindings.delete(oldest);
    }
    binding = { started: false };
    bindings.set(effect.taskId, binding);
  }
  if (effect.toolName) binding.toolName ??= effect.toolName;
  if (effect.toolCallId) binding.toolCallId ??= effect.toolCallId;
  if (isStart) binding.started = true;
  if (
    binding.emitted ||
    !binding.started ||
    !binding.toolName ||
    !binding.toolCallId
  ) {
    return null;
  }
  binding.emitted = true;
  return {
    kind: 'started',
    toolName: binding.toolName,
    toolCallId: binding.toolCallId,
  };
}

/**
 * #2300: the tool whose result can announce background work. Muse 1.3's
 * `workflow` tool returns immediately with `{"status":"launched","taskId":…}`
 * and runs the workflow in the background; the same `muse exec` process then
 * reports the task's `task_lifecycle` completion (keyed by that `taskId`) and
 * submits an automatic follow-up run before it exits.
 */
export const MUSE_BACKGROUND_LAUNCH_TOOL_NAME = 'workflow';

/**
 * Bound on the `tool_result.text` this adapter will parse for a launch
 * announcement. The live launch result is ~2 KB; `text` itself can approach
 * `MUSE_STDOUT_BUFFER_MAX_CHARS`, and parsing a megabyte per tool result to
 * look for one field is not worth it. A larger text is read as "not a launch"
 * — the turn then settles exactly as it did before #2300.
 */
export const MUSE_LAUNCH_RESULT_MAX_CHARS = 65_536;

/**
 * Shape a background `taskId` must have to become part of a persisted row id
 * (`muse-task:<taskId>`). Muse mints UUIDs; anything else — overlong, empty,
 * or carrying characters a row id should not — is refused, not truncated.
 */
const MUSE_BACKGROUND_TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Returns the background task id a `workflow` tool result announces, or
 * `null`. Total: a non-`workflow` tool, an oversized or malformed text, a
 * `status` other than `launched`, or a missing/ill-shaped `taskId` all yield
 * `null` (the result is still published as an ordinary tool completion).
 */
export function parseMuseLaunchedBackgroundTask(
  toolName: string | null | undefined,
  text: string | null,
): string | null {
  if (toolName !== MUSE_BACKGROUND_LAUNCH_TOOL_NAME) return null;
  if (text === null || text.length > MUSE_LAUNCH_RESULT_MAX_CHARS) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(decoded) || decoded.status !== 'launched') return null;
  const taskId = extractString(decoded.taskId);
  return taskId !== null && MUSE_BACKGROUND_TASK_ID.test(taskId)
    ? taskId
    : null;
}

/** The persisted tool-row id of a background task (see the adapter docblock). */
export function museBackgroundTaskRowId(taskId: string): string {
  return `muse-task:${taskId}`;
}

/**
 * Splits a stdout chunk into complete lines plus the trailing partial line to
 * carry into the next chunk. `muse exec --json` writes one JSON object per
 * line, but a chunk boundary can land mid-object.
 */
export function splitMuseLines(
  buffered: string,
  chunk: string,
): { lines: string[]; remainder: string } {
  const combined = buffered + chunk;
  const parts = combined.split('\n');
  const remainder = parts.pop() ?? '';
  return { lines: parts, remainder };
}

/**
 * Argv for one turn. The prompt is positional and always last, and is always
 * preceded by the `--` end-of-options separator.
 *
 * `--` is not cosmetic here: live-verified against muse 0.1.0-R708.1,
 * `muse exec --json --provider echo "--api-key-stdin"` exits with
 * `missing prompt` — the flag-shaped prompt is consumed as an option, so any
 * user message beginning with `-` breaks the turn outright. With `--` in
 * front, the same prompt reaches muse verbatim. It also closes the worse
 * case: `-w`/`--workspace` is state-mutating, so an unseparated prompt is a
 * user-controlled argv injection into the engine's own flag surface.
 */
export function buildMuseExecArgs(input: {
  sessionId: string;
  imagePaths?: string[];
  prompt: string;
  modelId?: string;
  cwd?: string;
  /**
   * Startup provider override, already narrowed to muse's own closed
   * vocabulary by {@link resolveMuseProviderOverride}. Omitted by default, and
   * omission is byte-identical to the argv Station has always built — muse's
   * own default (`meta`) then applies, exactly as before.
   *
   * Placed AFTER the `--session-id` pair rather than before it so the first
   * four elements of every invocation stay `exec --json --session-id <id>`
   * whether or not the knob is set; a stable prefix is what the adapter's
   * argv assertions read.
   */
  provider?: MuseProviderMode;
}): string[] {
  const args = ['exec', '--json', '--session-id', input.sessionId];
  if (input.provider) {
    args.push('--provider', input.provider);
  }
  // `--model` is validated by muse against its own catalog (an unknown id
  // exits 1 before any JSONL), so passing it is a real applied selection —
  // but muse rejects it outright under `--provider echo`: live-verified
  // against Muse Code 1.0.1-R1848.1, `muse exec --json --provider echo --model <id>`
  // exits 2 with `--model requires --provider meta` before emitting a single
  // JSONL line. So under `echo` the model is DROPPED rather than forwarded
  // into a turn that could only die — echo answers from the prompt alone and
  // has no model to select. Under no override, or under `meta`, the selection
  // is passed through unchanged.
  if (input.modelId && input.provider !== 'echo') {
    args.push('--model', input.modelId);
  }
  if (input.cwd) {
    args.push('--workspace', input.cwd);
  }
  for (const path of input.imagePaths ?? []) args.push('--image', path);
  args.push('--', input.prompt);
  return args;
}
