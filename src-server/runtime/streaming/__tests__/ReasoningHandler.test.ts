import { describe, expect, test } from 'vitest';
import { ReasoningHandler } from '../handlers/ReasoningHandler.js';
import type { StreamChunk } from '../types.js';
import { collect, toStream } from './helpers.js';

/** Runs one text block, delivered as `deltas`, through a thinking-enabled handler. */
async function runTextBlock(deltas: string[]) {
  const handler = new ReasoningHandler({ enableThinking: true });
  const result = await collect(
    handler.process(
      toStream([
        { type: 'text-start', id: '0' } as StreamChunk,
        ...deltas.map(
          (text) => ({ type: 'text-delta', id: '0', text }) as StreamChunk,
        ),
        { type: 'text-end', id: '0' } as StreamChunk,
      ]),
    ),
  );
  const joined = (type: string) =>
    result
      .filter((chunk) => chunk.type === type)
      .map((chunk) => chunk.text)
      .join('');
  return {
    result,
    reasoning: joined('reasoning-delta'),
    text: joined('text-delta'),
  };
}

describe('ReasoningHandler', () => {
  test.each([
    ['one delta', ['<thinking>thought</thinking>']],
    ['tags in their own deltas', ['<thinking>', 'thought', '</thinking>']],
    [
      'tags split across deltas',
      ['<thin', 'king>', 'thought', '</think', 'ing>'],
    ],
  ])(
    'moves a thinking block into reasoning, delivered as %s',
    async (_label, deltas) => {
      const { result, reasoning, text } = await runTextBlock(deltas);

      expect(reasoning).toBe('thought');
      // Neither the thought nor any tag byte leaks into visible text.
      expect(text).toBe('');
      const types = result.map((chunk) => chunk.type);
      expect(types[0]).toBe('reasoning-start');
      expect(types.lastIndexOf('reasoning-delta')).toBeLessThan(
        types.indexOf('reasoning-end'),
      );
      expect(types).not.toContain('text-delta');
    },
  );

  test('keeps the text around a thinking block visible and in order', async () => {
    const { result, reasoning, text } = await runTextBlock([
      'Before <thin',
      'king>plan</thinking>after',
    ]);

    expect(reasoning).toBe('plan');
    expect(text).toBe('Before after');
    // Order of content, not chunking: consecutive deltas of one kind merge.
    const segments: { type: string; text: string }[] = [];
    for (const chunk of result) {
      if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') {
        continue;
      }
      const last = segments.at(-1);
      if (last?.type === chunk.type) last.text += chunk.text;
      else segments.push({ type: chunk.type, text: chunk.text });
    }
    expect(segments).toEqual([
      { type: 'text-delta', text: 'Before ' },
      { type: 'reasoning-delta', text: 'plan' },
      { type: 'text-delta', text: 'after' },
    ]);
  });

  test('passes regular text through unchanged, including a prefix that was not a tag', async () => {
    const { reasoning, text } = await runTextBlock([
      'regular <thin',
      'x> text',
    ]);

    expect(reasoning).toBe('');
    expect(text).toBe('regular <thinx> text');
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
