import type { StreamChunk, StreamHandler } from './types.js';

/** Ordered async-generator handlers may emit zero or more chunks per input. */
export class StreamPipeline {
  private handlers: StreamHandler[] = [];

  constructor(private abortSignal?: AbortSignal) {}

  /** Append a handler; registration order is execution order. */
  use(handler: StreamHandler): this {
    this.handlers.push(handler);
    return this;
  }

  async *run(input: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    if (this.abortSignal?.aborted) {
      throw new Error('Stream aborted by client');
    }

    let stream: AsyncIterable<StreamChunk> = input;

    for (const handler of this.handlers) {
      stream = handler.process(stream);
    }

    for await (const chunk of stream) {
      if (this.abortSignal?.aborted) {
        throw new Error('Stream aborted by client');
      }
      yield chunk;
    }
  }

  /** Collect each handler's final result under its name. */
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
