import { describe, expect, test } from 'vitest';
import { ReasoningHandler } from '../handlers/ReasoningHandler.js';
import type { StreamChunk } from '../types.js';
import { collect, toStream } from './helpers.js';

describe('ReasoningHandler', () => {
  test('detects thinking block start', async () => {
    const handler = new ReasoningHandler({ enableThinking: true });
    const result = await collect(
      handler.process(
        toStream([
          { type: 'text-start', id: '0' } as StreamChunk,
          {
            type: 'text-delta',
            id: '0',
            text: '<thinking>thought</thinking>',
          } as unknown as StreamChunk,
          { type: 'text-end', id: '0' } as StreamChunk,
        ]),
      ),
    );

    expect(result.some((c) => c.type === 'reasoning-start')).toBe(true);
  });

  test('buffers content inside thinking block', async () => {
    const handler = new ReasoningHandler({ enableThinking: true });
    const result = await collect(
      handler.process(
        toStream([
          { type: 'text-start', id: '0' } as StreamChunk,
          {
            type: 'text-delta',
            id: '0',
            text: '<thinking>',
          } as unknown as StreamChunk,
          {
            type: 'text-delta',
            id: '0',
            text: 'test content',
          } as unknown as StreamChunk,
          {
            type: 'text-delta',
            id: '0',
            text: '</thinking>',
          } as unknown as StreamChunk,
          { type: 'text-end', id: '0' } as StreamChunk,
        ]),
      ),
    );

    const deltas = result.filter((c) => c.type === 'reasoning-delta');
    expect(deltas.length).toBeGreaterThan(0);
  });

  test('detects thinking block end', async () => {
    const handler = new ReasoningHandler({ enableThinking: true });
    const result = await collect(
      handler.process(
        toStream([
          { type: 'text-start', id: '0' } as StreamChunk,
          {
            type: 'text-delta',
            id: '0',
            text: '<thinking>content</thinking>',
          } as unknown as StreamChunk,
          { type: 'text-end', id: '0' } as StreamChunk,
        ]),
      ),
    );

    expect(result.some((c) => c.type === 'reasoning-end')).toBe(true);
  });

  test('handles tag split across chunks', async () => {
    const handler = new ReasoningHandler({ enableThinking: true });
    const result = await collect(
      handler.process(
        toStream([
          { type: 'text-start', id: '0' } as StreamChunk,
          {
            type: 'text-delta',
            id: '0',
            text: '<thin',
          } as unknown as StreamChunk,
          {
            type: 'text-delta',
            id: '0',
            text: 'king>',
          } as unknown as StreamChunk,
          {
            type: 'text-delta',
            id: '0',
            text: 'thought',
          } as unknown as StreamChunk,
          {
            type: 'text-delta',
            id: '0',
            text: '</think',
          } as unknown as StreamChunk,
          {
            type: 'text-delta',
            id: '0',
            text: 'ing>',
          } as unknown as StreamChunk,
          { type: 'text-end', id: '0' } as StreamChunk,
        ]),
      ),
    );

    expect(result.some((c) => c.type === 'reasoning-start')).toBe(true);
    expect(result.some((c) => c.type === 'reasoning-end')).toBe(true);
  });

  test('passes through non-thinking text as text-delta', async () => {
    const handler = new ReasoningHandler({ enableThinking: true });
    const result = await collect(
      handler.process(
        toStream([
          { type: 'text-start', id: '0' } as StreamChunk,
          {
            type: 'text-delta',
            id: '0',
            text: 'regular text',
          } as unknown as StreamChunk,
          { type: 'text-end', id: '0' } as StreamChunk,
        ]),
      ),
    );

    const textDeltas = result.filter((c) => c.type === 'text-delta');
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  test('passes through non-text-delta chunks', async () => {
    const handler = new ReasoningHandler({ enableThinking: true });
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
});
