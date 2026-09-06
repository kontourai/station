import crypto from 'node:crypto';
import type {
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  TerminalReason,
} from '@anthropic-ai/claude-agent-sdk';
import { ENGINE_SESSION_BINDING_DEAD_CODE } from '@kontourai/station-contracts/provider';
import type {
  CanonicalRuntimeEvent,
  ToolOutputReceipt,
} from '@kontourai/station-contracts/runtime-events';
import type { ProviderSession } from '../adapter-shape.js';
import { reportedModelMetadata } from '../llm/effective-model-metadata.js';
import {
  classifyClaudeResultOutcome,
  claudeResultFailureText,
} from './claude-result-outcome.js';

/** A token figure is only usable when it is a finite, non-negative count. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Claude's primary token accounting, retaining only usable figures. A result
 * may carry a partial or malformed usage block after startup/crash failures;
 * omitted figures stay omitted while the total is derived from whichever
 * valid components the engine did report.
 */
function claudeTokenUsageFields(usage: unknown): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
} {
  if (!usage || typeof usage !== 'object') return {};
  const raw = usage as Record<string, unknown>;
  const promptTokens = tokenCount(raw.input_tokens);
  const completionTokens = tokenCount(raw.output_tokens);
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(promptTokens !== undefined || completionTokens !== undefined
      ? { totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0) }
      : {}),
  };
}

/**
 * Claude's cache accounting, mapped to the canonical field names. Every
 * field is emitted only when the engine reported it: an absent cache figure
 * means "not reported", and turning that into `0` would claim a measurement
 * (archive#3201).
 */
