import type { StreamChunk } from './types.js';

/**
 * Stream wrapper that allows injecting events at chunk boundaries
 *
 * Events are injected by external code (e.g., elicitation callback)
 * and emitted at safe boundaries to ensure proper ordering.
 */
export class InjectableStream {
  private buffer: StreamChunk[] = [];

  /**
   * Wrap a source stream and inject buffered events in order
   */
  async *wrap(source: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    for await (const chunk of source) {
      // Emit any buffered events before this chunk
      while (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      }
      yield chunk;
    }

    // Yield remaining buffered events
    while (this.buffer.length > 0) {
      yield this.buffer.shift()!;
    }
  }

  /**
   * Inject an event to be emitted before the next chunk
   */
  inject(event: StreamChunk) {
    this.buffer.push(event);
  }
}
