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

import type { MuseProviderMode } from './muse-adapter-types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
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
export interface MuseRecord {
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

export type MuseTurnEffect =
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
      /** muse's own `call_id`; the ONLY tool identity the live stream emits. */
      toolCallId: string;
      toolName: string;
      /** Derived from `correlation_facts.outcome`, not guessed from presence. */
      status: 'success' | 'error';
      output: string | null;
    }
  | { kind: 'ignored' };

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
 * - `run_terminal{terminal,text,reason}` -> `turn.completed` when
 *   `terminal === 'completed'`, or `runtime.error` ONLY (never both;
 *   archive#3450) when it is not.
 *
 * Everything else is dropped ON PURPOSE:
 *
 * - `command_accepted`, `session_run_linked`, `turn_input_user`, `run_started`,
 *   `run_model_configured`, `task_stream_linked` restate what Station already
 *   published from `startSession`/`sendTurn`; re-emitting them duplicates
 *   transcript rows.
 * - `task_lifecycle` is an internal scheduler ping (proposed/accepted/
 *   scheduled/started/status/completed/failed). It names no tool, carries no
 *   arguments and no output, so synthesizing `tool.*` events from it would be
 *   a label with nothing deriving it.
 * - `tool_result` IS that payload, and is mapped: it carries `call_id`, plus
 *   `correlation_facts.{tool_name,outcome}` and the result `text`.
 * - No `tool.started` is emitted. `call_id` appears exactly once in a live
 *   turn — on `tool_result` — so a start event would have to borrow
 *   `task_lifecycle`'s `task_id`, and start/completion would then carry
 *   different ids that never pair. Arguments are likewise absent from the live
 *   stream (they exist only in `muse export`'s durable log), so
 *   `tool.started.arguments` would have nothing behind it either.
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
      // Without an id and a name there is nothing honest to attribute the
      // result to, and a synthesized id would never pair with anything.
      if (!toolCallId || !toolName) return { kind: 'ignored' };
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
    default:
      return { kind: 'ignored' };
  }
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
  args.push('--', input.prompt);
  return args;
}
