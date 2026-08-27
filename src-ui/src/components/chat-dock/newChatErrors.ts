/**
 * A user-facing "New chat" action that cannot proceed must say why — a
 * silent return is indistinguishable from a dead button (station#2582
 * follow-through, live phone report). Callers use the type to distinguish
 * "the new chat never started" from failures after the draft exists.
 */
export class NewChatUnavailableError extends Error {
  constructor(reason: string) {
    super(`Could not start a new chat: ${reason}`);
    this.name = 'NewChatUnavailableError';
  }
}