function claudeCacheUsageFields(usage: unknown): {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} {
  if (!usage || typeof usage !== 'object') return {};
  const raw = usage as Record<string, unknown>;
  const cacheReadTokens = tokenCount(raw.cache_read_input_tokens);
  const cacheWriteTokens = tokenCount(raw.cache_creation_input_tokens);
  return {
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

/**
 * Tokens occupying the context window on this request: the uncached prompt
 * plus cache reads plus cache creations, which is how Anthropic's usage
 * block decomposes one request's input. Returns nothing when the engine
 * reported no input figure at all — an unreported occupancy stays
 * unreported rather than becoming a zero-token context.
 */
function claudeContextOccupancyField(usage: unknown): {
  contextTokens?: number;
} {
  if (!usage || typeof usage !== 'object') return {};
  const raw = usage as Record<string, unknown>;
  const parts = [
    tokenCount(raw.input_tokens),
    tokenCount(raw.cache_read_input_tokens),
    tokenCount(raw.cache_creation_input_tokens),
  ];
  if (parts.every((part) => part === undefined)) return {};
  return {
    contextTokens: parts.reduce((sum: number, part) => sum + (part ?? 0), 0),
  };
}

/**
 * Claude's `stop_reason` for a turn the engine handed back to its SDK host
 * with a tool call it declined to run itself — the outcome of a `PreToolUse`
 * hook answering `permissionDecision: 'defer'`. The call itself arrives on
 * `result.deferred_tool_use`, and the engine will never emit a `tool_result`
 * for it: whatever executes it is the host's problem.
 */
const CLAUDE_DEFERRED_TOOL_STOP_REASON = 'tool_deferred';

/**
 * The `terminal_reason` values that name a deferral BY NAME rather than
 * leaving it to the `stop_reason` string. Typed against the SDK's own
 * `TerminalReason` union, so dropping or renaming either member breaks the
 * build here instead of quietly falling through to `'stop'` —
 * `'tool_deferred_unavailable'` in particular is a deferral Station would
 * otherwise only recognise if it happened to also set `stop_reason`.
 */
const CLAUDE_DEFERRED_TERMINAL_REASONS: readonly TerminalReason[] = [
  'tool_deferred',
  'tool_deferred_unavailable',
];

function claudeResultDeferredTurn(message: SDKMessage & { type: 'result' }) {
  const terminalReason =
    'terminal_reason' in message ? message.terminal_reason : undefined;
  return (
    (terminalReason !== undefined &&
      CLAUDE_DEFERRED_TERMINAL_REASONS.includes(terminalReason)) ||
    ('stop_reason' in message &&
      message.stop_reason === CLAUDE_DEFERRED_TOOL_STOP_REASON)
  );
}

/**
 * What a reader is told about a deferred tool call. Station has no executor
 * for one — it does not ask the engine to defer (`preToolPolicyHookOutput`,
 * claude-adapter.ts) — so the honest record is that the call did not run and
 * why, not the absence a client renders as "No result recorded".
 */
const CLAUDE_DEFERRED_TOOL_ERROR =
  'The engine handed this tool call back to Station to execute, which Station cannot do. The tool did not run.';

/**
 * The deferred call off a `result` message, when the engine reported one.
 *
 * `deferred_tool_use` is the SDK's own structured field (`SDKDeferredToolUse`)
 * and is the ONLY signal used here — deliberately not "every id still in
 * `activeToolCalls` when a result arrives", which would settle a backgrounded
 * `Task` (whose `tool_result` legitimately arrives after the turn ends, and
 * whose lifecycle `activeTasks`/`settleClaudeTask` owns) as a failure it is
 * not.
 */
function claudeDeferredToolUse(
  message: SDKMessage & { type: 'result' },
): { id: string; name?: string } | undefined {
  // Narrowed off the SDK type, not off a `Record<string, unknown>` cast: an
  // upstream rename of `deferred_tool_use` must break this compile rather than
  // silently return `undefined` forever and restore the original defect.
  const deferred =
    'deferred_tool_use' in message ? message.deferred_tool_use : undefined;
  if (!deferred || typeof deferred !== 'object') return undefined;
  const { id, name } = deferred as { id?: unknown; name?: unknown };
  if (typeof id !== 'string' || !id) return undefined;
  return {
    id,
    ...(typeof name === 'string' && name ? { name } : {}),
  };
}

export interface ClaudeMessageState {
  session: ProviderSession;
  activeTurnId?: string;
  /**
   * The one local turn whose prompt has actually entered the SDK queue.
   * `activeTurnId` is allocated earlier so setup can correlate activity, but
   * it is not provenance for an SDK result until this marker is set.
   */
  dispatchedTurnId?: string;
  /**
   * The exact turn for which Station has an in-flight, user-requested SDK
   * interrupt. Claude reports that intentional interruption as an
   * `is_error: true` result with `stop_reason: null`; without this identity,
   * the normal terminal-result mapper turns the stop receipt into a
   * `runtime.error` and overwrites the canceled lifecycle with Failed.
   */
  interruptingTurnId?: string;
  /**
   * The SDK result mapper consumed the structured error receipt for a
   * requested interruption. Claude can immediately rethrow that same receipt
   * from the Query iterator; the adapter catch consumes this marker so the
   * wrapper cannot re-enter the lifecycle as an unscoped `runtime.error`.
   */
  interruptedResultObserved?: boolean;
  lastSessionState: 'idle' | 'running' | 'requires_action';
  /**
   * archive#1182: the model reported by the most recent top-level
   * `assistant` SDK message's `message.model` (the actual Anthropic API
   * response field, not the `init` message's requested-model echo). Reset
   * to `undefined` at the start of each turn (`claude-adapter.ts`'s
   * `sendTurn`) so a turn that produces no assistant message before
   * completing does not inherit a stale value from the previous turn.
   */
  lastReportedModel?: string;
  /**
   * Live subagent/background tasks keyed by `task_id`, built from the SDK's
   * `task_started`/`task_updated` system messages and cleared on settle.
   * Lazily initialized so existing record constructors stay valid.
   */
  activeTasks?: Map<string, ClaudeActiveTask>;
  /**
   * `toolCallId → { toolName, turnId, terminalPublished }` for top-level
   * assistant `tool_use` blocks whose `tool_result` has not arrived yet.
   * Doubles as the replay guard: a `tool_result` for an untracked id (e.g.
   * resume replay) is ignored. `turnId` is the dispatched turn the call
   * belongs to, so a late result (a stopped turn's, or a backgrounded
   * Task's) lands on the turn that issued the call rather than on whichever
   * turn is active.
   *
   * Entries are settled by their own `tool_result`, by the SDK's deferral
   * report above, or — station#1558 — by the SESSION ending
   * (`settleUnresolvedClaudeToolCalls`), which is the one moment a still-open
   * call is provably never going to report. Never by a TURN ending, which
   * would falsely settle a backgrounded Task that legitimately outlives its
   * turn.
   *
   * A task settled through `settleClaudeTask` (its `task_updated` /
   * `task_notification` terminal) keeps its entry — the real `tool_result`
   * may still arrive and is still the authoritative output — but is marked
   * `terminalPublished` so the session-end settle does not contradict the
   * outcome the task already reported (station#1558 fix round, H1).
   */
  activeToolCalls?: Map<string, ClaudeActiveToolCall>;
  /**
   * archive#1827: set when a `result` message classified `terminal`
   * (`classifyClaudeResultOutcome`) has already been published as a
   * `runtime.error` for this record. The SDK re-throws the SAME failure a
   * moment later as a generic wrapped Error once the underlying `claude`
   * CLI process exits (see `claude-result-outcome.ts`'s doc comment) —
   * `consumeMessages`' catch (`claude-adapter.ts`) checks this flag so that
   * near-duplicate isn't published a second time as an unrelated raw-text
   * `runtime.error`.
   */
  terminalResultObserved?: boolean;
  /**
   * archive#3457: the assistant message currently streaming content blocks,
   * taken from the last `message_start` stream event's `message.id` (the
   * Anthropic message id, globally unique). Content-block `index` is only
   * unique WITHIN one message — index 0 recurs in every assistant message a
   * turn produces — so this is the discriminator that keeps two text blocks
   * either side of a tool call from collapsing onto one `itemId`. Lazily
   * minted when deltas arrive without a preceding `message_start`, which is
   * why the id is combined with `activeTurnId`: a stale lazily-minted key
   * must never let a later turn's index 0 reuse an earlier turn's value.
   */
  contentMessageKey?: string;
}

/**
 * The `itemId` for a Claude content delta: stable across every delta of one
 * content block, distinct for every other block and every other turn — the
 * contract documented on `ContentTextDeltaEvent.itemId`.
 *
 * The value this replaced, `${session_id}:${message.uuid}`, was per-CHUNK:
 * each `stream_event` is its own SDK message with its own `uuid`, so no two
 * deltas of the same block ever shared an id and any consumer grouping by
 * `itemId` saw one item per token (archive#3457).
 */
function claudeContentItemId(
  record: ClaudeMessageState,
  message: { session_id: string },
  streamEvent: { index?: unknown },
): string {
  // `index` is required on `content_block_delta` in the SDK's own event
  // type; the fallback only covers a shape that never reaches this code.
  const blockIndex =
    typeof streamEvent?.index === 'number' ? streamEvent.index : 0;
  record.contentMessageKey ??= crypto.randomUUID();
  const turnKey = record.activeTurnId ?? 'no-turn';
  return `${message.session_id}:${turnKey}:${record.contentMessageKey}:${blockIndex}`;
}

export interface ClaudeActiveTask {
  taskId: string;
  toolCallId: string;
  toolName: string;
  description: string;
  subagentType?: string;
  backgrounded?: boolean;
}

/** Namespace for Claude-Code-specific `extension.notification` events. */
export const CLAUDE_EXTENSION_NAMESPACE = 'claude-code';

interface MapClaudeMessageParams {
  provider: ProviderSession['provider'];
  record: ClaudeMessageState;
  message: SDKMessage;
  publish: (event: CanonicalRuntimeEvent) => void;
  /** Adapter-owned observability seam for dropped non-turn result messages. */
  logInfo?: (message: string, details: Record<string, unknown>) => void;
}

export function mapClaudeSdkMessage({
  provider,
  record,
  message,
  publish,
  logInfo,
}: MapClaudeMessageParams): void {
  const createdAt = new Date().toISOString();

  if (message.type === 'system' && message.subtype === 'init') {
    record.session.resumeCursor = message.session_id;
    record.session.cwd = message.cwd;
    record.session.model = message.model;
    record.session.status = 'ready';
    record.session.updatedAt = createdAt;
    publish({
      eventId: crypto.randomUUID(),
      provider,
      threadId: record.session.threadId,
      createdAt,
      method: 'session.configured',
      sessionId: record.session.threadId,
      model: message.model,
      cwd: message.cwd,
    });
    return;
  }

  if (
    message.type === 'system' &&
    message.subtype === 'session_state_changed'
  ) {
    const from = mapClaudeSessionState(record.lastSessionState);
    const to = mapClaudeSessionState(message.state);
    record.lastSessionState = message.state;
    record.session.status =
      message.state === 'running'
        ? 'running'
        : message.state === 'requires_action'
          ? 'ready'
          : 'ready';
    record.session.updatedAt = createdAt;
    const liveTasks =
      to === 'idle' && record.activeTasks?.size
        ? [...record.activeTasks.values()]
        : [];
    publish({
      eventId: crypto.randomUUID(),
      provider,
      threadId: record.session.threadId,
      createdAt,
      method: 'session.state-changed',
      sessionId: record.session.threadId,
      from,
      to,
      // The turn is honestly over (queued messages must drain), but
      // backgrounded work continues — clients can keep an activity
      // affordance alive off this reason plus the task/registry snapshot.
      reason: liveTasks.length > 0 ? 'background-tasks' : undefined,
    });
    if (liveTasks.length > 0) {
      publish({
        eventId: crypto.randomUUID(),
        provider,
        threadId: record.session.threadId,
        createdAt,
        method: 'extension.notification',
        namespace: CLAUDE_EXTENSION_NAMESPACE,
        type: 'task/registry',
        payload: {
          active: liveTasks.map((task) => ({
            taskId: task.taskId,
            toolCallId: task.toolCallId,
            description: task.description,
            subagentType: task.subagentType,
            backgrounded: task.backgrounded === true,
          })),
        },
      });
    }
    return;
  }

  if (message.type === 'system' && message.subtype === 'task_started') {
    if (message.skip_transcript === true) {
      // Ambient/housekeeping task — the SDK asks consumers to keep it out
      // of the inline transcript.
      return;
    }
    const toolCallId = message.tool_use_id ?? message.task_id;
    const toolName = claudeTaskToolName(message);
    if (!record.activeTasks) {
      record.activeTasks = new Map();
    }
    record.activeTasks.set(message.task_id, {
      taskId: message.task_id,
      toolCallId,
      toolName,
      description: message.description ?? '',
      subagentType: message.subagent_type,
    });
    publish({
      eventId: crypto.randomUUID(),
      provider,
      threadId: record.session.threadId,
      createdAt,
      turnId: record.activeTurnId,
      itemId: toolCallId,
      method: 'tool.started',
      toolCallId,
      toolName,
      arguments: {
        description: message.description,
        task_type: message.task_type,
        ...(message.prompt ? { prompt: message.prompt } : {}),
      },
    });
    return;
  }

  if (message.type === 'system' && message.subtype === 'task_progress') {
    const tracked = record.activeTasks?.get(message.task_id);
    if (!tracked) return;
    const detail = message.last_tool_name
      ? `${message.description} — ${message.last_tool_name}`
      : message.description;
    publish({
      eventId: crypto.randomUUID(),
      provider,
      threadId: record.session.threadId,
      createdAt,
      turnId: record.activeTurnId,
      itemId: tracked.toolCallId,
      method: 'tool.progress',
      toolCallId: tracked.toolCallId,
      message: detail || tracked.toolName,
      progress: undefined,
    });
    return;
  }

  if (message.type === 'system' && message.subtype === 'task_updated') {
    const tracked = record.activeTasks?.get(message.task_id);
    if (!tracked) return;
    if (typeof message.patch?.is_backgrounded === 'boolean') {
      tracked.backgrounded = message.patch.is_backgrounded;
    }
    if (typeof message.patch?.description === 'string') {
      tracked.description = message.patch.description;
    }
    const terminal = mapClaudeTaskStatus(message.patch?.status);
    if (terminal) {
      settleClaudeTask({
        provider,
        record,
        publish,
        createdAt,
        task: tracked,
        status: terminal,
        summary: message.patch?.error,
      });
    }
    return;
  }

  if (message.type === 'system' && message.subtype === 'task_notification') {
    const tracked = record.activeTasks?.get(message.task_id);
    const status = mapClaudeTaskStatus(message.status);
    // SDK/CLI version skew must not turn an unrecognised terminal status into
    // a persisted task success. This matches task_updated's no-op contract.
    if (!status) return;
    if (tracked) {
      settleClaudeTask({
        provider,
        record,
        publish,
        createdAt,
        task: tracked,
        status,
        summary: message.summary,
      });
    } else if (message.skip_transcript !== true) {
      // Untracked settle (e.g. task started before this process attached):
      // still let the client clear any stale activity affordance.
      publish({
        eventId: crypto.randomUUID(),
        provider,
        threadId: record.session.threadId,
        createdAt,
        method: 'extension.notification',
        namespace: CLAUDE_EXTENSION_NAMESPACE,
        type: 'task/settled',
        payload: {
          taskId: message.task_id,
          status,
          summary: message.summary,
        },
      });
    }
    return;
  }

  if (message.type === 'system' && message.subtype === 'thinking_tokens') {
    publish({
      eventId: crypto.randomUUID(),
      provider,
      threadId: record.session.threadId,
      createdAt,
      turnId: record.activeTurnId,
      method: 'extension.notification',
      namespace: CLAUDE_EXTENSION_NAMESPACE,
      type: 'thinking/tokens',
      payload: {
        estimatedTokens: message.estimated_tokens,
        estimatedTokensDelta: message.estimated_tokens_delta,
      },
    });
    return;
  }

  if (message.type === 'system' && message.subtype === 'status') {
    publish({
      eventId: crypto.randomUUID(),
      provider,
      threadId: record.session.threadId,
      createdAt,
      turnId: record.activeTurnId,
      method: 'extension.notification',
      namespace: CLAUDE_EXTENSION_NAMESPACE,
      type: 'session/status',
      // `status: null` is the SDK's "status cleared" signal — forward it so
      // clients drop the hint.
      payload: {
        status: message.status ?? null,
        ...(message.compact_result
          ? { compactResult: message.compact_result }
          : {}),
      },
    });
    return;
  }

  if (message.type === 'stream_event') {
    const streamEvent = message.event as any;
    if (streamEvent?.type === 'message_start') {
      // A new assistant message opens: every content-block index that
      // follows belongs to it, not to the previous message's blocks.
      record.contentMessageKey =
        typeof streamEvent.message?.id === 'string'
          ? streamEvent.message.id
          : crypto.randomUUID();
      return;
    }
    const itemId = claudeContentItemId(record, message, streamEvent);
    if (
      streamEvent?.type === 'content_block_delta' &&
      streamEvent.delta?.type === 'text_delta' &&
      typeof streamEvent.delta.text === 'string'
    ) {
      publish({
        eventId: crypto.randomUUID(),
        provider,
        threadId: record.session.threadId,
        createdAt,
        turnId: record.activeTurnId,
        itemId,
        method: 'content.text-delta',
        delta: streamEvent.delta.text,
      });
    }
    if (
      streamEvent?.type === 'content_block_delta' &&
      streamEvent.delta?.type === 'thinking_delta' &&
      typeof streamEvent.delta.thinking === 'string'
    ) {
      publish({
        eventId: crypto.randomUUID(),
        provider,
        threadId: record.session.threadId,
        createdAt,
        turnId: record.activeTurnId,
        itemId,
        method: 'content.reasoning-delta',
        delta: streamEvent.delta.thinking,
      });
    }
    return;
  }

  if (message.type === 'tool_progress') {
    publish({
      eventId: crypto.randomUUID(),
      provider,
      threadId: record.session.threadId,
      createdAt,
      turnId: record.activeTurnId,
      itemId: message.tool_use_id,
      method: 'tool.progress',
      toolCallId: message.tool_use_id,
      message: `Running ${message.tool_name}`,
      progress: undefined,
    });
    return;
  }

  if (message.type === 'result') {
    const resultTurnId =
      message.is_error && record.interruptingTurnId
        ? record.interruptingTurnId
        : record.activeTurnId;
    publish({
      eventId: crypto.randomUUID(),
      provider,
      threadId: record.session.threadId,
      createdAt,
      turnId: resultTurnId,
      method: 'token-usage.updated',
      ...claudeTokenUsageFields(message.usage),
      // Cache figures Claude reports on every result and Station used to
      // discard, so the session fold and the per-turn envelope now see the
      // same fields the transcript importer already maps
      // (`decodeClaudeUsage`, `claude-transcript-session-source.ts`).
      ...claudeCacheUsageFields(message.usage),
      // The tokens this request actually put in front of the model — the
      // uncached prompt plus what was read from and written to the cache.
      // Claude reports the parts, not the sum, and this event is the only
      // place the parts are all present; `contextWindowTokens` is
      // deliberately absent because the engine does not report the window
      // size (the model inventory resolves that upstream). Per-turn in a
      // streaming-input session, so the LATEST one is current occupancy —
      // which is why the fold keeps the latest rather than summing.
      ...claudeContextOccupancyField(message.usage),
      // archive#1299 item 4: Claude reports what the query cost, so carry
      // it verbatim rather than recomputing it from tokens against a local
      // price table. NOTE the scope mismatch on this one message — the
      // usage fields above are per-turn, while `total_cost_usd` is the
      // running total for the whole `query()` call. `PROVIDER_COST_SCOPE`
      // in `@kontourai/station-shared/usage-fold` is where that is
      // declared; summing this field per turn would multiply the session's
      // cost. Guarded because a crashed/startup-error result can carry a
      // missing or non-numeric value, and an unreported cost must stay
      // unreported rather than becoming a reported zero.
      ...(typeof message.total_cost_usd === 'number' &&
      Number.isFinite(message.total_cost_usd) &&
      message.total_cost_usd >= 0
        ? { reportedCostUsd: message.total_cost_usd }
        : {}),
    });
    // archive#1827: `is_error` is the SDK's own structured protocol flag on
    // this message — set from its message shape, never from parsing the
    // engine's English (see `classifyClaudeResultOutcome`'s doc comment).
    // Folding a `terminal` result into `turn.completed` (as this branch
    // used to, unconditionally) discarded the ONE structured sighting of
    // the failure and rendered the engine's raw error text as if it were a
    // normal assistant reply — the STRUCTURED signal `consumeMessages`'
    // catch (`claude-adapter.ts`) never sees, because by the time the SDK
    // re-throws, the underlying is_error flag is gone. Publishing
    // `runtime.error` here instead lets the caller mark this binding dead
    // exactly once, from the exact signal that proves it.
    if (classifyClaudeResultOutcome(message) === 'terminal') {
      const turnId = record.activeTurnId;
      const interruptingTurnId = record.interruptingTurnId;
      if (interruptingTurnId) {
        record.interruptingTurnId = undefined;
        record.interruptedResultObserved = true;
        // A new turn can be queued before Claude emits the stopped turn's
        // result. Consume the older interruption receipt without clearing the
        // newer turn's provenance.
        if (
          turnId === interruptingTurnId &&
          record.dispatchedTurnId === interruptingTurnId
        ) {
          clearClaudeDispatchedTurn(record);
        }
        logInfo?.('Dropped Claude error result for requested interruption', {
          threadId: record.session.threadId,
          turnId: interruptingTurnId,
          resultKind: 'requested-interruption',
        });
        return;
      }
      record.terminalResultObserved = true;
      clearClaudeDispatchedTurn(record);
      publish({
        eventId: crypto.randomUUID(),
        provider,
        threadId: record.session.threadId,
        createdAt,
        turnId,
        method: 'runtime.error',
        severity: 'error',
        code: ENGINE_SESSION_BINDING_DEAD_CODE,
        retriable: false,
        message: claudeResultFailureText(message),
      });
      return;
    }
    // Claude emits a successful `result` for resume/init handshakes. It has
    // normal result fields (including usage), but `num_turns: 0` proves the
    // runtime did not execute Station's queued prompt. In particular, do not
    // let an ID allocated while sendTurn was doing async setup lend this
    // handshake false provenance.
    if (message.num_turns === 0) {
      logInfo?.('Dropped Claude handshake result before lifecycle mapping', {
        threadId: record.session.threadId,
        resultKind: 'resume-init-handshake',
        numTurns: message.num_turns,
        inheritedActiveTurnId: record.activeTurnId,
        dispatchedTurnId: record.dispatchedTurnId,
      });
      return;
    }
    // A non-error result proves the in-flight exchange completed normally.
    // An older Stop marker cannot apply to a later result after this ordered
    // stream point, so do not let it suppress a future genuine failure.
    record.interruptingTurnId = undefined;
    if (
      record.activeTurnId &&
      record.dispatchedTurnId === record.activeTurnId
    ) {
      const turnId = record.activeTurnId;
      // A turn the engine ended by handing a tool call back to its host: the
      // call is unresolved and will stay that way. Settle it as the error it
      // is, before the completion, so the transcript carries a reason instead
      // of a started call with no outcome (#1536 finding B1) — and so this
      // class can never again read as an ordinary stop, whatever produced it.
      const deferred = claudeDeferredToolUse(message);
      const deferredTurn =
        Boolean(deferred) || claudeResultDeferredTurn(message);
      // The name comes from the tracked `tool_use` this call was started from,
      // or from the engine's own report of it — never invented: with neither,
      // the completion is skipped and `finishReason` below carries the signal
      // on its own, because a `tool.completed` naming a placeholder tool is a
      // worse record than one fewer event.
      const deferredToolName = deferred
        ? (record.activeToolCalls?.get(deferred.id)?.toolName ?? deferred.name)
        : undefined;
      if (deferred && deferredToolName) {
        record.activeToolCalls?.delete(deferred.id);
        publish({
          eventId: crypto.randomUUID(),
          provider,
          threadId: record.session.threadId,
          createdAt,
          turnId,
          itemId: deferred.id,
          method: 'tool.completed',
          toolCallId: deferred.id,
          toolName: deferredToolName,
          status: 'error',
          error: CLAUDE_DEFERRED_TOOL_ERROR,
        });
      }
      clearClaudeDispatchedTurn(record);
      publish({
        eventId: crypto.randomUUID(),
        provider,
        threadId: record.session.threadId,
        createdAt,
        turnId,
        method: 'turn.completed',
        // `'other'` — not `'stop'` and not `'tool-calls'` — for a deferral:
        // the turn did not reach a self-reported outcome, and `'other'`
        // deliberately carries no clear authority
        // (`PROVIDER_PROVEN_FINISH_REASONS`, finish-reason-authority.ts), so
        // it cannot supersede a recorded runtime error or clear auth health.
        finishReason: deferredTurn
          ? 'other'
          : message.stop_reason === 'tool_use'
            ? 'tool-calls'
            : 'stop',
        outputText:
          message.type === 'result' && 'result' in message
            ? message.result
            : undefined,
        // archive#1182: `record.lastReportedModel` is the SDK's own
        // `assistant` message's `message.model` (the Anthropic Messages API
        // response's resolved model, e.g. an alias like the "fable" family
        // resolves to its underlying snapshot) — a structured API field,
        // never text parsed out of the assistant's own reply. Absent when no
        // assistant message arrived this turn (e.g. an immediate error).
        ...(record.lastReportedModel
          ? { metadata: reportedModelMetadata(record.lastReportedModel) }
          : {}),
      });
    } else {
      // A result can arrive while sendTurn has allocated an ID but not yet
      // queued its prompt, or after a previous result cleared that marker.
      // Usage remains useful; a lifecycle completion would be fabricated.
      logInfo?.('Dropped Claude result without a dispatched local turn', {
        threadId: record.session.threadId,
        resultKind: 'non-dispatched-terminal',
        inheritedActiveTurnId: record.activeTurnId,
        dispatchedTurnId: record.dispatchedTurnId,
      });
    }
    return;
  }

  if (message.type === 'assistant') {
    // archive#1182: capture the runtime-reported model off every top-level
    // assistant message (the `init` system message's `model` merely echoes
    // what Station requested — see effective-model-metadata.ts's docblock
    // and the incident this ticket traces — but each assistant message's
    // `message.model` comes back from the actual Anthropic API response
    // after resolution, so it can genuinely disagree with what was
    // requested). Captured before the tool_use-only filtering below so a
    // pure-text or pure-tool-call assistant message both count.
    if (
      message.parent_tool_use_id === null &&
      typeof message.message?.model === 'string' &&
      message.message.model.trim()
    ) {
      record.lastReportedModel = message.message.model.trim();
    }
    // Surface top-level tool calls as canonical tool.started events so the
    // UI shows "Running Bash…"-style activity immediately, even for fast
    // tools that never emit SDK `tool_progress`. Subagent-internal calls
    // (`parent_tool_use_id != null`) stay out of the main transcript.
    if (message.parent_tool_use_id !== null) return;
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (
        !block ||
        typeof block !== 'object' ||
        (block as { type?: string }).type !== 'tool_use'
      ) {
        continue;
      }
      const toolUse = block as { id?: string; name?: string; input?: unknown };
      if (typeof toolUse.id !== 'string' || typeof toolUse.name !== 'string') {
        continue;
      }
      if (!record.activeToolCalls) {
        record.activeToolCalls = new Map();
      }
      record.activeToolCalls.set(toolUse.id, {
        toolName: toolUse.name,
        turnId: record.activeTurnId,
      });
      publish({
        eventId: crypto.randomUUID(),
        provider,
        threadId: record.session.threadId,
        createdAt,
        turnId: record.activeTurnId,
        itemId: toolUse.id,
        method: 'tool.started',
        toolCallId: toolUse.id,
        toolName: toolUse.name,
        arguments: toolUse.input,
      });
    }
    return;
  }

  if (message.type === 'user') {
    // Close out tracked tool calls when their tool_result arrives. Only ids
    // recorded from a live assistant tool_use are honored, which naturally
    // ignores resume replays and subagent-internal results.
    if (message.parent_tool_use_id !== null) return;
    const content = (message.message as { content?: unknown })?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (
        !block ||
        typeof block !== 'object' ||
        (block as { type?: string }).type !== 'tool_result'
      ) {
        continue;
      }
      const toolResult = block as {
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      };
      const toolCallId = toolResult.tool_use_id;
      if (typeof toolCallId !== 'string') continue;
      const tracked = record.activeToolCalls?.get(toolCallId);
      if (!tracked) continue;
      const toolName = tracked.toolName;
      record.activeToolCalls?.delete(toolCallId);
      publish({
        eventId: crypto.randomUUID(),
        provider,
        threadId: record.session.threadId,
        createdAt,
        // The turn that issued the tool_use, not whichever turn is active
        // now: a stopped turn's delayed result must not land on its
        // successor (the #921 window), or the provenance fold sees a start
        // without a completion on one turn and the reverse on the other.
        turnId: tracked.turnId ?? record.activeTurnId,
        itemId: toolCallId,
        method: 'tool.completed',
        toolCallId,
        toolName,
        status: toolResult.is_error === true ? 'error' : 'success',
        output: summarizeClaudeToolResult(toolResult.content),
        ...(claudeToolResultOutputReceipt(toolResult.content)
          ? { outputReceipt: claudeToolResultOutputReceipt(toolResult.content) }
          : {}),
      });
    }
    return;
  }

  if (message.type === 'auth_status' && message.error) {
    publish({
      eventId: crypto.randomUUID(),
      provider,
      threadId: record.session.threadId,
      createdAt,
      method: 'runtime.warning',
      severity: 'warning',
      message: message.error,
    });
  }
}

