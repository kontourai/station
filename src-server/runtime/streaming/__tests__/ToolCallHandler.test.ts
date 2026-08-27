import { describe, expect, test } from 'vitest';
import { ToolCallHandler } from '../handlers/ToolCallHandler.js';
import type { StreamChunk } from '../types.js';
import { collect, toStream } from './helpers.js';

describe('ToolCallHandler', () => {
  test('augments tool-call events with parsed server/tool fields', async () => {
    const handler = new ToolCallHandler();
    const input = {
      type: 'tool-call',
      toolCallId: '1',
      toolName: 'myServer_doThing',
      args: {},
    } as unknown as StreamChunk;
    const result = await collect(handler.process(toStream([input])));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-call');
    expect((result[0] as any).server).toBeDefined();
    expect((result[0] as any).tool).toBeDefined();
  });

  test('passes through non-tool-call events', async () => {
    const handler = new ToolCallHandler();
    const input = {
      type: 'text-delta',
      id: '0',
      text: 'test',
    } as unknown as StreamChunk;
    const result = await collect(handler.process(toStream([input])));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text-delta');
  });

  test('passes through tool-call without toolName', async () => {
    const handler = new ToolCallHandler();
    const input = {
      type: 'tool-call',
      toolCallId: '1',
      args: {},
    } as unknown as StreamChunk;
    const result = await collect(handler.process(toStream([input])));

    expect(result).toHaveLength(1);
    expect((result[0] as any).server).toBeUndefined();
  });
});
