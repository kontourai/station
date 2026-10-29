import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TERMINAL_OUTPUT,
} from '@kontourai/station-contracts/terminal-transport';
import { describe, expect, test } from 'vitest';

describe('terminal transport public binary contract', () => {
  test('uses a big-endian channel and 64-bit sequence followed by raw UTF-8', () => {
    const bytes = Uint8Array.from([
      2, 0, 0, 0, 7, 0, 0, 0, 1, 0, 0, 0, 2, 0xc3, 0xa9,
    ]);
    expect(
      encodeTerminalFrame(
        TERMINAL_OUTPUT,
        7,
        4294967298,
        new TextEncoder().encode('é'),
      ),
    ).toEqual(bytes);
    expect(decodeTerminalFrame(bytes)).toEqual({
      kind: 2,
      channel: 7,
      seq: 4294967298,
      data: Uint8Array.from([0xc3, 0xa9]),
    });
    for (const invalid of [
      bytes.subarray(0, 12),
      Uint8Array.from([3, ...bytes.subarray(1)]),
      Uint8Array.from([2, 0, 0, 0, 0, ...bytes.subarray(5)]),
      Uint8Array.from([2, 0, 0, 0, 7, 0, 32, 0, 0, 0, 0, 0, 0]),
    ])
      expect(() => decodeTerminalFrame(invalid)).toThrow(
        'Invalid terminal frame',
      );
  });
});
