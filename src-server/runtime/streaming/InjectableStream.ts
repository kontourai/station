import type { StreamChunk } from './types.js';

/**
 * Stream wrapper that allows injecting events at chunk boundaries
 *
 * Events are injected by external code (e.g., elicitation callback)
 * and emitted at safe boundaries to ensure proper ordering.
 *
 * An injected event is emitted as soon as it is injected, without waiting for
 * the source's next chunk (#3284): a tool call blocked on a person's answer
 * produces no further source chunks until that person answers, so an event
 * held for "the next chunk" would never reach them.
 */
export class InjectableStream {
  private buffer: StreamChunk[] = [];
  private wake: (() => void) | undefined;

  /**
   * Wrap a source stream and inject buffered events in order
   */
  async *wrap(source: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    const iterator = source[Symbol.asyncIterator]();
    // One source read stays outstanding across injections, so no chunk is
    // requested twice or dropped while an injected event is emitted.
    let pending: Promise<IteratorResult<StreamChunk>> | undefined;
    let finished = false;
    try {
      while (true) {
        while (this.buffer.length > 0) yield this.buffer.shift()!;
        pending ??= iterator.next();
        const injected = new Promise<undefined>((resolve) => {
          this.wake = () => resolve(undefined);
        });
        const next = await Promise.race([pending, injected]);
        this.wake = undefined;
        if (next === undefined) continue;
        pending = undefined;
        if (next.done) {
          finished = true;
          break;
        }
        yield next.value;
      }
      while (this.buffer.length > 0) yield this.buffer.shift()!;
    } finally {
      this.wake = undefined;
      // An abandoned wrap releases its source. A read still in flight cannot
      // be awaited here without hanging on the very chunk nobody will take.
      if (!finished) {
        const closing = iterator.return?.();
        if (pending === undefined) await closing;
        else void Promise.resolve(closing).catch(() => undefined);
      }
    }
  }

  /**
   * Inject an event to be emitted before the next chunk
   */
  inject(event: StreamChunk) {
    this.buffer.push(event);
    this.wake?.();
  }
}
