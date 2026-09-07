/**
 * The sole Station -> @kontourai/thread adapter for terminal tool events.
 * It preserves event-owned identity/status and intentionally never receives
 * tool arguments. Consumers must use the published inert projection.
 */

import type { ToolCompletedEvent } from '@kontourai/station-contracts/runtime-events';
import {
  createToolResult,
  MAX_OPAQUE_ID_BYTES,
  MAX_PROJECTED_TOOL_RESULT_LABEL_BYTES,
  MAX_PROJECTED_TOOL_RESULT_TEXT_BYTES,
  projectToolResult,
  type ToolResultProjectionOutcome,
} from '@kontourai/thread';

export interface ToolCompletedEventDescriptor {
  eventId: string;
  threadId: string;
  turnId?: string;
  method: string;
  toolCallId?: string;
  toolName?: string;
  status?: string;
  output?: unknown;
  error?: string;
  policyDenied?: boolean;
}

/** Bound source fields before invoking Thread's validating factory. */
export const MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES =
  MAX_PROJECTED_TOOL_RESULT_TEXT_BYTES;
export const MAX_TOOL_RESULT_DESCRIPTOR_LABEL_BYTES =
  MAX_PROJECTED_TOOL_RESULT_LABEL_BYTES;
export const MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES = MAX_OPAQUE_ID_BYTES;

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedText(value: string, maxBytes: number): boolean {
  return hasWellFormedUnicode(value) && Buffer.byteLength(value) <= maxBytes;
}

function inertText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  // Never stringify a source object: JSON would carry URLs, embedded bytes,
  // resources, or structured data across this projection boundary. Empty
  // content is the honest intentional exclusion; Thread's omission counters
  // describe capacity loss, not source data Station deliberately retained.
  return undefined;
}

/**
 * Exact mapping only. In particular, policy denial comes exclusively from
 * the explicit durable marker, and a status is never folded into another
 * value that would MISSTATE it.
 *
 * The one translation is station#1558's `unresolved`, which Thread's own
 * published vocabulary spells `unknown` — the same fact under the other
 * schema's name, not a different claim. Every other status crosses verbatim.
 */
export function projectToolCompletedEvent(
  event: Pick<
    ToolCompletedEvent,
    | 'eventId'
    | 'threadId'
    | 'turnId'
    | 'toolCallId'
    | 'toolName'
    | 'status'
    | 'output'
    | 'error'
    | 'policyDenied'
  >,
): ToolResultProjectionOutcome {
  const output = inertText(event.output);
  const text = output ?? event.error;
  const authorityDecision =
    event.policyDenied === true && event.status !== 'success'
      ? { decision: 'denied' as const, authority: 'kontourai.station' }
      : undefined;
  return projectToolResult(
    createToolResult({
      resultId: event.eventId,
      // station#1558: Thread's own vocabulary already has the slot for a
      // call whose outcome was never observed. `unresolved` is exactly that,
      // so it projects as `unknown` rather than being folded into `cancelled`
      // (nobody asked it to stop) or `error` (nothing observed it fail).
      terminalStatus: event.status === 'unresolved' ? 'unknown' : event.status,
      toolCallId: event.toolCallId,
      name: event.toolName,
      content: text === undefined ? [] : [{ type: 'text', text }],
      ...(authorityDecision ? { authorityDecision } : {}),
      correlations: [
        { namespace: 'kontourai.station', kind: 'session', id: event.threadId },
        ...(event.turnId
          ? [
              {
                namespace: 'kontourai.station',
                kind: 'turn' as const,
                id: event.turnId,
              },
            ]
          : []),
        { namespace: 'kontourai.station', kind: 'event', id: event.eventId },
      ],
    }),
  );
}

/** Validates descriptor facts before handing them to the published adapter. */
export function projectToolCompletedDescriptor(
  event: ToolCompletedEventDescriptor,
): ToolResultProjectionOutcome | null {
  if (
    event.method !== 'tool.completed' ||
    !boundedText(event.eventId, MAX_OPAQUE_ID_BYTES) ||
    !boundedText(event.threadId, MAX_OPAQUE_ID_BYTES) ||
    (event.turnId !== undefined &&
      !boundedText(event.turnId, MAX_OPAQUE_ID_BYTES)) ||
    typeof event.toolCallId !== 'string' ||
    !boundedText(event.toolCallId, MAX_OPAQUE_ID_BYTES) ||
    typeof event.toolName !== 'string' ||
    !boundedText(event.toolName, MAX_PROJECTED_TOOL_RESULT_LABEL_BYTES) ||
    (event.status !== 'success' &&
      event.status !== 'error' &&
      event.status !== 'cancelled' &&
      event.status !== 'unresolved') ||
    (event.error !== undefined &&
      (typeof event.error !== 'string' ||
        !boundedText(event.error, MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES))) ||
    (typeof event.output === 'string' &&
      !boundedText(event.output, MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES))
  ) {
    return null;
  }
  return projectToolCompletedEvent({
    eventId: event.eventId,
    threadId: event.threadId,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    status: event.status,
    ...(event.output === undefined ? {} : { output: event.output }),
    ...(event.error === undefined ? {} : { error: event.error }),
    ...(event.policyDenied === true ? { policyDenied: true } : {}),
  });
}
