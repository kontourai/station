import { createRequire } from 'node:module';
import { afterEach, describe, expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const consumer = require.resolve('make-fetch-happen/lib/cache/policy.js');
const CachePolicy = createRequire(consumer)('http-cache-semantics');
const request = {
  url: 'https://cache.example.invalid/entry',
  method: 'GET',
  headers: { host: 'cache.example.invalid' },
};
const cookie = 'session=cache-isolation-canary';
const directives = 'stale-while-revalidate=3600, stale-if-error=3600';
const cases = [
  {
    name: 'shared cookie without public opt-in',
    shared: true,
    headers: {
      'set-cookie': cookie,
      'cache-control': `max-age=600, ${directives}`,
    },
    reusable: false,
  },
  {
    name: 'explicitly public cookie',
    shared: true,
    headers: {
      'set-cookie': cookie,
      'cache-control': `public, max-age=1, ${directives}`,
    },
    reusable: true,
  },
  {
    name: 'explicitly immutable cookie',
    shared: true,
    headers: {
      'set-cookie': cookie,
      'cache-control': `immutable, max-age=1, ${directives}`,
    },
    reusable: true,
  },
  {
    name: 'private cache cookie',
    shared: false,
    headers: {
      'set-cookie': cookie,
      'cache-control': `max-age=1, ${directives}`,
    },
    reusable: true,
  },
  {
    name: 'ordinary shared response',
    shared: true,
    headers: { 'cache-control': `max-age=1, ${directives}` },
    reusable: true,
  },
];

afterEach(() => vi.useRealTimers());

describe.each(cases)('installed CachePolicy: $name', (entry) => {
  describe.each(['live', 'serialized'])('%s policy', (form) => {
    const policy = () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
      const current = new CachePolicy(
        request,
        {
          status: 200,
          headers: {
            date: 'Mon, 12 Oct 2026 11:59:00 GMT',
            etag: '"cache-validator"',
            ...entry.headers,
          },
        },
        { shared: entry.shared },
      );
      return form === 'serialized'
        ? CachePolicy.fromObject(JSON.parse(JSON.stringify(current.toObject())))
        : current;
    };

    test.each(['max-stale', 'max-stale=86400'])(
      'legacy consumer and request evaluation agree for %s',
      (directive) => {
        const current = policy();
        const staleRequest = {
          ...request,
          headers: { ...request.headers, 'cache-control': directive },
        };
        expect(current.satisfiesWithoutRevalidation(staleRequest)).toBe(
          entry.reusable,
        );
        expect(Boolean(current.evaluateRequest(staleRequest).response)).toBe(
          entry.reusable,
        );
      },
    );

    test('background revalidation respects shared-cookie isolation', () => {
      const current = policy();
      expect(current.useStaleWhileRevalidate()).toBe(entry.reusable);
      expect(Boolean(current.evaluateRequest(request).response)).toBe(
        entry.reusable,
      );
    });

    test('server error cannot return an isolated shared cookie', () => {
      const current = policy();
      const result = current.revalidatedPolicy(request, {
        status: 503,
        headers: { date: 'Mon, 12 Oct 2026 12:00:00 GMT' },
      });
      expect(result.policy === current && result.modified === false).toBe(
        entry.reusable,
      );
    });

    test('missing revalidation response cannot return an isolated shared cookie', () => {
      const current = policy();
      if (!entry.reusable) {
        expect(() => current.revalidatedPolicy(request, undefined)).toThrow(
          'Response headers missing',
        );
      } else {
        const result = current.revalidatedPolicy(request, undefined);
        expect(result.policy).toBe(current);
        expect(result.modified).toBe(false);
      }
    });

    test('matching 304 revalidation preserves the validated response', () => {
      const current = policy();
      const result = current.revalidatedPolicy(request, {
        status: 304,
        headers: {
          date: 'Mon, 12 Oct 2026 12:00:00 GMT',
          etag: '"cache-validator"',
        },
      });
      expect(result.matches).toBe(true);
      expect(result.modified).toBe(false);
      expect(result.policy.storable()).toBe(true);
    });
  });
});
