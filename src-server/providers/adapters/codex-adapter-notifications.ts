import crypto from 'node:crypto';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { adapterTurnDuration, providerOps } from '../../telemetry/metrics.js';
import {
  deriveToolArguments,
  deriveToolName,
  deriveToolOutput,
  extractString,
  extractTokenFigure,
  extractToolError,
  extractToolStatus,
  isRecord,
  mapSessionStatus,
  mapThreadStatusToState,
  mapToolCompletionStatus,
  mapTurnFinishReason,
} from './codex-adapter-events.js';
import type { CodexSessionRecord } from './codex-adapter-types.js';
import { projectCodexToolOutput } from './codex-tool-output.js';
import { UNRESOLVED_TOOL_OUTPUT } from './unresolved-tool-output.js';

/**
 * station#1569 (item 4): settle every tool item still open when the SESSION
 * ends as `tool.completed` status `'unresolved'` — the terminal the Claude
 * adapter publishes for the same moment
 * (`settleUnresolvedClaudeToolCalls`).
 *
 * Until this existed, a `tool.started` whose completion never arrived got no
 * terminal at all: `publishOrphanedTurnFailure` closes the orphaned TURN with
 * a `runtime.error`, which tells a reader the turn ended badly but leaves
 * every individual tool row of that turn running forever.
 *
 * Called ONLY at session end (`codex-adapter-transport.ts`, all four
 * `session.exited` sites), never at a turn boundary, and always BEFORE the
 * exit event — `session.exited` closes a still-running card client-side
 * (`background-tasks-store.ts`), and a card closed as "Stopped" no longer
 * accepts the honest terminal. The map is cleared before publishing, so a
 * session that reaches two of those sites settles each call exactly once.
 *
 * Each entry lands on the turn that ISSUED it, read from the entry itself.
 */
export function settleUnresolvedCodexToolCalls({
  record,
  nowIso,
  publish,
}: {
  record: CodexSessionRecord;
  nowIso: string;
  publish: (event: CanonicalRuntimeEvent) => void;
}): void {
  if (record.openToolCalls.size === 0) return;
  const entries = [...record.openToolCalls];
  record.openToolCalls.clear();
  for (const [itemId, { toolName, turnId }] of entries) {
    publish({
      eventId: crypto.randomUUID(),
      provider: 'codex',
      threadId: record.externalThreadId,
      createdAt: nowIso,
      method: 'tool.completed',
      turnId,
      itemId,
      toolCallId: itemId,
      toolName,
      status: 'unresolved',
      output: UNRESOLVED_TOOL_OUTPUT,
    });
  }
}

interface CodexAdapterNotification {
  method: string;
  params?: unknown;
}

interface HandleCodexNotificationOptions {
  notification: CodexAdapterNotification;
  nowIso: () => string;
  publish: (event: CanonicalRuntimeEvent) => void;
  record?: CodexSessionRecord;
  onQuotaUpdate?: (record: CodexSessionRecord, payload: unknown) => void;
}

