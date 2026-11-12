/**
 * The Station recovery note an engine's first turn receives when the engine
 * before it ended with work still running: a backgrounded subagent, a
 * background command, or a call the turn never got a result for.
 *
 * Derived only from durable events. An adapter settles every call its engine
 * can no longer report on as `tool.completed` with status `unresolved`, and
 * only when that engine ends, so an `unresolved` terminal recorded after the
 * thread's latest `turn.started` names work the current engine never saw
 * finish. A later real terminal for the same call (a result the SDK drained
 * after the stop) corrects it, and the call is left out.
 */
import { interruptedWorkContinuationNote } from '../infra/workload-budget.js';

interface RecoveryEvent {
  readonly payload: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** What one interrupted call was doing, as a reader would name it. */
function workLabel(
  started: Record<string, unknown> | undefined,
  completed: Record<string, unknown> | undefined,
): string | undefined {
  const args = record(started?.arguments);
  const command = args?.command;
  return (
    // A subagent or background task: the description it was started with.
    text(args?.description) ??
    text(command) ??
    (Array.isArray(command) && command.every((part) => typeof part === 'string')
      ? text(command.join(' '))
      : undefined) ??
    text(started?.toolName) ??
    text(completed?.toolName)
  );
}

/**
 * Each call's LATEST `tool.completed` in `completions` (sequence order),
 * keyed by call id, oldest call first.
 */
function latestTerminals(
  completions: readonly RecoveryEvent[],
): Map<string, Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const event of completions) {
    const payload = record(event.payload);
    const callId = text(payload?.toolCallId);
    if (payload?.method !== 'tool.completed' || !callId) continue;
    latest.delete(callId);
    latest.set(callId, payload);
  }
  return latest;
}

/**
 * The note, when `completions` (the thread's `tool.completed` events since
 * its latest `turn.started`, in sequence order) leave any call unresolved;
 * otherwise undefined. `starts` are the stored `tool.started` payloads of
 * those calls, oldest first; a call started again (a woken subagent) is named
 * by its newest start.
 */
export function interruptedWorkRecoveryNote(
  completions: readonly RecoveryEvent[],
  starts: readonly unknown[],
): string | undefined {
  const startedByCall = new Map<string, Record<string, unknown>>();
  for (const start of starts) {
    const payload = record(start);
    const callId = text(payload?.toolCallId);
    if (payload && callId) startedByCall.set(callId, payload);
  }
  const labels = [...latestTerminals(completions)]
    .filter(([, terminal]) => terminal.status === 'unresolved')
    .map(([callId, terminal]) => workLabel(startedByCall.get(callId), terminal))
    .filter((label): label is string => label !== undefined);
  return interruptedWorkContinuationNote(labels);
}
