import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from '../base64url';

describe('encodeBase64Url', () => {
  it('matches the unpadded URL alphabet for every padding length', () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length }, (_, index) => 251 + index);
      expect(encodeBase64Url(bytes)).toBe(
        Buffer.from(bytes).toString('base64url'),
      );
    }
  });

  it('uses - and _ where base64 uses + and /', () => {
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
  });

  it('encodes an input too large to spread into one call', () => {
    const bytes = new Uint8Array(1_000_000).fill(0xff);
    expect(encodeBase64Url(bytes)).toBe(
      Buffer.from(bytes).toString('base64url'),
    );
  });
});
