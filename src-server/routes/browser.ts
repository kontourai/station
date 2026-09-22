/**
 * Browser pane REST routes (#90 lane C). Mounted ONLY on personal Station
 * hosts (the same gate as `/api/mobile-devices`); hosted deployments never
 * mount them.
 *
 * Every request is re-checked for a current principal, and every operation
 * authorizes that principal for the session's Project (D5): the Station
 * operator or a Project admin. Chromium acquisition is host-level and
 * operator-only. Validation happens here, at the route seam; behaviour lives
 * in the session registry and acquisition services.
 */
import { Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import type {
  BrowserOperatorAuthorizer,
  BrowserProjectAuthorizer,
} from '../services/browser/browser-access.js';
import type { BrowserViewport } from '../services/browser/browser-host.js';
import {
  BrowserSessionError,
  type BrowserSessionRegistry,
  isValidBrowserProjectId,
  isValidBrowserViewport,
} from '../services/browser/browser-session-registry.js';
import {
  type ChromiumAcquisition,
  ChromiumConsentRequiredError,
} from '../services/browser/chromium-acquisition.js';
import { BrowserHostExitedError } from '../services/browser/hosts/chromium-server-host.js';

const MAX_BODY_BYTES = 16 * 1024;
const SESSION_ID = /^bs_[0-9a-f-]{36}$/;
const THREAD_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export interface BrowserRoutesDeps {
  registry: Pick<
    BrowserSessionRegistry,
    | 'createSession'
    | 'getSession'
    | 'listSessions'
    | 'navigate'
    | 'closeSession'
    | 'reopenSession'
  >;
  acquisition: Pick<ChromiumAcquisition, 'status' | 'startDownload'>;
  authorizeProject: BrowserProjectAuthorizer;
  authorizeOperator: BrowserOperatorAuthorizer;
  projectExists(projectId: string): boolean;
  isRequestPrincipalCurrent(request: Request): boolean;
}

type JsonObject = Record<string, unknown>;

async function readJsonObject(
  request: Request,
  allowedKeys: readonly string[],
): Promise<JsonObject | undefined> {
  const body = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (body.status !== 'ok') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.body === '' ? '{}' : body.body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return undefined;
  if (Object.keys(parsed).some((key) => !allowedKeys.includes(key)))
    return undefined;
  return parsed as JsonObject;
}

function sessionErrorStatus(error: BrowserSessionError): 400 | 404 | 409 | 503 {
  switch (error.code) {
    case 'url-not-allowed':
    case 'invalid-project':
    case 'invalid-viewport':
      return 400;
    case 'not-found':
      return 404;
    case 'not-live':
    case 'stale-generation':
      return 409;
    case 'stopped':
      return 503;
  }
}

export function createBrowserRoutes(deps: BrowserRoutesDeps) {
  const app = new Hono();
  const denied = { success: false, code: 'access-denied' } as const;
  const invalid = { success: false, code: 'invalid-request' } as const;

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    await next();
  });

  // Map domain failures to typed responses; anything unknown propagates.
  app.onError((error, c) => {
    if (error instanceof BrowserSessionError) {
      return c.json(
        {
          success: false,
          code: error.code,
          ...(error.detail ? { detail: error.detail } : {}),
        },
        sessionErrorStatus(error),
      );
    }
    if (error instanceof BrowserHostExitedError) {
      return c.json({ success: false, code: 'browser-unavailable' }, 503);
    }
    throw error;
  });

  app.get('/acquisition', async (c) => {
    if (!(await deps.authorizeOperator(c.req.raw))) return c.json(denied, 403);
    return c.json({ success: true, data: deps.acquisition.status() });
  });

  app.post('/acquisition/download', async (c) => {
    const body = await readJsonObject(c.req.raw, ['consent']);
    // Consent is the literal `true`; nothing else starts a download.
    if (!body || body.consent !== true)
      return c.json({ success: false, code: 'consent-required' }, 400);
    if (!(await deps.authorizeOperator(c.req.raw))) return c.json(denied, 403);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    try {
      const { status } = deps.acquisition.startDownload({ consent: true });
      return c.json({ success: true, data: status }, 202);
    } catch (error) {
      if (error instanceof ChromiumConsentRequiredError)
        return c.json({ success: false, code: 'consent-required' }, 400);
      throw error;
    }
  });

  app.get('/sessions', async (c) => {
    const projectFilter = c.req.query('projectId');
    if (projectFilter !== undefined && !isValidBrowserProjectId(projectFilter))
      return c.json(invalid, 400);
    const all = deps.registry.listSessions(
      projectFilter === undefined
        ? undefined
        : (record) => record.projectId === projectFilter,
    );
    // D6: every session stays discoverable — to those allowed to see it.
    const allowed = new Map<string, boolean>();
    for (const projectId of new Set(all.map((s) => s.projectId))) {
      allowed.set(
        projectId,
        (await deps.authorizeProject(c.req.raw, projectId, 'view')) !==
          undefined,
      );
    }
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({
      success: true,
      data: all.filter((session) => allowed.get(session.projectId)),
    });
  });

  app.post('/sessions', async (c) => {
    const body = await readJsonObject(c.req.raw, [
      'projectId',
      'threadId',
      'url',
      'viewport',
    ]);
    if (
      !body ||
      !isValidBrowserProjectId(body.projectId) ||
      typeof body.url !== 'string' ||
      (body.threadId !== undefined &&
        (typeof body.threadId !== 'string' ||
          !THREAD_ID.test(body.threadId))) ||
      (body.viewport !== undefined && !isValidBrowserViewport(body.viewport))
    )
      return c.json(invalid, 400);
    const actor = await deps.authorizeProject(
      c.req.raw,
      body.projectId,
      'drive',
    );
    if (!actor) return c.json(denied, 403);
    if (!deps.projectExists(body.projectId))
      return c.json({ success: false, code: 'project-not-found' }, 404);
    const acquisition = deps.acquisition.status();
    if (
      acquisition.state !== 'found-system' &&
      acquisition.state !== 'downloaded'
    ) {
      return c.json(
        { success: false, code: 'browser-unavailable', acquisition },
        409,
      );
    }
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    const session = await deps.registry.createSession({
      projectId: body.projectId,
      url: body.url,
      actor,
      ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
      ...(body.viewport ? { viewport: body.viewport as BrowserViewport } : {}),
    });
    return c.json({ success: true, data: session }, 201);
  });

  /** Resolve a session and authorize the caller for its Project. */
  const sessionFor = async (
    request: Request,
    id: string,
    purpose: 'view' | 'drive',
  ) => {
    if (!SESSION_ID.test(id)) return { status: 400 as const };
    const session = deps.registry.getSession(id);
    if (!session) return { status: 404 as const };
    const actor = await deps.authorizeProject(
      request,
      session.projectId,
      purpose,
    );
    if (!actor) return { status: 403 as const };
    return { status: 200 as const, session, actor };
  };

  const refuse = (status: 400 | 403 | 404) =>
    status === 400
      ? invalid
      : status === 403
        ? denied
        : { success: false, code: 'not-found' };

  app.get('/sessions/:browserSessionId', async (c) => {
    const found = await sessionFor(
      c.req.raw,
      c.req.param('browserSessionId'),
      'view',
    );
    if (found.status !== 200) return c.json(refuse(found.status), found.status);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({ success: true, data: found.session });
  });

  app.post('/sessions/:browserSessionId/navigate', async (c) => {
    const body = await readJsonObject(c.req.raw, ['url', 'generation']);
    if (
      !body ||
      typeof body.url !== 'string' ||
      (body.generation !== undefined &&
        (typeof body.generation !== 'number' ||
          !Number.isInteger(body.generation)))
    )
      return c.json(invalid, 400);
    const found = await sessionFor(
      c.req.raw,
      c.req.param('browserSessionId'),
      'drive',
    );
    if (found.status !== 200) return c.json(refuse(found.status), found.status);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    const result = await deps.registry.navigate(
      found.session.browserSessionId,
      body.url,
      {
        actor: found.actor,
        ...(typeof body.generation === 'number'
          ? { generation: body.generation }
          : {}),
      },
    );
    return c.json({ success: true, data: result });
  });

  app.post('/sessions/:browserSessionId/reopen', async (c) => {
    const body = await readJsonObject(c.req.raw, []);
    if (!body) return c.json(invalid, 400);
    const found = await sessionFor(
      c.req.raw,
      c.req.param('browserSessionId'),
      'drive',
    );
    if (found.status !== 200) return c.json(refuse(found.status), found.status);
    const acquisition = deps.acquisition.status();
    if (
      acquisition.state !== 'found-system' &&
      acquisition.state !== 'downloaded'
    ) {
      return c.json(
        { success: false, code: 'browser-unavailable', acquisition },
        409,
      );
    }
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    const session = await deps.registry.reopenSession(
      found.session.browserSessionId,
      found.actor,
    );
    return c.json({ success: true, data: session });
  });

  app.delete('/sessions/:browserSessionId', async (c) => {
    const found = await sessionFor(
      c.req.raw,
      c.req.param('browserSessionId'),
      'drive',
    );
    if (found.status !== 200) return c.json(refuse(found.status), found.status);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    const session = await deps.registry.closeSession(
      found.session.browserSessionId,
      found.actor,
    );
    return c.json({ success: true, data: session });
  });

  return app;
}
