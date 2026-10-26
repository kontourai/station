import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const ajvRequire = createRequire(require.resolve('ajv'));
const uri: typeof import('fast-uri') = ajvRequire('fast-uri');

for (const caller of ['@kontourai/fieldwork', '@kontourai/survey']) {
  test(`${caller} constrained array rejects excess elements before visiting them`, () => {
    const fromCaller = createRequire(import.meta.resolve(caller));
    const { z }: typeof import('zod') = fromCaller('zod');
    let visits = 0;
    const schema = z
      .array(
        z.string().superRefine(() => {
          visits++;
        }),
      )
      .max(4);
    const oversized = schema.safeParse(['a', 'b', 'c', 'd', 'e']);
    expect(oversized.success).toBe(false);
    if (oversized.success) throw Error('oversized collection was accepted');
    expect(oversized.error.issues).toMatchObject([
      { code: 'too_big', maximum: 4, path: [] },
    ]);
    expect(visits).toBe(0);
    expect(schema.safeParse(['a', 'b']).success).toBe(true);
    expect(visits).toBe(2);
    expect(schema.safeParse([42]).success).toBe(false);
  });
}

test('Ajv URI normalization never turns an encoded scheme into an executable scheme', () => {
  expect(uri.normalize('https://EXAMPLE.test/a')).toBe(
    'https://example.test/a',
  );
  for (const input of ['%6Aavascript:alert(1)', '%u006Aavascript:alert(1)']) {
    expect(uri.parse(input).scheme).not.toBe('javascript');
    expect(uri.normalize(input)).not.toBe('javascript:alert(1)');
    expect(uri.resolve('https://example.test/', input)).not.toBe(
      'javascript:alert(1)',
    );
  }
  expect(uri.equal('%68ttp://example.test/', 'http://example.test/')).toBe(
    false,
  );
});

test('Ajv URI normalization preserves leading parent segments in relative references', () => {
  expect(uri.normalize('../x')).toBe('../x');
  expect(uri.normalize('a/../b')).toBe('b');
  const base = 'https://example.test/one/two/';
  expect(uri.resolve(base, uri.normalize('../x'))).toBe(
    uri.resolve(base, '../x'),
  );
  expect(uri.equal('../x', 'x')).toBe(false);
});

test('Ajv URI parsing refuses ambiguous or whitespace-smuggled HTTP hosts', () => {
  expect(uri.parse('https://example.test/a').error).toBeUndefined();
  for (const input of [
    'http://a@b@evil.example/',
    'http://ex\tample.test/',
    'http://ex\nample.test/',
    'http://ex\rample.test/',
  ]) {
    expect(uri.parse(input).error).toEqual(expect.any(String));
  }
});

test('Ajv suffix serialization escapes a first-segment colon instead of creating a scheme', () => {
  expect(uri.normalize('one/two', { reference: 'suffix' })).toBe('one/two');
  const normalized = uri.normalize('javascript:alert(1)', {
    reference: 'suffix',
  });
  expect(normalized).not.toBe('javascript:alert(1)');
  expect(uri.parse(normalized).scheme).toBeUndefined();
});

for (const algorithm of ['sha256', 'SHA256', 'Sha256']) {
  test(`jsdom transport verifies ${algorithm} integrity before returning response bytes`, async () => {
    const fromJsdom = createRequire(require.resolve('jsdom'));
    const undici: typeof import('undici') = fromJsdom('undici');
    const dispatcher = new undici.MockAgent();
    dispatcher.disableNetConnect();
    const origin = 'https://dependency-integrity.invalid';
    const pool = dispatcher.get(origin);
    const digest = createHash('sha256').update('authentic').digest('base64');
    const integrity = `${algorithm}-${digest}`;
    pool.intercept({ path: '/tampered', method: 'GET' }).reply(200, 'tampered');
    pool
      .intercept({ path: '/matching', method: 'GET' })
      .reply(200, 'authentic');
    try {
      await expect(
        undici.fetch(`${origin}/tampered`, { dispatcher, integrity }),
      ).rejects.toThrow();
      const matching = await undici.fetch(`${origin}/matching`, {
        dispatcher,
        integrity,
      });
      expect(await matching.text()).toBe('authentic');
      dispatcher.assertNoPendingInterceptors();
    } finally {
      await dispatcher.close();
    }
  });
}