interface ClaudeActiveToolCall {
  toolName: string;
  turnId?: string;
  /**
   * station#1558 (fix round, H1): a terminal `tool.completed` has already
   * been published for this call id by a path that does NOT remove the entry
   * — today only `settleClaudeTask`, whose Task terminal arrives before (and
   * independently of) the `tool_result` the entry is still waiting for.
   * The session-end settle skips these: publishing `unresolved` for a call
   * the engine already reported as succeeded would contradict it.
   */
  terminalPublished?: true;
}

/**
 * station#1558: what a reader is told about a `tool_use` that was still open
 * when its SESSION ended.
 *
 * The two honest facts are that no result was reported and that Station
 * cannot tell whether the tool ran — the engine process is gone, and a
 * `tool_result` it may or may not have produced went with it. Anything more
 * specific ("the tool failed", "the call was cancelled") would be a claim
 * nothing observed.
 */
export const CLAUDE_UNRESOLVED_TOOL_OUTPUT =
  'No result was reported before the session ended; whether the tool ran is unknown.';

/**
 * Settle every `tool_use` still tracked in `record.activeToolCalls` as
 * `status: 'unresolved'` (station#1558).
 *
 * Called ONLY when the SESSION ends — `stopSession`, and the end of
 * `consumeMessages` (the SDK iterator finishing or throwing, i.e. the
 * `claude` process exiting). Never on a turn ending: `activeToolCalls`
 * deliberately outlives its turn so a backgrounded `Task`'s legitimately
 * late `tool_result` still settles the real call (see that field's
 * docblock), and settling at a turn boundary would fabricate a non-outcome
 * for a call that is still perfectly capable of producing a real one.
 *
 * Each entry is settled on the turn that ISSUED it (`tracked.turnId`), not
 * on whichever turn was active last — the same rule the real `tool_result`
 * path follows. The map is cleared before publishing, so a session that ends
 * through both paths settles each call exactly once and never touches an
 * entry that was already settled by its own result or by the SDK's deferral
 * report (both remove the entry) — nor one whose terminal a settled Task
 * already published (`terminalPublished`, skipped below).
 */
