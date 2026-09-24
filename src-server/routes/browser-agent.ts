/**
 * The browser tools' REST side (#90 #122/#123), mounted at
 * `/api/browser-agent` on personal hosts only (the same gate as
 * `/api/browser`).
 *
 * Only Station's own station-control tool code calls this. A request the
 * runtime boundary did not accept as Station's internal principal gets a
 * 404: a paired device or operator credential learns nothing here. Every
 * request re-derives the VERIFIED caller from the credential the tool
 * forwarded (`resolveStationControlCallerForRequest`), then runs the full
 * authority chain (`authorizeBrowserAgentCaller`: bound credential, recorded
 * owner, recorded Project, and D5 standing in that Project). A
 * `browserSessionId` in the body is only a selector (`BrowserAutomation`).
 *
 * Answers are always a typed `{ ok, ... }` envelope the tool hands to the
 * model, refusals included.
 */
import { Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import {
  authorizeBrowserAgentCaller,
  type BrowserPrincipalAuthorizer,
} from '../services/browser/browser-agent-authority.js';
import {
  type BrowserActionTarget,
  type BrowserAutomation,
  capUrl,
} from '../services/browser/browser-automation.js';
import type { BrowserViewport } from '../services/browser/browser-host.js';
import type { BrowserProjectSettingsStore } from '../services/browser/browser-project-settings.js';
import type { BrowserSessionRecord } from '../services/browser/browser-session-registry.js';
import type { StationControlCaller } from '../tools/station-control-shared.js';

const MAX_BODY_BYTES = 40 * 1024;

export interface BrowserAgentRoutesDeps {
  /** True only for Station's own internal principal. */
  isInternalRequest(request: Request): boolean;
  /** The verified station-control caller the request's credential names. */
  resolveCaller(request: Request): StationControlCaller | null;
  authorizePrincipal: BrowserPrincipalAuthorizer;
  automation: Pick<
    BrowserAutomation,
    | 'status'
    | 'open'
    | 'navigate'
    | 'resize'
    | 'snapshot'
    | 'click'
    | 'type'
    | 'press'
    | 'scroll'
    | 'waitFor'
    | 'evaluate'
  >;
  settings: Pick<BrowserProjectSettingsStore, 'evaluateAllowed'>;
  /** Whether a Chromium is set up (found on the system or downloaded). */
  browserReady(): boolean;
  /** The current slug of a Project, by canonical id. */
  projectSlug(projectId: string): string | undefined;
  surfaceIdFor(browserSessionId: string): string | undefined;
}

type Body = Record<string, unknown>;

const invalid = (message: string) => ({
  ok: false,
  code: 'invalid-request',
  message,
});

function sessionView(
  session: BrowserSessionRecord,
  surfaceIdFor: (id: string) => string | undefined,
) {
  const surfaceId =
    session.state === 'live'
      ? surfaceIdFor(session.browserSessionId)
      : undefined;
  return {
    browserSessionId: session.browserSessionId,
    hostId: session.hostId,
    ...(session.threadId ? { threadId: session.threadId } : {}),
    state: session.state,
    url: capUrl(session.url),
    viewport: session.viewport,
    generation: session.generation,
    ...(surfaceId ? { surfaceId } : {}),
  };
}

function targetFrom(value: unknown): BrowserActionTarget | undefined {
  return typeof value === 'object' && value !== null
    ? (value as BrowserActionTarget)
    : undefined;
}

export function createBrowserAgentRoutes(deps: BrowserAgentRoutesDeps) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.isInternalRequest(c.req.raw))
      return c.json({ error: { code: 'not_found' } }, 404);
    await next();
  });

  // A failure nothing mapped still answers in the envelope the tool reads.
  app.onError((_error, c) =>
    c.json({
      ok: false,
      code: 'browser-error',
      message: 'The browser tool failed unexpectedly.',
    }),
  );

  app.post('/:operation', async (c) => {
    const read = await readBoundedRequestBody(c.req.raw, MAX_BODY_BYTES);
    let body: Body;
    try {
      const parsed: unknown =
        read.status === 'ok'
          ? JSON.parse(read.body === '' ? '{}' : read.body)
          : undefined;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return c.json(invalid('The request body is not a JSON object.'));
      body = parsed as Body;
    } catch {
      return c.json(invalid('The request body is not JSON.'));
    }

    const decided = await authorizeBrowserAgentCaller(
      deps.resolveCaller(c.req.raw),
      deps.authorizePrincipal,
    );
    if (!decided.ok) return c.json({ ok: false, ...decided.refusal });
    const authority = decided.authority;
    const automation = deps.automation;
    const id = body.browserSessionId;

    switch (c.req.param('operation')) {
      case 'status':
        return c.json({
          ok: true,
          browser: deps.browserReady() ? 'ready' : 'not-ready',
          evaluateAllowed: deps.settings.evaluateAllowed(authority.projectId),
          sessions: await automation.status(authority),
        });
      case 'open': {
        if (!deps.browserReady())
          return c.json({
            ok: false,
            code: 'browser-unavailable',
            message:
              'No browser is set up on this Station yet. The Station operator can set one up from the Browser pane; ask them.',
          });
        if (body.url !== undefined && typeof body.url !== 'string')
          return c.json(invalid('url must be a string.'));
        const result = await automation.open(authority, {
          ...(typeof body.url === 'string' ? { url: body.url } : {}),
          ...(typeof id === 'string' ? { browserSessionId: id } : {}),
          ...(body.viewport !== undefined
            ? { viewport: body.viewport as BrowserViewport }
            : {}),
          projectSlug:
            deps.projectSlug(authority.projectId) ?? authority.projectId,
        });
        if (!result.ok) return c.json(result);
        return c.json({
          ok: true,
          reused: result.reused,
          // `visible` is accepted but not yet acted on: nothing here can
          // bring a pane forward (the float-over-chat lane owns that). Every
          // session is listed in the Browser pane with its history (D6)
          // either way, so no answer here claims it was shown.
          session: sessionView(result.session, deps.surfaceIdFor),
        });
      }
      case 'navigate': {
        const hasUrl = typeof body.url === 'string';
        const action = body.action;
        if (
          hasUrl === (action !== undefined) ||
          (action !== undefined &&
            action !== 'back' &&
            action !== 'forward' &&
            action !== 'reload')
        )
          return c.json(
            invalid('Give either url or action (back, forward or reload).'),
          );
        return c.json(
          await automation.navigate(
            authority,
            id,
            hasUrl
              ? { url: body.url as string }
              : { action: action as 'back' | 'forward' | 'reload' },
          ),
        );
      }
      case 'resize':
        return c.json(
          await automation.resize(
            authority,
            id,
            body.viewport as BrowserViewport,
          ),
        );
      case 'snapshot':
        return c.json(
          await automation.snapshot(authority, id, {
            screenshot: body.screenshot === true,
          }),
        );
      case 'click': {
        const target = targetFrom(body.target);
        if (!target) return c.json(invalid('Give a target.'));
        return c.json(
          await automation.click(authority, id, target, {
            ...(body.button !== undefined
              ? { button: body.button as 'left' }
              : {}),
            ...(body.clickCount !== undefined
              ? { clickCount: body.clickCount as number }
              : {}),
          }),
        );
      }
      case 'type':
        return c.json(
          await automation.type(authority, id, {
            text: body.text as string,
            ...(targetFrom(body.target)
              ? {
                  target: targetFrom(body.target) as
                    | { ref: string }
                    | { locator: string },
                }
              : {}),
            clear: body.clear === true,
            submit: body.submit === true,
          }),
        );
      case 'press':
        return c.json(
          await automation.press(authority, id, body.key as string),
        );
      case 'scroll':
        return c.json(
          await automation.scroll(authority, id, {
            ...(targetFrom(body.target)
              ? { target: targetFrom(body.target) }
              : {}),
            ...(typeof body.deltaX === 'number' ? { deltaX: body.deltaX } : {}),
            ...(typeof body.deltaY === 'number' ? { deltaY: body.deltaY } : {}),
          }),
        );
      case 'wait-for':
        return c.json(
          await automation.waitFor(authority, id, {
            ...(body.text !== undefined ? { text: body.text as string } : {}),
            ...(body.locator !== undefined
              ? { locator: body.locator as string }
              : {}),
            ...(body.url !== undefined ? { url: body.url as string } : {}),
            ...(typeof body.timeoutMs === 'number'
              ? { timeoutMs: body.timeoutMs }
              : {}),
          }),
        );
      case 'evaluate':
        return c.json(
          await automation.evaluate(authority, id, {
            expression: body.expression as string,
            ...(typeof body.timeoutMs === 'number'
              ? { timeoutMs: body.timeoutMs }
              : {}),
          }),
        );
      default:
        return c.json(invalid('Unknown browser operation.'));
    }
  });

  return app;
}
