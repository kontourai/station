import { describe, expect, test } from 'vitest';
import { redactConnectionSecretEchoes } from '../connection-refusal-redaction.js';

/**
 * Built from parts so the repo's secret scanner does not read the fixture as
 * a credential assignment; the value is a marker, not a key.
 */
const LONG_SECRET = ['fixture', 'long', 'marker', '00000000'].join('-');
const SHORT_SECRET = 'ab7q';

describe('redactConnectionSecretEchoes (review M1)', () => {
  test('redacts a long top-level value under any key name', () => {
    expect(
      redactConnectionSecretEchoes(`refused for ${LONG_SECRET}`, {
        anything: LONG_SECRET,
      }),
    ).toBe('refused for [redacted]');
  });

  test('redacts a SHORT value when its key is secret-shaped', () => {
    expect(
      redactConnectionSecretEchoes(`token=${SHORT_SECRET} rejected`, {
        apiKey: SHORT_SECRET,
      }),
    ).toBe('token=[redacted] rejected');
  });

  test('leaves a short value under an ordinary key alone', () => {
    // Over-redacting every four-character string would blank regions, model
    // families and status words out of the message.
    expect(
      redactConnectionSecretEchoes('region us-east-1 refused', {
        region: 'us-e',
      }),
    ).toBe('region us-east-1 refused');
  });

  test('redacts a NESTED secret, not just top-level config', () => {
    expect(
      redactConnectionSecretEchoes(`nested ${LONG_SECRET} leaked`, {
        modelRequestOptions: { headers: { authorization: LONG_SECRET } },
      }),
    ).toBe('nested [redacted] leaked');
  });

  test('redacts a secret inside an array value', () => {
    expect(
      redactConnectionSecretEchoes(`array ${LONG_SECRET}`, {
        extraKeys: [LONG_SECRET],
      }),
    ).toBe('array [redacted]');
  });

  test('redacts the URL-encoded echo of a secret', () => {
    const secret = `${LONG_SECRET}/with+chars`;
    const encoded = encodeURIComponent(secret);
    expect(encoded).not.toBe(secret);
    const message = redactConnectionSecretEchoes(`?key=${encoded}`, {
      apiKey: secret,
    });
    expect(message).toBe('?key=[redacted]');
    expect(message).not.toContain(encoded);
  });

  test('redacts the base64 echo of a secret, padded and URL-safe', () => {
    const standard = Buffer.from(LONG_SECRET, 'utf8').toString('base64');
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_');
    const message = redactConnectionSecretEchoes(
      `basic ${standard} / ${urlSafe}`,
      { apiKey: LONG_SECRET },
    );
    expect(message).not.toContain(standard);
    expect(message).not.toContain(urlSafe);
  });

  test('redacts the host of a configured base URL that the literal never matches', () => {
    // A normalized rendering drops the scheme and path, so a literal
    // substring pass over `baseUrl` would have found nothing.
    const message = redactConnectionSecretEchoes(
      'getaddrinfo ENOTFOUND models.internal.example',
      { baseUrl: 'https://models.internal.example/v1/' },
    );
    expect(message).not.toContain('models.internal.example');
    expect(message).toBe('getaddrinfo ENOTFOUND [redacted]');
  });

  test('redacts the origin form of a configured base URL', () => {
    const message = redactConnectionSecretEchoes(
      'POST https://models.internal.example/v1/models failed',
      { baseUrl: 'https://models.internal.example/v1' },
    );
    expect(message).not.toContain('models.internal.example');
  });

  test('a longer secret is not left readable by a shorter overlapping one', () => {
    const outer = `${LONG_SECRET}-suffix`;
    const message = redactConnectionSecretEchoes(`sent ${outer}`, {
      apiKey: outer,
      legacyKey: LONG_SECRET,
    });
    expect(message).toBe('sent [redacted]');
    expect(message).not.toContain('suffix');
  });

  // Delta review M1 — traversal used to stop past depth six, so a credential
  // nested deeper survived into a surfaced refusal while the module doc
  // promised "any depth".
  test('redacts a secret nested more than six levels deep', () => {
    let nested: Record<string, unknown> = { apiKey: LONG_SECRET };
    for (let level = 0; level < 12; level += 1) nested = { inner: nested };
    const message = redactConnectionSecretEchoes(`deep ${LONG_SECRET}`, nested);
    expect(message).toBe('deep [redacted]');
    expect(message).not.toContain(LONG_SECRET);
  });

  test('a cyclic config terminates instead of looping', () => {
    const cyclic: Record<string, unknown> = { apiKey: LONG_SECRET };
    cyclic.self = cyclic;
    cyclic.list = [cyclic, { nested: cyclic }];
    expect(redactConnectionSecretEchoes(`cycle ${LONG_SECRET}`, cyclic)).toBe(
      'cycle [redacted]',
    );
  });

  test('truncates a very long refusal', () => {
    const message = redactConnectionSecretEchoes('x'.repeat(600), {});
    expect(message.length).toBe(401);
    expect(message.endsWith('…')).toBe(true);
  });

  test('a non-string config value cannot crash the scrub', () => {
    expect(
      redactConnectionSecretEchoes('plain refusal', {
        enabled: true,
        retries: 3,
        nothing: null,
      }),
    ).toBe('plain refusal');
  });
});
