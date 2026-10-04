import { describe, expect, test } from 'vitest';
import { InjectableStream } from '../InjectableStream.js';
import type { StreamChunk } from '../types.js';

const chunk = (text: string) =>
  ({ type: 'text-delta', text }) as unknown as StreamChunk;

describe('InjectableStream', () => {
  test('emits an injected event while the source is silent (#3284)', async () => {
    const stream = new InjectableStream();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* source() {
      yield chunk('before');
      // A tool call blocked on a person: no source chunk until they answer.
      await held;
      yield chunk('after');
    }
    const iterator = stream.wrap(source())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(chunk('before'));
    const pending = iterator.next();
    stream.inject(chunk('form'));
    // Resolves before the source moves at all.
    expect((await pending).value).toEqual(chunk('form'));
    release();
    expect((await iterator.next()).value).toEqual(chunk('after'));
    expect((await iterator.next()).done).toBe(true);
  });

  test('keeps source order and loses no chunk around injections', async () => {
    const stream = new InjectableStream();
    async function* source() {
      yield chunk('a');
      yield chunk('b');
      yield chunk('c');
    }
    const seen: unknown[] = [];
    for await (const item of stream.wrap(source())) {
      seen.push((item as unknown as { text: string }).text);
      if (seen.length === 1) stream.inject(chunk('x'));
    }
    expect(seen).toEqual(['a', 'x', 'b', 'c']);
  });

  test('an abandoned wrap releases its source', async () => {
    const stream = new InjectableStream();
    let returned = false;
    const source: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false, value: chunk('a') }),
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    for await (const _ of stream.wrap(source)) break;
    expect(returned).toBe(true);
  });
});
