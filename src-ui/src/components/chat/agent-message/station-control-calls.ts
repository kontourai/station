/**
 * #3419: how the transcript recognises the Station Control calls it gives a
 * bespoke row, and the words that row uses.
 *
 * This is a small, local mapping on purpose. #3418 generalises how Station
 * Control tools are labelled and will replace {@link STATION_CONTROL_TOOL_LABELS}
 * and {@link stationControlToolId} with its registry; the seam it replaces is
 * {@link describeStationControlCall}, the one function the transcript calls.
 * Only `send_to_session` has a row so far, and nothing here names a tool this
 * lane does not render.
 */
import { toolDisplayView } from '../tool-display-view';

/** The Station Control tools that have a bespoke transcript row. */
export const STATION_CONTROL_TOOL_LABELS = {
  send_to_session: { done: 'Sent to', pending: 'Sending to' },
} as const;

type StationControlToolId = keyof typeof STATION_CONTROL_TOOL_LABELS;

/** What a send did, in the words the row shows. */
export type SendToSessionOutcome =
  | 'started'
  | 'steered'
  | 'refused'
  /** The delivery may or may not have happened; Station says to re-check. */
  | 'unconfirmed'
  /** No result yet. */
  | 'sending';

export interface SendToSessionCall {
  tool: 'send_to_session';
  /** The Session the message was addressed to (the result's, once it has one). */
  targetSessionId: string | undefined;
  mode: string | undefined;
  /** What the agent sent, as its call carried it. */
  text: string | undefined;
  requestKey: string | undefined;
  outcome: SendToSessionOutcome;
  /** Why a refused send was refused, in a few words. */
  reason: string | undefined;
}

export type StationControlCall = SendToSessionCall;

/** The fields of a tool part this module reads; every transcript tool part has them. */
interface CallPart {
  toolName?: string;
  name?: string;
  server?: string;
  type?: string;
  state?: string;
}

const SERVER = 'station-control';

/**
 * The Station Control tool a part is, or undefined. A name qualified by
 * another MCP server is not ours; an unqualified name only counts when its
 * arguments have the call's shape, so a different tool that happens to share
 * the name is not dressed up as a Session message.
 */
function stationControlToolId(
  part: CallPart,
): StationControlToolId | undefined {
  const display = toolDisplayView(part);
  const name = String(display.toolName ?? '');
  for (const id of Object.keys(
    STATION_CONTROL_TOOL_LABELS,
  ) as StationControlToolId[]) {
    if (!name.endsWith(id)) continue;
    const qualifier = name.slice(0, name.length - id.length);
    if (qualifier.length > 0 && !qualifier.includes(SERVER)) continue;
    if (part.server !== undefined && part.server !== SERVER) continue;
    if (qualifier.length === 0 && part.server === undefined) {
      const args = callArguments(display.args);
      if (
        typeof args?.sessionId !== 'string' ||
        typeof args?.requestKey !== 'string'
      )
        continue;
    }
    return id;
  }
  return undefined;
}

function callArguments(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === 'string') {
    try {
      return callArguments(JSON.parse(args));
    } catch {
      return undefined;
    }
  }
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;
}

/**
 * The route's JSON out of however an engine carried the tool result: the
 * text itself, MCP `content` blocks, or a `{text}` wrapper.
 */
function resultEnvelope(result: unknown): Record<string, unknown> | undefined {
  if (typeof result === 'string') {
    try {
      return resultEnvelope(JSON.parse(result));
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(result)) {
    for (const block of result) {
      const found = resultEnvelope(block);
      if (found) return found;
    }
    return undefined;
  }
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.success === 'boolean') return record;
  return resultEnvelope(record.content ?? record.text ?? record.output);
}

const REFUSAL_REASONS: Record<string, string> = {
  session_busy: 'Session is busy',
  no_active_turn: 'Nothing running to steer',
  session_not_found: 'Session not found',
  request_key_conflict: 'Request key reused',
  request_in_progress: 'Still running',
};

function refusalReason(envelope: Record<string, unknown>): string {
  const code = envelope.code;
  if (typeof code === 'string' && REFUSAL_REASONS[code])
    return REFUSAL_REASONS[code];
  if (typeof code === 'string' && code.length > 0)
    return code.replace(/_/gu, ' ');
  return 'Not delivered';
}

function sendToSession(part: CallPart): SendToSessionCall {
  const display = toolDisplayView(part);
  const args = callArguments(display.args);
  const envelope = resultEnvelope(display.result);
  const data =
    envelope?.data && typeof envelope.data === 'object'
      ? (envelope.data as Record<string, unknown>)
      : undefined;
  const text = typeof args?.text === 'string' ? args.text : undefined;
  const base = {
    tool: 'send_to_session' as const,
    mode: typeof args?.mode === 'string' ? args.mode : undefined,
    text,
    requestKey:
      typeof args?.requestKey === 'string' ? args.requestKey : undefined,
  };
  const addressed =
    typeof args?.sessionId === 'string' ? args.sessionId : undefined;
  const target =
    typeof data?.sessionId === 'string'
      ? data.sessionId
      : typeof envelope?.sessionId === 'string'
        ? envelope.sessionId
        : addressed;
  if (
    envelope?.success === true &&
    (data?.outcome === 'started' || data?.outcome === 'steered')
  )
    return {
      ...base,
      targetSessionId: target,
      outcome: data.outcome,
      reason: undefined,
    };
  if (envelope) {
    const unconfirmed =
      envelope.code === 'delivery_indeterminate' ||
      envelope.code === 'request_in_progress';
    return {
      ...base,
      targetSessionId: target,
      outcome: unconfirmed ? 'unconfirmed' : 'refused',
      reason: unconfirmed ? undefined : refusalReason(envelope),
    };
  }
  // No envelope: the call has not answered, or it failed before Station did.
  const failed =
    Boolean(display.error) ||
    part.state === 'error' ||
    part.state === 'cancelled' ||
    part.state === 'unresolved';
  return {
    ...base,
    targetSessionId: addressed,
    outcome: failed
      ? 'refused'
      : display.result !== undefined
        ? 'unconfirmed'
        : 'sending',
    reason: failed ? 'The call did not complete' : undefined,
  };
}

/** Whether the part is a call with a bespoke row (it never folds into a batch). */
export function hasStationControlCallRow(part: CallPart): boolean {
  return stationControlToolId(part) !== undefined;
}

/** The call a tool part is, when it has a bespoke row; undefined for any other tool. */
export function describeStationControlCall(
  part: CallPart,
): StationControlCall | undefined {
  switch (stationControlToolId(part)) {
    case 'send_to_session':
      return sendToSession(part);
    default:
      return undefined;
  }
}
