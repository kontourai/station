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
  /**
   * The envelope's `details`, exactly as sent (e.g. #1796's full-access
   * refusal, which a client renders from its structure, not its prose).
   */
  readonly details?: unknown;

  constructor(
    status: number,
    serverMessage?: string,
    code?: string,
    details?: unknown,
  ) {
    super(serverMessage ?? `HTTP ${status}`);
    this.name = 'ChatHttpError';
    this.status = status;
    this.serverMessage = serverMessage;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
