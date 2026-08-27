import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { AsyncEventQueue as GenericAsyncEventQueue } from '../sessions/async-event-queue.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export class AsyncEventQueue extends GenericAsyncEventQueue<CanonicalRuntimeEvent> {}

export class AsyncUserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<Deferred<IteratorResult<SDKUserMessage>>> = [];
  private closed = false;

  push(message: SDKUserMessage): boolean {
    if (this.closed) {
      return false;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: message, done: false });
      return true;
    }
    this.items.push(message);
    return true;
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const queued = this.items.shift();
        if (queued) {
          return { value: queued, done: false };
        }
        if (this.closed) {
          return { value: undefined as never, done: true };
        }
        const waiter = createDeferred<IteratorResult<SDKUserMessage>>();
        this.waiters.push(waiter);
        return waiter.promise;
      },
    };
  }
}
