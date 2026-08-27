import { describe, expect, test } from 'vitest';
import { TextDeltaHandler } from '../handlers/TextDeltaHandler.js';
import type { StreamChunk } from '../types.js';
import { collect, toStream } from './helpers.js';

describe('TextDeltaHandler', () => {
  test('passes through text-delta events', async () => {
    const handler = new TextDeltaHandler();
    const input = {
      type: 'text-delta',
      id: '0',
      text: 'test',
    } as unknown as StreamChunk;
    const result = await collect(handler.process(toStream([input])));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text-delta');
  });

  test('passes through non-text-delta events', async () => {
    const handler = new TextDeltaHandler();
    const input = {
      type: 'tool-call',
      toolCallId: '1',
      toolName: 'test',
      args: {},
    } as unknown as StreamChunk;
    const result = await collect(handler.process(toStream([input])));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-call');
  });

  test('preserves all chunks in order', async () => {
    const handler = new TextDeltaHandler();
    const chunks: StreamChunk[] = [
      { type: 'text-delta', id: '0', text: 'hello' } as unknown as StreamChunk,
      { type: 'text-delta', id: '0', text: ' world' } as unknown as StreamChunk,
    ];
    const result = await collect(handler.process(toStream(chunks)));

    expect(result).toHaveLength(2);
    expect((result[0] as any).text).toBe('hello');
    expect((result[1] as any).text).toBe(' world');
  });

  test('handles empty stream', async () => {
    const handler = new TextDeltaHandler();
    const result = await collect(handler.process(toStream([])));
    expect(result).toHaveLength(0);
  });
});