export function settleUnresolvedClaudeToolCalls({
  provider,
  record,
  publish,
  createdAt,
}: {
  provider: ProviderSession['provider'];
  record: ClaudeMessageState;
  publish: (event: CanonicalRuntimeEvent) => void;
  createdAt?: string;
}): void {
  const open = record.activeToolCalls;
  if (!open || open.size === 0) return;
  const settledAt = createdAt ?? new Date().toISOString();
  const entries = [...open];
  open.clear();
  for (const [toolCallId, tracked] of entries) {
    // station#1558 (fix round, H1): a call whose terminal was already
    // published (a settled backgrounded Task) is not unresolved — its outcome
    // was reported, only its `tool_result` never came back. Publishing
    // `unresolved` here would contradict that outcome with a second terminal.
    if (tracked.terminalPublished) continue;
    publish({
      eventId: crypto.randomUUID(),
      provider,
      threadId: record.session.threadId,
      createdAt: settledAt,
      ...(tracked.turnId !== undefined ? { turnId: tracked.turnId } : {}),
      itemId: toolCallId,
      method: 'tool.completed',
      toolCallId,
      toolName: tracked.toolName,
      status: 'unresolved',
      output: CLAUDE_UNRESOLVED_TOOL_OUTPUT,
    });
  }
}

