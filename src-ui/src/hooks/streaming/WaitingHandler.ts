/**
 * Handler for waiting/waiting-cleared events (ACP stale output detection)
 */

import { StreamEventHandler } from './BaseHandler';
import type { HandlerResult, StreamEvent, StreamState } from './types';

export class WaitingHandler extends StreamEventHandler {
  canHandle(event: StreamEvent): boolean {
    return event.type === 'waiting' || event.type === 'waiting-cleared';
  }

  handle(event: StreamEvent, state: StreamState): HandlerResult {
    this.updateChat({
      waitingState:
        event.type === 'waiting'
          ? { elapsedMs: event.elapsedMs, since: Date.now() - event.elapsedMs }
          : null,
    });
    return this.noOp(state);
  }
}
