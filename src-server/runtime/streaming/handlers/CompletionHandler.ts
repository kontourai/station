import type { StreamChunk, StreamHandler } from '../types.js';

/**
 * Tracks completion state and writes [DONE] marker at end
 *
 * Note: With generator pattern, this handler doesn't write [DONE] during processing.
 * The [DONE] marker should be written by the runtime after the pipeline completes.
 *
 * This handler just tracks state for the finalize() method.
 */
export class CompletionHandler implements StreamHandler {
  name = 'completion';

  private hasOutput = false;
  private completionReason = 'completed';
  private accumulatedText = '';

  async *process(
    input: AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk> {
    for await (const chunk of input) {
      // Track completion state
      this.trackCompletion(chunk);

      // Pass through unchanged
      yield chunk;
    }
  }

  private trackCompletion(chunk: StreamChunk): void {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      this.hasOutput = true;
      this.accumulatedText += chunk.text || '';
    }

    if (chunk.type === 'finish') {
      this.completionReason = chunk.finishReason || 'completed';
    }
  }

  finalize() {
    return {
      hasOutput: this.hasOutput,
      completionReason: this.completionReason,
      accumulatedText: this.accumulatedText,
    };
  }
}
