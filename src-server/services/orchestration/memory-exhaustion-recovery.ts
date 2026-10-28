/**
 * The Station recovery note a successor Session's first turn receives when
 * its predecessor's engine was killed for exhausting its workload memory
 * budget. Derived only from the predecessor's own durable events: the
 * failure (`ENGINE_MEMORY_EXHAUSTED_CODE` with its observed workload
 * outcome) and the tool calls of that turn that never reported a result.
 */
import { ENGINE_MEMORY_EXHAUSTED_CODE } from '@kontourai/station-contracts/provider';
import { memoryExhaustionContinuationNote } from '../infra/workload-budget.js';

interface RecoveryEvent {
  readonly payload: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const byteCount = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/** What one interrupted call was running, as a reader would name it. */
function callLabel(started: Record<string, unknown>): string | undefined {
  const args = record(started.arguments);
  const command = args?.command;
  if (typeof command === 'string' && command.trim()) return command;
  if (
    Array.isArray(command) &&
    command.every((part) => typeof part === 'string')
  )
    return command.join(' ');
  return typeof started.toolName === 'string' ? started.toolName : undefined;
}

/**
 * The note, when the newest turn in `events` ended in a memory-exhaustion
 * failure; otherwise undefined. `events` is the predecessor's newest turn
 * window, in sequence order.
 */
export function memoryExhaustionRecoveryNote(
  events: readonly RecoveryEvent[],
): string | undefined {
  const payloads = events
    .map((event) => record(event.payload))
    .filter((payload): payload is Record<string, unknown> => !!payload);
  const failure = payloads
    .filter((payload) => payload.method === 'runtime.error')
    .at(-1);
  if (failure?.code !== ENGINE_MEMORY_EXHAUSTED_CODE) return undefined;
  const turnId = failure.turnId;
  const workload = record(record(failure.details)?.workload);
  const unresolved = new Set(
    payloads
      .filter(
        (payload) =>
          payload.method === 'tool.completed' &&
          payload.status === 'unresolved' &&
          payload.turnId === turnId,
      )
      .map((payload) => payload.toolCallId),
  );
  const interruptedCommands = payloads
    .filter(
      (payload) =>
        payload.method === 'tool.started' &&
        payload.turnId === turnId &&
        unresolved.has(payload.toolCallId),
    )
    .map(callLabel)
    .filter((label): label is string => label !== undefined);
  const memoryPeakBytes = byteCount(workload?.memoryPeakBytes);
  const memoryMaxBytes = byteCount(workload?.memoryMaxBytes);
  return memoryExhaustionContinuationNote({
    interruptedCommands,
    ...(memoryPeakBytes === undefined ? {} : { memoryPeakBytes }),
    ...(memoryMaxBytes === undefined ? {} : { memoryMaxBytes }),
  });
}
