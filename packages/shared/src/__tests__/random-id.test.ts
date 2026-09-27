/**
 * station#1137 — `randomCorrelationId()` is the one fallback for
 * `crypto.randomUUID()` being absent (not throwing) in an insecure context.
 * These tests drive all three tiers directly: a spied `crypto.randomUUID`,
 * `crypto.getRandomValues` with `randomUUID` removed, and neither present at
 * all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomCorrelationId } from '../random-id';

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let originalCrypto: Crypto | undefined;
let cryptoWasDefined = false;

afterEach(() => {
  if (cryptoWasDefined) {
    Object.defineProperty(globalThis, 'crypto', {
      value: originalCrypto,
      configurable: true,
      writable: true,
    });
  }
  cryptoWasDefined = false;
  originalCrypto = undefined;
});

function stashGlobalCrypto() {
  originalCrypto = globalThis.crypto;
  cryptoWasDefined = true;
}

describe('randomCorrelationId', () => {
  it('uses crypto.randomUUID when available', () => {
    const minted = '0f1e2d3c-4b5a-4987-a654-3210fedcba98';
    const spy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(minted);
    try {
      expect(randomCorrelationId()).toBe(minted);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to crypto.getRandomValues when randomUUID is absent', () => {
    stashGlobalCrypto();
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        getRandomValues: real.getRandomValues.bind(real),
      },
      configurable: true,
      writable: true,
    });

    const id = randomCorrelationId();
    expect(id).toMatch(UUID_SHAPE);

    const first = id;
    const second = randomCorrelationId();
    expect(second).not.toBe(first);
  });

  it('falls back to Math.random when no Web Crypto API exists at all', () => {
    stashGlobalCrypto();
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const id = randomCorrelationId();
    expect(id).toMatch(UUID_SHAPE);

    const first = id;
    const second = randomCorrelationId();
    expect(second).not.toBe(first);
  });
});
