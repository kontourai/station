/**
 * A station-control refusal as a reader shows it: the code an agent acts on
 * and the sentence written for a person. The server writes it as the tool's
 * whole JSON result (`{ success: false, code, error, reason? }`); this module
 * recognises exactly that envelope, from a station-control tool only, so the
 * transcript can show the sentence instead of the JSON.
 *
 * A history window cuts tool output to a short excerpt, which no longer
 * parses. Station therefore keeps the refusal as its own bounded field on
 * the event it serves (`ToolCompletedEvent.stationControlRefusal`), read
 * from the full text before the cut.
 */

/** Longest refusal sentence kept whole; a longer one is not recognised. */
export const STATION_CONTROL_REFUSAL_MESSAGE_MAX_CHARS = 2000;
/** Longest refusal code or reason kept. */
export const STATION_CONTROL_REFUSAL_CODE_MAX_CHARS = 100;

export interface StationControlRefusalView {
  readonly code: string;
  /** The sentence written for a person (the envelope's `error`). */
  readonly message: string;
  /** `station_control_out_of_scope`'s reason, when the rule knew it. */
  readonly reason?: string;
}

/**
 * The bare tool name of a station-control tool call, as each engine names
 * it (`mcp__station-control__x`, `station-control_x`, `station-control/x`,
 * `Tool: station-control/x`); `undefined` for any other tool.
 */
export function stationControlToolName(
  toolName: string | undefined,
): string | undefined {
  if (typeof toolName !== 'string') return undefined;
  const match =
    /^(?:mcp__station-control__|station-control[_/]|Tool: station-control\/)([A-Za-z0-9_-]+)$/.exec(
      toolName,
    );
  return match?.[1];
}

/**
 * The refusal a station-control tool's whole result (or error) text is, or
 * `undefined`. The whole value must be the envelope: text that merely
 * contains one is not a refusal. A field over its bound is refused, never
 * cut.
 */
export function parseStationControlRefusal(
  toolName: string | undefined,
  value: unknown,
): StationControlRefusalView | undefined {
  if (stationControlToolName(toolName) === undefined) return undefined;
  const body = parseJsonObject(value);
  // An engine may hand back the MCP result itself: one text item that is
  // the envelope.
  const content = (body as { content?: unknown } | undefined)?.content;
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    (content[0] as { type?: unknown })?.type === 'text'
  )
    return stationControlRefusalView(
      parseJsonObject((content[0] as { text?: unknown }).text),
    );
  return stationControlRefusalView(body);
}

function parseJsonObject(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Validates a refusal view (or envelope) against its bounds. */
export function stationControlRefusalView(
  body: unknown,
): StationControlRefusalView | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return undefined;
  const record = body as Record<string, unknown>;
  // An envelope says `success: false` and carries its sentence as `error`;
  // a view already extracted carries it as `message`.
  const message =
    record.success === false
      ? record.error
      : record.success === undefined
        ? record.message
        : undefined;
  if (
    typeof record.code !== 'string' ||
    !record.code ||
    record.code.length > STATION_CONTROL_REFUSAL_CODE_MAX_CHARS ||
    typeof message !== 'string'
  )
    return undefined;
  const sentence = message.trim();
  if (!sentence || sentence.length > STATION_CONTROL_REFUSAL_MESSAGE_MAX_CHARS)
    return undefined;
  const reason =
    typeof record.reason === 'string' &&
    record.reason.length > 0 &&
    record.reason.length <= STATION_CONTROL_REFUSAL_CODE_MAX_CHARS
      ? record.reason
      : undefined;
  return {
    code: record.code,
    message: sentence,
    ...(reason ? { reason } : {}),
  };
}
