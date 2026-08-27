/**
 * Handler for reasoning events (reasoning-start, reasoning-delta, reasoning-end, reasoning)
 */

import { StreamEventHandler } from './BaseHandler';
import {
  createResult,
  hasContentPartOfType,
  prependContentPart,
  updateContentPart,
} from './stateHelpers';
import type { HandlerResult, StreamEvent, StreamState } from './types';

export class ReasoningHandler extends StreamEventHandler {
  canHandle(event: StreamEvent): boolean {
    return [
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'reasoning',
    ].includes(event.type);
  }

  handle(event: StreamEvent, state: StreamState): HandlerResult {
    switch (event.type) {
      case 'reasoning-start':
        return this.handleStart(state);
      case 'reasoning-delta':
        return this.handleDelta(event, state);
      case 'reasoning-end':
        return this.handleEnd(state);
      case 'reasoning':
        return this.handleLegacy(event, state);
      default:
        return this.noOp(state);
    }
  }

  private handleStart(state: StreamState): HandlerResult {
    const newContentParts = prependContentPart(state.contentParts, {
      type: 'reasoning',
      content: '',
    });

    const streamingMessage = this.createStreamingMessage(
      state.currentTextChunk,
      newContentParts,
    );
    this.updateChat({ streamingMessage });

    return createResult(state, {
      contentParts: newContentParts,
      currentReasoningChunk: '',
      streamingMessage,
    });
  }

  private handleDelta(event: StreamEvent, state: StreamState): HandlerResult {
    if (!event.textDelta) return this.noOp(state);

    const newReasoningChunk =
      (state.currentReasoningChunk || '') + event.textDelta;
    const newContentParts = updateContentPart(
      state.contentParts,
      'reasoning',
      (part) => ({ ...part, content: newReasoningChunk }),
    );

    const streamingMessage = this.createStreamingMessage(
      state.currentTextChunk,
      newContentParts,
    );
    this.updateChat({ streamingMessage });

    return createResult(state, {
      contentParts: newContentParts,
      currentReasoningChunk: newReasoningChunk,
      streamingMessage,
    });
  }

  private handleEnd(state: StreamState): HandlerResult {
    return createResult(state, {
      updated: false,
      currentReasoningChunk: undefined,
    });
  }

  private handleLegacy(event: StreamEvent, state: StreamState): HandlerResult {
    const reasoningChunks = [...(state.reasoningChunks || []), event.data];
    const reasoningContent = reasoningChunks.join('');

    const hasReasoning = hasContentPartOfType(state.contentParts, 'reasoning');
    const newContentParts = hasReasoning
      ? updateContentPart(state.contentParts, 'reasoning', (part) => ({
          ...part,
          content: reasoningContent,
        }))
      : prependContentPart(state.contentParts, {
          type: 'reasoning',
          content: reasoningContent,
        });

    const streamingMessage = this.createStreamingMessage(
      state.currentTextChunk,
      newContentParts,
    );
    this.updateChat({ streamingMessage });

    return createResult(state, {
      contentParts: newContentParts,
      reasoningChunks,
      streamingMessage,
    });
  }
}