export function handleCodexNotification(
  options: HandleCodexNotificationOptions,
): void {
  const { notification, nowIso, publish, record, onQuotaUpdate } = options;
  if (!record) {
    return;
  }

  switch (notification.method) {
    case 'thread/status/changed': {
      if (!isRecord(notification.params)) return;
      const nextState = mapThreadStatusToState(notification.params.status);
      if (record.lastSessionState === nextState) return;
      const previousState = record.lastSessionState;
      record.lastSessionState = nextState;
      record.session = {
        ...record.session,
        status: mapSessionStatus(nextState),
        updatedAt: nowIso(),
      };
      publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: nowIso(),
        method: 'session.state-changed',
        sessionId: record.externalThreadId,
        from:
          previousState === 'running'
            ? 'running'
            : previousState === 'errored'
              ? 'errored'
              : 'idle',
        to:
          nextState === 'running'
            ? 'running'
            : nextState === 'errored'
              ? 'errored'
              : 'idle',
      });
      return;
    }
    case 'item/agentMessage/delta': {
      if (!isRecord(notification.params)) return;
      const turnId = extractString(notification.params.turnId);
      const itemId = extractString(notification.params.itemId);
      const delta = extractString(notification.params.delta);
      if (!turnId || !itemId || !delta) return;
      record.turnOutput.set(
        turnId,
        `${record.turnOutput.get(turnId) ?? ''}${delta}`,
      );
      publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: nowIso(),
        method: 'content.text-delta',
        turnId,
        itemId,
        delta,
      });
      return;
    }
    case 'item/reasoning/textDelta': {
      if (!isRecord(notification.params)) return;
      const turnId = extractString(notification.params.turnId);
      const itemId = extractString(notification.params.itemId);
      const delta = extractString(notification.params.delta);
      if (!turnId || !itemId || !delta) return;
      publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: nowIso(),
        method: 'content.reasoning-delta',
        turnId,
        itemId,
        delta,
      });
      return;
    }
    case 'thread/tokenUsage/updated': {
      if (
        !isRecord(notification.params) ||
        !isRecord(notification.params.tokenUsage)
      ) {
        return;
      }
      const usage = isRecord(notification.params.tokenUsage.total)
        ? notification.params.tokenUsage.total
        : notification.params.tokenUsage;
      publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: nowIso(),
        method: 'token-usage.updated',
        turnId: extractString(notification.params.turnId) ?? undefined,
        promptTokens: extractTokenFigure(usage.inputTokens) ?? undefined,
        completionTokens: extractTokenFigure(usage.outputTokens) ?? undefined,
        totalTokens: extractTokenFigure(usage.totalTokens) ?? undefined,
        cacheReadTokens:
          extractTokenFigure(usage.cachedInputTokens) ?? undefined,
      });
      return;
    }
    case 'account/rateLimits/updated': {
      onQuotaUpdate?.(record, notification.params);
      return;
    }
    case 'item/started': {
      handleCodexItemStarted(record, notification.params, nowIso, publish);
      return;
    }
    case 'item/completed': {
      handleCodexItemCompleted(record, notification.params, nowIso, publish);
      return;
    }
    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta':
    case 'item/mcpToolCall/progress': {
      if (!isRecord(notification.params)) return;
      const turnId = extractString(notification.params.turnId);
      const itemId = extractString(notification.params.itemId);
      const message =
        extractString(notification.params.delta) ??
        extractString(notification.params.message);
      if (!turnId || !itemId || !message) return;
      const preview = projectCodexToolOutput(message);
      publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: nowIso(),
        method: 'tool.progress',
        turnId,
        itemId,
        toolCallId: itemId,
        message: preview.value as string,
        ...(preview.receipt ? { outputReceipt: preview.receipt } : {}),
      });
      return;
    }
    case 'turn/completed': {
      if (
        !isRecord(notification.params) ||
        !isRecord(notification.params.turn)
      ) {
        return;
      }
      const turn = notification.params.turn;
      const turnId = extractString(turn.id);
      if (!turnId) return;
      const outputText = record.turnOutput.get(turnId);
      // archive#3451 fix round D8 / archive#3572(a) (widened): only touch
      // the CURRENTLY active turn's bookkeeping — `activeTurnId`,
      // `activeTurnStartedAt`, AND the duration metric that reads it — when
      // this notification actually names that turn. Mirrors the
      // target-mismatch guard `interruptTurn` already has. D8 originally
      // gated only the `activeTurnId` clear; a late `turn/completed` for
      // turn-1 arriving while turn-2 is already active still (a) recorded an
      // `adapterTurnDuration` sample using turn-2's OWN in-flight
      // `activeTurnStartedAt` — attributing a bogus duration to turn-1's
      // stale completion — and (b) unconditionally cleared
      // `activeTurnStartedAt` immediately below, so when turn-2 genuinely
      // completed later this same block found no `activeTurnStartedAt` to
      // read and silently recorded NO duration sample for turn-2 at all: one
      // bogus datapoint, one real one lost. All three now share the single
      // identity check. `terminalPublishedForTurnId` stays unconditional
      // below: it states a true fact (turn-1's terminal WAS published) that
      // is harmless to record even when turn-1 is no longer the active
      // turn — `publishOrphanedTurnFailure`'s guard compares it against
      // `activeTurnId`, so it only ever matches (and skips synthesis) when
      // the ids actually agree.
      if (turnId === record.activeTurnId) {
        if (record.activeTurnStartedAt) {
          adapterTurnDuration.record(Date.now() - record.activeTurnStartedAt, {
            provider: 'codex',
          });
        }
        record.activeTurnId = undefined;
        record.activeTurnStartedAt = undefined;
      }
      // archive#3473 fix round: this notification ALWAYS publishes a real
      // terminal below (turn.completed, or runtime.error for the failed
      // branch) — mark it before either publish path so a concurrent
      // `stopSession`/process-exit synthesis (`publishOrphanedTurnFailure`)
      // never double-publishes for this turn.
      record.terminalPublishedForTurnId = turnId;
      record.session = {
        ...record.session,
        status: 'ready',
        updatedAt: nowIso(),
        resumeCursor: { codexThreadId: record.codexThreadId, turnId },
      };
      // archive#3442: Codex reports a genuinely failed turn (e.g. a
      // usage-limit or context-window exhaustion mid-turn) through the SAME
      // `turn/completed` notification as a success — `turn.status` is the
      // real signal (app-server protocol: completed | interrupted | failed |
      // inProgress), with `turn.error` populated only when it is `failed`.
      // Publishing this as `turn.completed` (as this branch used to,
      // unconditionally, via `mapTurnFinishReason` collapsing `failed` into
      // `'other'`) discarded the one structured sighting of the failure and
      // folded the session lifecycle to 'completed' — the projector only
      // ever derives 'failed' from a `runtime.error` event. Publish that
      // instead, mirroring the `case 'error'` notification below.
      if (turn.status === 'failed') {
        const turnError = isRecord(turn.error) ? turn.error : undefined;
        const codexErrorInfo = extractString(turnError?.codexErrorInfo);
        publish({
          eventId: crypto.randomUUID(),
          provider: 'codex',
          threadId: record.externalThreadId,
          createdAt: nowIso(),
          method: 'runtime.error',
          severity: 'error',
          turnId,
          message: extractString(turnError?.message) ?? 'Codex turn failed.',
          // archive#3451 finding 3: `turn.status === 'failed'` is codex's own
          // final word on this turn — the opposite of the `'error'`
          // notification's `willRetry` signal below, so `retriable: false`
          // is a real fact, not a guess. `code` is a plain passthrough of
          // `codexErrorInfo` when codex hands us one (already captured into
          // `details` below); nothing here invents a classification the data
          // does not support.
          retriable: false,
          ...(codexErrorInfo ? { code: codexErrorInfo } : {}),
          details: {
            additionalDetails: extractString(turnError?.additionalDetails),
            codexErrorInfo: turnError?.codexErrorInfo,
          },
        });
        providerOps.add(1, {
          operation: 'adapter-turn-complete',
          provider: 'codex',
        });
        return;
      }
      publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: nowIso(),
        method: 'turn.completed',
        turnId,
        finishReason: mapTurnFinishReason(turn.status),
        outputText,
      });
      providerOps.add(1, {
        operation: 'adapter-turn-complete',
        provider: 'codex',
      });
      return;
    }
    case 'error': {
      if (
        !isRecord(notification.params) ||
        !isRecord(notification.params.error)
      ) {
        return;
      }
      const errorTurnId = extractString(notification.params.turnId);
      const willRetry = Boolean(notification.params.willRetry);
      // archive#3451 finding B2: when `willRetry` is falsy this event IS a
      // genuine terminal for the turn it names — every consumer downstream
      // (the lifecycle fold, the stall watchdog, the trackEngineTurn
      // telemetry gate, turn-checkpoint-capture's settle capture) already
      // treats a non-deferred `runtime.error` as closing it. Before this fix
      // nothing here recorded that fact, so the record still held the turn
      // as unresolved: a later stop or exit would then synthesize a SECOND
      // terminal via `publishOrphanedTurnFailure`, double-counting
      // `trackEngineTurn`, double-firing checkpoint capture's settle, and —
      // worse — letting that synthesized event's generic message overwrite
      // `blockedReason` and erase the real cause this notification just
      // reported.
      if (errorTurnId && !willRetry) {
        record.terminalPublishedForTurnId = errorTurnId;
      }
      publish({
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId: record.externalThreadId,
        createdAt: nowIso(),
        method: 'runtime.error',
        severity: 'error',
        turnId: errorTurnId ?? undefined,
        message:
          extractString(notification.params.error.message) ??
          'Codex runtime error',
        retriable: willRetry,
        details: {
          additionalDetails: extractString(
            notification.params.error.additionalDetails,
          ),
        },
      });
      return;
    }
    default:
      return;
  }
}