function clearClaudeDispatchedTurn(record: ClaudeMessageState): void {
  record.activeTurnId = undefined;
  record.dispatchedTurnId = undefined;
}

function claudeTaskToolName(message: {
  subagent_type?: string;
  task_type?: string;
  workflow_name?: string;
}): string {
  if (message.subagent_type) return `Task (${message.subagent_type})`;
  if (message.task_type === 'local_workflow' && message.workflow_name) {
    return `Workflow (${message.workflow_name})`;
  }
  return 'Task';
}

/**
 * Map SDK task statuses (both `task_notification.status` and
 * `task_updated.patch.status`) to canonical `tool.completed` statuses.
 * Returns undefined for non-terminal or unknown values so callers can
 * treat SDK/CLI version skew as a no-op.
 */
export function mapClaudeTaskStatus(
  status: string | undefined,
): 'success' | 'error' | 'cancelled' | undefined {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'stopped':
    case 'killed':
      return 'cancelled';
    default:
      return undefined;
  }
}

function settleClaudeTask(params: {
  provider: ProviderSession['provider'];
  record: ClaudeMessageState;
  publish: (event: CanonicalRuntimeEvent) => void;
  createdAt: string;
  task: ClaudeActiveTask;
  status: 'success' | 'error' | 'cancelled';
  summary?: string;
}): void {
  const { provider, record, publish, createdAt, task, status, summary } =
    params;
  record.activeTasks?.delete(task.taskId);
  // station#1558 (fix round, H1): this publishes the call's terminal, but the
  // `tool_use` entry stays — the real `tool_result` can still arrive and is
  // still the authoritative output, and dropping the entry would make the
  // replay guard swallow it. Marking it is what stops the session-end settle
  // from publishing a second, contradicting `unresolved` terminal for a Task
  // that reported success.
  const trackedCall = record.activeToolCalls?.get(task.toolCallId);
  if (trackedCall) trackedCall.terminalPublished = true;
  publish({
    eventId: crypto.randomUUID(),
    provider,
    threadId: record.session.threadId,
    createdAt,
    turnId: record.activeTurnId,
    itemId: task.toolCallId,
    method: 'tool.completed',
    toolCallId: task.toolCallId,
    toolName: task.toolName,
    status,
    output: summary,
    error: status === 'error' ? summary : undefined,
  });
  // Also settle via extension.notification: after the turn's bubble is
  // archived, tool parts are frozen, so this is the client's post-turn
  // signal to clear the background-activity affordance.
  publish({
    eventId: crypto.randomUUID(),
    provider,
    threadId: record.session.threadId,
    createdAt,
    method: 'extension.notification',
    namespace: CLAUDE_EXTENSION_NAMESPACE,
    type: 'task/settled',
    payload: {
      taskId: task.taskId,
      toolCallId: task.toolCallId,
      description: task.description,
      status,
      summary,
    },
  });
}

