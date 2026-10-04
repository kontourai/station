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
   * Whether Station itself answered (`isStationAnswer`): the body has
   * Station's shape and, for a Station that marks its answers (#2842), the
   * response carried the marker. A proxy or gateway answer (an HTML 403 or
   * 502, or JSON in Station's shape without the marker) keeps its status but
   * is `false`: it says nothing about what Station decided, so a caller must
   * not treat it as a definitive refusal of the request (#2708).
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

// Kept here for its existing importers; the rule lives with the marker.
export { isStationEnvelope } from './station-envelope';
