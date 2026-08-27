import type { StreamChunk, StreamHandler } from './types.js';

/**
 * Pipeline executor that chains handlers using generators
 *
 * Each handler processes the output of the previous handler.
 * Handlers can yield 0+ chunks per input chunk.
 */
export class StreamPipeline {
  private handlers: StreamHandler[] = [];

  constructor(private abortSignal?: AbortSignal) {}

  /**
   * Add a handler to the pipeline
   * Handlers are executed in the order they are added
   */
  use(handler: StreamHandler): this {
    this.handlers.push(handler);
    return this;
  }

  /**
   * Run the pipeline on a stream
   *
   * Chains all handlers together, then yields the final output.
   * Each handler processes the output of the previous handler.
   */
  async *run(input: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    // Check abort before starting
    if (this.abortSignal?.aborted) {
      throw new Error('Stream aborted by client');
    }

    let stream: AsyncIterable<StreamChunk> = input;

    // Chain handlers: each processes output of previous
    for (const handler of this.handlers) {
      stream = handler.process(stream);
    }

    // Yield final output, checking abort signal periodically
    for await (const chunk of stream) {
      if (this.abortSignal?.aborted) {
        throw new Error('Stream aborted by client');
      }
      yield chunk;
    }
  }

  /**
   * Finalize the stream
   *
   * Called after all chunks have been processed.
   * Calls finalize() on each handler that implements it.
   */
  async finalize(): Promise<Record<string, any>> {
    const results: Record<string, any> = {};

    for (const handler of this.handlers) {
      if ('finalize' in handler && typeof handler.finalize === 'function') {
        results[handler.name] = await handler.finalize();
      }
    }

    return results;
  }
}
