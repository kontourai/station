import type { StreamChunk, StreamHandler } from '../types.js';

/**
 * Pass-through handler for text events
 *
 * With the generator pattern, ReasoningHandler already emits properly formatted
 * text-delta events, so this handler just passes everything through.
 */
export class TextDeltaHandler implements StreamHandler {
  name = 'text-delta';

  async *process(
    input: AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk> {
    for await (const chunk of input) {
      yield chunk;
    }
  }
}
