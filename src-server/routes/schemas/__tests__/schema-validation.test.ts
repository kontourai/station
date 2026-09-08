import type { Context } from 'hono';
import { describe, expect, test } from 'vitest';
import { isRouteError, type RouteError } from '../../../utils/route-error.js';
import { errorMessage, param } from '../schema-validation.js';

function contextWithParams(params: Record<string, string>): Context {
  return {
    req: { param: (name: string) => params[name] },
  } as unknown as Context;
}

describe('schema-validation helpers', () => {
  test('errorMessage sanitizes Error instances', () => {
    expect(
      errorMessage(
        new Error(
          'engine stderr https://provider.example.test/private?token=secret',
        ),
      ),
    ).toBe('engine stderr [REDACTED_URL]');
  });

  test('errorMessage refuses to coerce non-Error values', () => {
    expect(errorMessage({ code: 'E_FAIL' })).toBe('Request failed');
  });

  test('param returns a present value', () => {
    expect(param(contextWithParams({ slug: 'planner' }), 'slug')).toBe(
      'planner',
    );
  });

  test('param refuses a missing one as a typed 400 the boundary can answer', () => {
    let thrown: unknown;
    try {
      param(contextWithParams({}), 'slug');
    } catch (error) {
      thrown = error;
    }

    // Typed, so a route with no `try` of its own still answers 400 rather
    // than the boundary's generic 500.
    expect(isRouteError(thrown)).toBe(true);
    const routeError = thrown as RouteError;
    expect(routeError.status).toBe(400);
    expect(routeError.code).toBe('missing_param');
    // The text is byte-identical to the plain Error this used to throw, so
    // every route still catching and formatting it answers what it did
    // before.
    expect(routeError.message).toBe('Missing param: slug');
    expect(routeError.clientMessage).toBe('Missing param: slug');
  });
});
