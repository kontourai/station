/**
 * What a failed station-control tool result says, read ONE way by every
 * consumer that needs it outside the model: the raw invoke route (HTTP error
 * and `controlActions` telemetry) and the platform-mutation audit (#2795).
 *
 * A station-control failure is an MCP result marked `isError` whose first
 * text is usually a JSON envelope. The agent reads that whole envelope; these
 * readers want two narrower things:
 *
 * - `sentence`, for people: a string `error`, else an object `error`'s
 *   `message`, else a string `message`; a text that is not a JSON object is
 *   the sentence itself. Never the raw JSON (which can carry a correlation id).
 * - `code`, for metrics: the envelope's `code` (top-level, else the object
 *   `error`'s), only when it is a bounded machine token. A metric attribute
 *   must never take free text or an identifier, so anything else is absent
 *   and the caller records a fixed reason instead.
 */

/** A machine token: bounded, no spaces, no identifiers' punctuation. */
const CODE_TOKEN = /^[a-z][a-z0-9_.-]{0,63}$/;

/** The fixed telemetry reason for a failure with no usable code. */
export const CONTROL_TOOL_FAILED_REASON = 'tool_failed';

export interface ControlToolFailure {
  sentence: string;
  code?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The failure an `isError` tool result reports, or `undefined` if it did not fail. */
export function readControlToolFailure(
  result: unknown,
): ControlToolFailure | undefined {
  const tool = record(result);
  if (tool?.isError !== true) return undefined;
  const content = Array.isArray(tool.content) ? tool.content : [];
  const text = content
    .map((entry) => nonBlank(record(entry)?.text))
    .find((entry) => entry !== undefined);
  if (!text) return { sentence: 'Tool call failed' };
  let envelope: Record<string, unknown> | undefined;
  try {
    envelope = record(JSON.parse(text));
  } catch {
    envelope = undefined;
  }
  if (!envelope) return { sentence: text };
  const error = envelope.error;
  const sentence =
    nonBlank(error) ??
    nonBlank(record(error)?.message) ??
    nonBlank(envelope.message) ??
    'Tool call failed';
  const rawCode = nonBlank(envelope.code) ?? nonBlank(record(error)?.code);
  const code = rawCode && CODE_TOKEN.test(rawCode) ? rawCode : undefined;
  return code ? { sentence, code } : { sentence };
}

/** The error the invoke route throws for a failed control tool. */
export class ControlToolFailureError extends Error {
  constructor(readonly failure: ControlToolFailure) {
    super(failure.sentence);
    this.name = 'ControlToolFailureError';
  }
}
