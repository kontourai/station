import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import { utf8Chunks } from '../../../providers/tool-output-projection.js';
import {
  jsonStringBodyBytes,
  splitJsonTextByEscapedBytes,
} from '../../../utils/json-text-bytes.js';
import { DeltaCoalescer } from '../delta-coalescer.js';
import {
  DELTA_SPLIT_MAX_BYTES,
  splitOversizedDelta,
} from '../delta-splitting.js';

const delta = (text: string, eventId = 'd1') =>
  ({
    eventId,
    provider: 'claude',
    threadId: 't',
    turnId: 'turn',
    itemId: 'item',
    createdAt: '2026-10-26T00:00:00.000Z',
    method: 'content.text-delta',
    delta: text,
  }) as CanonicalRuntimeEvent;

describe('JSON text byte counting and splitting', () => {
  test.each([
    ['ascii', 'abc'],
    ['escapes', '"\\\n\t\b\f\r'],
    ['control', '\u0001\u001f'],
    ['cjk', '中文内容'],
    ['emoji pair', '😀😀'],
    ['lone surrogates', '\ud800x\udc00'],
  ])('counts %s exactly as JSON.stringify encodes it', (_label, text) => {
    expect(jsonStringBodyBytes(text)).toBe(
      Buffer.byteLength(JSON.stringify(text)) - 2,
    );
  });

  test('chunks reassemble exactly, never split a pair, and fit the budget', () => {
    const text = '😀中"\n\u0002a'.repeat(5_000);
    const chunks = splitJsonTextByEscapedBytes(text, 1000);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(jsonStringBodyBytes(chunk)).toBeLessThanOrEqual(1000);
      expect(/^[\udc00-\udfff]/u.test(chunk)).toBe(false);
      expect(/[\ud800-\udbff]$/u.test(chunk)).toBe(false);
    }
  });

  test('is linear: 16 MiB splits in well under a second', () => {
    const text = 'abcdefgh'.repeat(2 * 1024 * 1024);
    const started = performance.now();
    const chunks = utf8Chunks(text, 16 * 1024);
    const elapsed = performance.now() - started;
    expect(chunks.join('').length).toBe(text.length);
    // The quadratic predecessor took about 11 s here.
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe('splitOversizedDelta', () => {
  test('leaves a delta within the budget untouched', () => {
    const event = delta('short');
    expect(splitOversizedDelta(event)).toEqual([event]);
  });

  test('splits an oversized delta into ordered chunks with derived ids', () => {
    const text = '回答 '.repeat(20_000);
    const chunks = splitOversizedDelta(delta(text));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.eventId)).toEqual(
      chunks.map((_, i) => (i === 0 ? 'd1' : `d1:${i}`)),
    );
    expect(chunks.map((c) => (c as { delta: string }).delta).join('')).toBe(
      text,
    );
    for (const chunk of chunks)
      expect(
        jsonStringBodyBytes((chunk as { delta: string }).delta),
      ).toBeLessThanOrEqual(DELTA_SPLIT_MAX_BYTES);
    // A replay of the same delta produces the same ids.
    expect(splitOversizedDelta(delta(text)).map((c) => c.eventId)).toEqual(
      chunks.map((c) => c.eventId),
    );
  });

  test('never touches a child-work delta object', () => {
    const event = {
      ...delta('x'),
      method: 'child-work.updated',
      delta: { kind: 'x', item: 'y'.repeat(20_000) },
    } as unknown as CanonicalRuntimeEvent;
    expect(splitOversizedDelta(event)).toEqual([event]);
  });
});

describe('DeltaCoalescer byte cap', () => {
  test('caps merged CJK text by bytes, not characters', () => {
    const published: CanonicalRuntimeEvent[] = [];
    const coalescer = new DeltaCoalescer((event) => published.push(event), {
      windowMs: 1_000_000,
      setTimer: () => 'timer',
      clearTimer: () => {},
    });
    // 3,000 CJK characters per delta is 9,000 bytes: two merged would pass
    // 8 KiB, which an 8,000-character cap would have allowed.
    coalescer.offer(delta('a', 'first'));
    for (let index = 0; index < 4; index += 1)
      coalescer.offer(delta('中'.repeat(3_000), `cjk-${index}`));
    coalescer.flushAll();
    for (const event of published)
      expect(
        jsonStringBodyBytes((event as { delta: string }).delta),
      ).toBeLessThanOrEqual(9_000);
  });
});
