import { expect, it } from 'vitest';
import { agentWire, readAgentWire } from '../internal.js';

it('the optimized wire encoder preserves dense arrays, undefined and binary/date values', () => {
  const value = [
    undefined,
    null,
    -0,
    new Date('2026-11-01T00:00:00.000Z'),
    new Uint8Array([0, 255]),
    { text: 'retained' },
  ];
  expect(readAgentWire(agentWire(value))).toEqual(value);
});
it('a sparse or accessor-backed array cannot silently change the pinned request', () => {
  expect(() => agentWire(Array(1))).toThrow('UNSUPPORTED');
  let reads = 0;
  const value: unknown[] = [];
  Object.defineProperty(value, '0', {
    enumerable: true,
    get() {
      reads++;
      return 'changed';
    },
  });
  expect(() => agentWire(value)).toThrow('UNSUPPORTED');
  expect(reads).toBe(0);
});