const CLAUDE_TOOL_RESULT_OUTPUT_LIMIT = 2000;

/**
 * The receipt for the head-slice {@link summarizeClaudeToolResult} performs,
 * or undefined when nothing was dropped (archive#4237).
 *
 * Without this, a consumer of `tool.completed` cannot tell a complete output
 * from the first 2000 characters of a long one — and the command-evidence
 * spool was recording the head slice as a complete output whose "tail" was
 * in fact its beginning. ACP already emits a receipt for the same reason
 * (`acp-tool-update-supervisor.ts`); this brings the Claude path level.
 *
 * `strategy` is `utf8-tail` to match the vocabulary, though this projection
 * keeps the HEAD — the receipt's job is to say bytes were dropped and how
 * many, which is what a reader needs in order not to trust completeness.
 */
export function claudeToolResultOutputReceipt(
  content: unknown,
): ToolOutputReceipt | undefined {
  const summary = summarizeClaudeToolResult(content);
  if (summary === undefined) return undefined;
  const retainedBytes = Buffer.byteLength(summary, 'utf8');
  if (summary.length < CLAUDE_TOOL_RESULT_OUTPUT_LIMIT) return undefined;
  const full = fullClaudeToolResultText(content);
  const omittedBytesAtLeast = Math.max(
    0,
    Buffer.byteLength(full, 'utf8') - retainedBytes,
  );
  if (omittedBytesAtLeast === 0) return undefined;
  return {
    truncated: true,
    reasons: ['bytes'],
    retainedBytes,
    omittedBytesAtLeast,
    omittedUpdates: 0,
    strategy: 'utf8-tail',
    fullOutput: 'unavailable',
  };
}