function handleCodexItemStarted(
  record: CodexSessionRecord,
  params: unknown,
  nowIso: () => string,
  publish: (event: CanonicalRuntimeEvent) => void,
): void {
  if (!isRecord(params) || !isRecord(params.item)) return;
  const turnId = extractString(params.turnId);
  const itemId = extractString(params.item.id);
  const type = extractString(params.item.type);
  if (!turnId || !itemId || !type) return;

  const toolName = deriveToolName(params.item);
  if (!toolName) return;
  record.toolNames.set(itemId, toolName);
  record.openToolCalls.set(itemId, { toolName, turnId });
  publish({
    eventId: crypto.randomUUID(),
    provider: 'codex',
    threadId: record.externalThreadId,
    createdAt: nowIso(),
    method: 'tool.started',
    turnId,
    itemId,
    toolCallId: itemId,
    toolName,
    arguments: deriveToolArguments(params.item),
  });
}

function handleCodexItemCompleted(
  record: CodexSessionRecord,
  params: unknown,
  nowIso: () => string,
  publish: (event: CanonicalRuntimeEvent) => void,
): void {
  if (!isRecord(params) || !isRecord(params.item)) return;
  const turnId = extractString(params.turnId);
  const itemId = extractString(params.item.id);
  if (!turnId || !itemId) return;
  const toolName = record.toolNames.get(itemId);
  if (!toolName || !record.openToolCalls.has(itemId)) return;
  const preview = projectCodexToolOutput(deriveToolOutput(params.item));
  record.openToolCalls.delete(itemId);
  publish({
    eventId: crypto.randomUUID(),
    provider: 'codex',
    threadId: record.externalThreadId,
    createdAt: nowIso(),
    method: 'tool.completed',
    turnId,
    itemId,
    toolCallId: itemId,
    toolName,
    status: mapToolCompletionStatus(extractToolStatus(params.item)),
    output: preview.value,
    ...(preview.receipt ? { outputReceipt: preview.receipt } : {}),
    error: extractToolError(params.item),
  });
}
