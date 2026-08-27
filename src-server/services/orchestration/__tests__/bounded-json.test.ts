import { describe, expect, it } from 'vitest';
import { measureBoundedJson } from '../bounded-json.js';

const generous = {
  maxBytes: 1_000_000,
  maxDepth: 8,
  maxItems: 100,
  maxStringCodeUnits: 100_000,
  maxKeyCodeUnits: 1_000,
};

describe('measureBoundedJson', () => {
  it('matches JSON.stringify UTF-8 bytes including syntax and escaping', () => {
    const values = [
      { text: 'quote" slash\\ nul\0 line\n tab\t' },
      { emoji: '🧭', twoByte: 'é', threeByte: '界' },
      [null, true, false, -12.5, { nested: 'value' }],
    ];
    for (const value of values) {
      const measured = measureBoundedJson(value, generous);
      expect(measured).toEqual({
        ok: true,
        bytes: Buffer.byteLength(JSON.stringify(value)),
      });
    }
  });

  it('accepts the exact byte boundary and rejects one byte below it', () => {
    const value = { text: '"\0🧭' };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    expect(measureBoundedJson(value, { ...generous, maxBytes: bytes })).toEqual(
      {
        ok: true,
        bytes,
      },
    );
    expect(
      measureBoundedJson(value, { ...generous, maxBytes: bytes - 1 }),
    ).toEqual({ ok: false, reason: 'bytes' });
  });

  it('rejects inherited, accessor, proxy, cycle, and huge strings before reading content', () => {
    let getterReads = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'text', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'secret';
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const inherited = Object.create({ inherited: 'value' });
    inherited.own = 'value';
    let proxyReads = 0;
    const proxy = new Proxy(
      { text: 'value' },
      {
        getPrototypeOf() {
          proxyReads += 1;
          throw new Error('trap');
        },
      },
    );
    expect(measureBoundedJson(accessor, generous).ok).toBe(false);
    expect(getterReads).toBe(0);
    expect(measureBoundedJson(cycle, generous)).toEqual({
      ok: false,
      reason: 'cycle',
    });
    expect(measureBoundedJson(inherited, generous).ok).toBe(false);
    expect(measureBoundedJson(proxy, generous).ok).toBe(false);
    expect(proxyReads).toBe(1);
    expect(
      measureBoundedJson('x'.repeat(100_001), {
        ...generous,
        maxStringCodeUnits: 100_000,
      }),
    ).toEqual({ ok: false, reason: 'string' });
  });
});
