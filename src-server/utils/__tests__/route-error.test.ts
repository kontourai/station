import { describe, expect, test, vi } from 'vitest';
import { isRouteError, ROUTE_ERROR_NAME, RouteError } from '../route-error.js';

describe('RouteError', () => {
  test('carries the status, the client-facing message, and nothing else by default', () => {
    const error = new RouteError(404, 'Workflow not found');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(ROUTE_ERROR_NAME);
    expect(error.status).toBe(404);
    expect(error.clientMessage).toBe('Workflow not found');
    // `message` is the same text so anything reading an Error generically
    // (a logger, a test's `toThrow`) sees the reviewed string too.
    expect(error.message).toBe('Workflow not found');
    expect(error.code).toBeUndefined();
    expect(error.details).toBeUndefined();
    // Not merely undefined: absent. `new Error(m, { cause: undefined })`
    // installs an own `cause`, and "there is a cause and it is undefined" is
    // a different fact from "there is no cause".
    expect('cause' in error).toBe(false);
  });

  test('keeps code, details, and cause when supplied', () => {
    const cause = new Error('ENOSPC: no space left on device');
    const error = new RouteError(500, 'Could not save the workflow', {
      code: 'workflow_write_failed',
      details: { filename: 'build.ts' },
      cause,
    });

    expect(error.code).toBe('workflow_write_failed');
    expect(error.details).toEqual({ filename: 'build.ts' });
    expect(error.cause).toBe(cause);
  });

  test('an explicitly undefined cause is still recorded as a cause', () => {
    const error = new RouteError(500, 'Failed', { cause: undefined });

    expect('cause' in error).toBe(true);
    expect(error.cause).toBeUndefined();
  });
});

describe('isRouteError', () => {
  test('accepts a RouteError from this module', () => {
    expect(isRouteError(new RouteError(400, 'Missing param: slug'))).toBe(true);
  });

  test('accepts a copy built by a second loaded instance of the module', async () => {
    // `resetModules` clears the module registry, so this `import()` really
    // re-evaluates the file: a distinct `RouteError` constructor, exactly
    // as a `dist/` build loaded beside the `.ts` graph would produce. The
    // constructor-identity assertion is what makes the rest meaningful --
    // without it, a cached re-import would pass for the wrong reason.
    vi.resetModules();
    const second = await import('../route-error.js');
    expect(second.RouteError).not.toBe(RouteError);

    const copy = new second.RouteError(409, 'Workflow already exists', {
      code: 'workflow_exists',
    });

    expect(copy instanceof RouteError).toBe(false);
    expect(isRouteError(copy)).toBe(true);
    expect(copy.status).toBe(409);
  });

  test('accepts a subclass that renames itself', () => {
    class NarrowerRouteError extends RouteError {
      constructor() {
        super(403, 'Forbidden');
        this.name = 'NarrowerRouteError';
      }
    }

    expect(isRouteError(new NarrowerRouteError())).toBe(true);
  });

  test('rejects an ordinary error, a foreign value, and a look-alike', () => {
    expect(isRouteError(new Error('Missing param: slug'))).toBe(false);
    expect(isRouteError(undefined)).toBe(false);
    expect(isRouteError({ name: 'RouteError', status: 400 })).toBe(false);

    // Named like one, shaped like one, but the status is not a status the
    // boundary may hand to `c.json`.
    const impostor = new Error('teapot');
    impostor.name = ROUTE_ERROR_NAME;
    Object.assign(impostor, { status: 418, clientMessage: 'teapot' });
    expect(isRouteError(impostor)).toBe(false);

    // Named like one, valid status, but no client message to send.
    const messageless = new Error('no client message');
    messageless.name = ROUTE_ERROR_NAME;
    Object.assign(messageless, { status: 400 });
    expect(isRouteError(messageless)).toBe(false);
  });
});
