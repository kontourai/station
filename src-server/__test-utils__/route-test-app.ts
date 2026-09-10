/**
 * Builds a Hono app with Station's runtime HTTP error boundary wired in, for
 * route tests that need routes to behave the way the server makes them
 * behave.
 *
 * Why this exists: 115 of the 119 route test files build their app with a
 * bare `new Hono()` (or request a `create*Routes()` sub-app directly), so
 * `configureRuntimeHttp` — the thing that turns a thrown error into a JSON
 * envelope — is not in the stack at all. That was invisible while every
 * route caught its own errors and formatted them by hand. As route families
 * move onto the `RouteError` contract and start *throwing* instead, a test
 * app without the boundary sees Hono's bare default handler rather than the
 * envelope the client actually receives, and asserts nothing real about the
 * response. Mount through this and the test exercises the same boundary
 * production does.
 *
 * Mount routes the ordinary way and request them at that path:
 *
 * ```ts
 * const app = createRouteTestApp();
 * app.route('/agents', createWorkflowRoutes(layoutService));
 * const response = await app.request('/agents/planner/workflows/files');
 * ```
 *
 * **No `security` options, deliberately.** `configureRuntimeHttp` wires the
 * pairing/credential middleware only when it is given `security`, and with
 * it every request in a route test is refused before reaching the route:
 * measured against the minimal stub in `learning-source-test-harness.ts`, an
 * ad-hoc test path answers `403 insufficient_scope` (it is not in the
 * external-surface capability table) and even a correct production path
 * answers `401 authentication_required` (the request carries no credential).
 * Authentication and route-scope classification have their own tests, which
 * supply real credentials — `runtime/__tests__/runtime-auth-boundary.test.ts`
 * and `runtime/__tests__/pairing-scope-enforcement.test.ts` among them. This
 * harness is for the error boundary, and adding security here would only
 * mean every caller asserting refusals instead of route behaviour.
 */

import { Hono } from 'hono';
import { configureRuntimeHttp } from '../runtime/bootstrap/runtime-http.js';
import { EventBus } from '../services/orchestration/event-bus.js';
import type { Logger } from '../utils/logger.js';

/** Writes nothing: a route test asserts on responses, not on log noise. */
export function createSilentTestLogger(): Logger {
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
    setLevel() {},
    getLevel() {
      return 'info' as const;
    },
  };
  return logger as unknown as Logger;
}

export interface RouteTestAppOptions {
  /**
   * Pass a capturing logger to assert what the boundary recorded — a 4xx
   * logs `warn`, a 5xx logs `error` with the sanitized cause.
   */
  logger?: Logger;
}

export function createRouteTestApp(options: RouteTestAppOptions = {}): Hono {
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: options.logger ?? createSilentTestLogger(),
    eventBus: new EventBus(),
  });
  return app;
}
