/**
 * Handler for step lifecycle events (start-step, finish-step)
 */

import { StreamEventHandler } from './BaseHandler';
import type { HandlerResult, StreamEvent, StreamState } from './types';

export class StepHandler extends StreamEventHandler {
  canHandle(event: StreamEvent): boolean {
    return event.type === 'start-step' || event.type === 'finish-step';
  }

  handle(event: StreamEvent, state: StreamState): HandlerResult {
    const isProcessingStep = event.type === 'start-step';
    this.updateChat({ isProcessingStep });
    return this.noOp(state);
  }
}
