/**
 * station#4518 fix round (MED-2): `resolveOrchestrationRequestPrincipal`
 * (`runtime-routes.ts`) is wrapped in `memoizePerRequest` so that
 * `orchestration.ts`'s `readAuthorityFor(c)` — the single fail-closed
 * resolution point 41 call sites reach through — stops re-running the
 * timing-safe operator-credential comparison and paired-device registry
 * scan (a possible fsync) on every call, including the (at least) two real
 * handlers that call it MORE THAN ONCE within a single request (`GET
 * .../narrative/target`, `GET .../assessment/target`).
 *
 * This tests the EXPORTED, PRODUCTION memoization utility directly — the
 * same `memoizePerRequest` function `resolveOrchestrationRequestPrincipal`
 * is built from — rather than a hand-rolled duplicate. A counting spy
 * stands in for the expensive derivation (`identifyDevice` in production);
 * the two behaviors that matter are both pinned: the SAME `Request` object
 * reuses the first resolution (no re-derivation within one request), and a
 * DIFFERENT `Request` object re-derives (memoization never crosses
 * requests — a fresh `Request` per real HTTP call means there is nothing to
 * leak between callers).
 */
import { describe, expect, test, vi } from 'vitest';
import { memoizePerRequest } from '../runtime-routes.js';

describe('memoizePerRequest (station#4518 fix round MED-2)', () => {
  test('the same Request object reuses the first resolution — identifyDevice-shaped work runs once, not once per call', () => {
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
    const request = new Request('http://station/x', {
      headers: { authorization: 'Bearer device-cred' },
    });

    const first = resolve({ req: { raw: request } });
    const second = resolve({ req: { raw: request } });

    expect(second).toBe(first);
    expect(identifyDevice).toHaveBeenCalledTimes(1);
  });

  test('a different Request object re-derives — memoization never crosses requests', () => {
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

    resolve({ req: { raw: firstRequest } });
    resolve({ req: { raw: firstRequest } });
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
