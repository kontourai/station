import { StationHttpError } from './api-error-message';

/**
 * An HTTP refusal returned by a chat-related endpoint.
 *
 * This client-local seam is shared by command/execution callers and re-exported
 * by the streaming domain so every public path exposes one class identity.
 *
 * #2708: a `StationHttpError`, so a chat refusal keeps the same fields every
 * other refused request carries — status, `code`, `details`, `Retry-After`.
 * The execution fetchers build it from the `StationHttpError` the envelope
 * helper made of the response (`new ChatHttpError(failure)`); the positional
 * form stays for the streaming domain and Station's own server code.
 */
export class ChatHttpError extends StationHttpError {
  readonly serverMessage?: string;

  /**
   * Whether the body parsed as Station's own answer (`isStationEnvelope`).
   * A proxy or gateway page (an HTML 403 or 502) keeps its status but is
   * `false`: it says nothing about what Station decided, so a caller must not
   * treat it as a definitive refusal of the request (#2708).
   */
  readonly stationEnvelope: boolean;

  constructor(failure: StationHttpError, stationEnvelope: boolean);
  /** Built from a parsed Station answer unless `stationEnvelope` says not. */
  constructor(
    status: number,
    serverMessage?: string,
    code?: string,
    stationEnvelope?: boolean,
  );
  constructor(
    first: number | StationHttpError,
    second?: string | boolean,
    code?: string,
    stationEnvelope = true,
  ) {
    if (typeof first === 'number') {
      const serverMessage = second as string | undefined;
      super(
        first,
        serverMessage ?? `HTTP ${first}`,
        code === undefined ? undefined : { code },
      );
      this.serverMessage = serverMessage;
      this.stationEnvelope = stationEnvelope;
    } else {
      super(first.status, first.message, first);
      this.serverMessage = first.message;
      this.stationEnvelope = second as boolean;
    }
    this.name = 'ChatHttpError';
  }
}

/**
 * Whether a parsed body is Station's own answer: a route envelope (a boolean
 * `success`) or the runtime's auth refusal (`{ error: { code } }`). Anything
 * else — no JSON, or some other JSON — came from something in between.
 */
export function isStationEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const value = body as { success?: unknown; error?: unknown };
  if (typeof value.success === 'boolean') return true;
  return (
    typeof value.error === 'object' &&
    value.error !== null &&
    typeof (value.error as { code?: unknown }).code === 'string'
  );
}