/** The untruncated text {@link summarizeClaudeToolResult} slices. */
function fullClaudeToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function summarizeClaudeToolResult(
  content: unknown,
): string | undefined {
  if (typeof content === 'string') {
    return content.slice(0, CLAUDE_TOOL_RESULT_OUTPUT_LIMIT);
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .filter(Boolean)
      .join('\n');
    return text ? text.slice(0, CLAUDE_TOOL_RESULT_OUTPUT_LIMIT) : undefined;
  }
  return undefined;
}

export function mapClaudeSessionState(
  state: 'idle' | 'running' | 'requires_action',
): 'idle' | 'running' | 'awaiting-approval' {
  if (state === 'requires_action') {
    return 'awaiting-approval';
  }
  return state;
}

/**
 * Map an adapter-level permission decision plus the original `toolInput`
 * and any SDK-proposed `PermissionUpdate` suggestions into the exact
 * `PermissionResult` shape the `@anthropic-ai/claude-agent-sdk` control
 * protocol requires (`sdk.d.ts` `PermissionResult`). Mirrors the ACP
 * adapter's `mapAcpDecisionToOutcome` pattern: pure, exported, and
 * directly unit-testable against the documented SDK contract.
 *
 * `accept`/`acceptForSession` resolve to the `allow` variant and always
 * echo `toolInput` verbatim as `updatedInput` (Station does not expose an
 * input-editing UI in the approval flow). `acceptForSession` additionally
 * forwards `updatedPermissions`, forcing every suggested
 * `PermissionUpdate.destination` to `'session'` regardless of what the SDK
 * proposed, so "for this session" is honest even when the SDK suggested a
 * disk-persisted destination like `'localSettings'`. `decline`/`cancel`
 * resolve to the `deny` variant; `cancel` additionally sets `interrupt`.
 */
export function mapClaudeDecisionToPermissionResult(
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  toolInput: Record<string, unknown>,
  suggestions: PermissionUpdate[] | undefined,
): PermissionResult {
  if (decision === 'accept' || decision === 'acceptForSession') {
    return {
      behavior: 'allow',
      updatedInput: toolInput,
      updatedPermissions:
        decision === 'acceptForSession'
          ? suggestions?.map((update) => ({
              ...update,
              destination: 'session',
            }))
          : undefined,
    };
  }

  if (decision === 'decline') {
    return {
      behavior: 'deny',
      message: 'User declined the permission request.',
    };
  }

  return {
    behavior: 'deny',
    message: 'User cancelled the permission request.',
    interrupt: true,
  };
}
