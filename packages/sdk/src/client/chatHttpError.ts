/**
 * An HTTP refusal returned by a chat-related endpoint.
 *
 * This client-local seam is shared by command/execution callers and re-exported
 * by the streaming domain so every public path exposes one class identity.
 */
export class ChatHttpError extends Error {
  readonly status: number;
  readonly serverMessage?: string;
  readonly code?: string;

  constructor(status: number, serverMessage?: string, code?: string) {
    super(serverMessage ?? `HTTP ${status}`);
    this.name = 'ChatHttpError';
    this.status = status;
    this.serverMessage = serverMessage;
    this.code = code;
  }
}
