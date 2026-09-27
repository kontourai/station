/**
 * station#4518 fix round (MED-2): `resolveOrchestrationRequestPrincipal`
 * (`runtime/bootstrap/orchestration-request-principal.ts`) is built from
 * `memoizePerRequest` so that `orchestration.ts`'s `readAuthorityFor(c)` stops
 * re-running the timing-safe operator-credential comparison and paired-device
 * registry scan on every call within one request. A counting spy stands in
 * for that derivation (`identifyDevice` in production): the SAME `Request`
 * object reuses the first resolution, and a DIFFERENT `Request` object
 * re-derives, so memoization never crosses requests.
 */
import { describe, expect, test, vi } from 'vitest';
import { memoizePerRequest } from '../memoize-per-request.js';

describe('memoizePerRequest (station#4518 fix round MED-2)', () => {
  test('the same Request reuses the first resolution and a different Request re-derives', () => {
    const identifyDevice = vi.fn((credential: string) => ({
      id: 'device-x',
      name: 'Phone',
      credential,
    }));
    const resolve = memoizePerRequest((context: { req: { raw: Request } }) => {
      const device = identifyDevice(
        context.req.raw.headers.get('authorization') ?? '',
      );
      return {
        id: `human:device:${device.id}`,
        kind: 'human' as const,
        display: device.name,
      };
    });
    const firstRequest = new Request('http://station/x', {
      headers: { authorization: 'Bearer device-cred' },
    });
    const secondRequest = new Request('http://station/y', {
      headers: { authorization: 'Bearer device-cred' },
    });

    const first = resolve({ req: { raw: firstRequest } });
    expect(resolve({ req: { raw: firstRequest } })).toBe(first);
    expect(identifyDevice).toHaveBeenCalledTimes(1);

    resolve({ req: { raw: secondRequest } });
    expect(identifyDevice).toHaveBeenCalledTimes(2);
  });

  test('a thrown resolution is never cached — a later call on the same Request re-runs it', () => {
    let calls = 0;
    const resolve = memoizePerRequest((_context: { req: { raw: Request } }) => {
      calls += 1;
      throw new Error(`unresolved (attempt ${calls})`);
    });
    const request = new Request('http://station/x');

    expect(() => resolve({ req: { raw: request } })).toThrow(
      'unresolved (attempt 1)',
    );
    expect(() => resolve({ req: { raw: request } })).toThrow(
      'unresolved (attempt 2)',
    );
    expect(calls).toBe(2);
  });

  // LOW-A (station#4518 fix round, delta review): this is an EXPORTED
  // generic utility, so it must not assume `undefined` means "not cached" —
  // a future resolver that legitimately returns `undefined` has to be
  // cached too, or every call after the first silently re-runs the
  // (possibly expensive) resolution for no reason.
  test('a resolution that legitimately returns undefined is still cached — the resolver runs once', () => {
    const resolveCount = vi.fn(() => undefined);
    const resolve = memoizePerRequest(resolveCount);
    const request = new Request('http://station/x');

    expect(resolve({ req: { raw: request } })).toBeUndefined();
    expect(resolve({ req: { raw: request } })).toBeUndefined();

    expect(resolveCount).toHaveBeenCalledTimes(1);
  });
});
