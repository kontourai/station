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

  constructor(failure: StationHttpError);
  constructor(status: number, serverMessage?: string, code?: string);
  constructor(
    first: number | StationHttpError,
    serverMessage?: string,
    code?: string,
  ) {
    if (typeof first === 'number') {
      super(
        first,
        serverMessage ?? `HTTP ${first}`,
        code === undefined ? undefined : { code },
      );
      this.serverMessage = serverMessage;
    } else {
      super(first.status, first.message, first);
      this.serverMessage = first.message;
    }
    this.name = 'ChatHttpError';
  }
}
