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
import {
  BROWSER_SESSION_ID_PATTERN as SESSION_ID,
  BROWSER_THREAD_ID_PATTERN as THREAD_ID,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import type {
  BrowserOperatorAuthorizer,
  BrowserProjectAuthorizer,
} from '../services/browser/browser-access.js';
import type { BrowserViewport } from '../services/browser/browser-host.js';
import {
  LocalTargetError,
  type LocalTargetStore,
} from '../services/browser/browser-local-targets.js';
import type { BrowserProjectSettingsStore } from '../services/browser/browser-project-settings.js';
import {
  actorOwnsSessionProfile,
  BrowserSessionError,
  type BrowserSessionRegistry,
  browserProfileFor,
  isValidBrowserProjectId,
  isValidBrowserViewport,
} from '../services/browser/browser-session-registry.js';
import { CdpProtocolError } from '../services/browser/cdp-pipe-transport.js';
import {
  type ChromiumAcquisition,
  ChromiumConsentRequiredError,
} from '../services/browser/chromium-acquisition.js';
import {
  BrowserHostExitedError,
  BrowserHostPolicyError,
} from '../services/browser/hosts/chromium-server-host.js';
import type { LocalTargetSuggestions } from '../services/browser/local-port-scanner.js';
import {
  isStationSelfUrl,
  localInterfaceAddresses,
  type StationListeners,
} from '../services/browser/station-listeners.js';
import { normalizeBrowserUrl } from '../services/browser/url-policy.js';

const MAX_BODY_BYTES = 16 * 1024;
const TARGET_ID = /^lt_[0-9a-f-]{36}$/;

/** A Project as the routes see it: canonical ID plus its current slug. */
export interface BrowserRouteProject {
  id: string;
  slug: string;
  workspaceRoot?: string;
}

export interface BrowserRoutesDeps {
  registry: Pick<
    BrowserSessionRegistry,
    | 'createSession'
    | 'getSession'
    | 'listSessions'
    | 'navigate'
    | 'closeSession'
    | 'reopenSession'
    | 'navigateHistory'
    | 'setViewport'
    | 'getSessionSummary'
  >;
  /**
   * The live-surface id of a live session (its screencast), when live
   * surfaces are wired. Session responses carry it as `surfaceId`.
   */
  surfaceIdFor?(browserSessionId: string): string | undefined;
  acquisition: Pick<ChromiumAcquisition, 'status' | 'startDownload'>;
  localTargets: Pick<LocalTargetStore, 'list' | 'add' | 'remove'>;
  /** Per-Project browser permissions (D4). Absent: the routes are not served. */
  projectSettings?: Pick<
    BrowserProjectSettingsStore,
    'get' | 'setBrowserEvaluate'
  >;
  /**
   * Whether a request may be an agent's rather than a person's (Station's
   * internal principal, an agent-tool marker, a delegation device). Such a
   * request may never change a permission that constrains agents.
   */
  isAgentRequest?(request: Request): boolean;
  /**
   * Station's own internal principal (review S4). The pane's routes are for
   * people: an agent holding the internal token would otherwise stand as
   * the operator and drive sessions with no lease and no D5. Agents use the
   * browser tools (`/api/browser-agent`) instead.
   */
  isStationInternalRequest(request: Request): boolean;
  listeners(): StationListeners;
  suggestLocalTargets(
    project: BrowserRouteProject,
  ): Promise<LocalTargetSuggestions>;
  authorizeProject: BrowserProjectAuthorizer;
  authorizeOperator: BrowserOperatorAuthorizer;
  /** Slug to canonical Project; undefined when there is no such Project. */
  resolveProject(slug: string): BrowserRouteProject | undefined;
  isRequestPrincipalCurrent(request: Request): boolean;
  /** Test seam: the server clock stamped on session views as `serverNow`. */
  now?(): Date;
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
    case 'invalid-actor':
      return 400;
    case 'not-found':
      return 404;
    case 'not-live':
    case 'stale-generation':
    case 'no-history-entry':
      return 409;
    case 'stopped':
      return 503;
  }
}

const HISTORY_ACTIONS = new Set(['back', 'forward', 'reload']);

export function createBrowserRoutes(deps: BrowserRoutesDeps) {
  const app = new Hono();
  /** A session as the pane sees it: the record plus its live surface id. */
  const present = <T extends { browserSessionId: string; state: string }>(
    session: T,
  ): T & { surfaceId?: string; serverNow: string } => {
    const surfaceId =
      session.state === 'live'
        ? deps.surfaceIdFor?.(session.browserSessionId)
        : undefined;
    // The server's clock at sending: clients age `activity.lastAgentInputAt`
    // against this, never against their own clock (skew).
    const serverNow = (deps.now?.() ?? new Date()).toISOString();
    return surfaceId
      ? { ...session, surfaceId, serverNow }
      : { ...session, serverNow };
  };
  const generationOf = (body: JsonObject): number | undefined | null =>
    body.generation === undefined
      ? undefined
      : typeof body.generation === 'number' && Number.isInteger(body.generation)
        ? body.generation
        : null;
  const denied = { success: false, code: 'access-denied' } as const;
  const invalid = { success: false, code: 'invalid-request' } as const;

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (deps.isStationInternalRequest(c.req.raw)) return c.json(denied, 403);
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
    if (error instanceof LocalTargetError) {
      return c.json(
        { success: false, code: error.code },
        error.code === 'not-found'
          ? 404
          : error.code === 'duplicate'
            ? 409
            : 400,
      );
    }
    // A browser that is set up but died or failed to start is a different
    // fact from one that is not set up (409 `browser-unavailable`).
    if (error instanceof BrowserHostExitedError) {
      return c.json({ success: false, code: 'browser-host-failed' }, 503);
    }
    // The host's own policy refused the command (e.g. Back onto an entry
    // whose URL is outside the pane's scope).
    if (error instanceof BrowserHostPolicyError) {
      return error.code === 'url-not-allowed'
        ? c.json({ success: false, code: 'url-not-allowed' }, 409)
        : c.json({ success: false, code: 'browser-refused' }, 403);
    }
    // The browser answered the command with a protocol error.
    if (error instanceof CdpProtocolError) {
      return c.json({ success: false, code: 'browser-error' }, 502);
    }
    throw error;
  });

  app.get('/acquisition', async (c) => {
    if (!(await deps.authorizeOperator(c.req.raw))) return c.json(denied, 403);
    return c.json({ success: true, data: deps.acquisition.status() });
  });

  app.post('/acquisition/download', async (c) => {
    // Authorization first: a non-operator learns nothing about the body.
    if (!(await deps.authorizeOperator(c.req.raw))) return c.json(denied, 403);
    const body = await readJsonObject(c.req.raw, ['consent']);
    // Consent is the literal `true`; nothing else starts a download.
    if (body?.consent !== true)
      return c.json({ success: false, code: 'consent-required' }, 400);
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
    const slug = c.req.query('projectSlug');
    let projectFilter: string | undefined;
    if (slug !== undefined) {
      const project = isValidBrowserProjectId(slug)
        ? deps.resolveProject(slug)
        : undefined;
      if (!project) return c.json(invalid, 400);
      projectFilter = project.id;
    }
    const all = deps.registry.listSessions(
      projectFilter === undefined
        ? undefined
        : (record) => record.projectId === projectFilter,
    );
    // D6: every session stays discoverable — to those allowed to see it.
    // D7: a Project admin sees only sessions in their own profile.
    const actors = new Map<
      string,
      Awaited<ReturnType<BrowserProjectAuthorizer>>
    >();
    for (const projectId of new Set(all.map((s) => s.projectId))) {
      actors.set(
        projectId,
        await deps.authorizeProject(c.req.raw, projectId, 'view'),
      );
    }
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({
      success: true,
      data: all
        .filter((session) => {
          const actor = actors.get(session.projectId);
          return actor !== undefined && actorOwnsSessionProfile(session, actor);
        })
        .map(present),
    });
  });

  app.post('/sessions', async (c) => {
    const body = await readJsonObject(c.req.raw, [
      'projectSlug',
      'threadId',
      'url',
      'viewport',
      'reuse',
    ]);
    if (
      !body ||
      (body.reuse !== undefined && typeof body.reuse !== 'boolean') ||
      !isValidBrowserProjectId(body.projectSlug) ||
      typeof body.url !== 'string' ||
      (body.threadId !== undefined &&
        (typeof body.threadId !== 'string' ||
          !THREAD_ID.test(body.threadId))) ||
      (body.viewport !== undefined && !isValidBrowserViewport(body.viewport))
    )
      return c.json(invalid, 400);
    const project = deps.resolveProject(body.projectSlug);
    const actor = project
      ? await deps.authorizeProject(c.req.raw, project.id, 'drive')
      : undefined;
    // An unknown Project and a refused one look the same to the caller.
    if (!project || !actor) return c.json(denied, 403);
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
    if (body.reuse === true) {
      // Restore rather than duplicate: the caller's OWN open session in this
      // Project whose URL is exactly this one (the v1 pane migration). The
      // server matches, so nobody else's session and no redacted look-alike
      // can be picked.
      const principalKey = browserProfileFor(project.id, actor)?.principalKey;
      const wanted = normalizeBrowserUrl(body.url);
      const existing = wanted.ok
        ? deps.registry
            .listSessions(
              (record) =>
                record.projectId === project.id &&
                record.principalKey === principalKey &&
                record.state !== 'closed' &&
                record.url === wanted.url,
            )
            .at(0)
        : undefined;
      const reused = existing
        ? deps.registry.getSession(existing.browserSessionId)
        : undefined;
      if (reused) return c.json({ success: true, data: present(reused) }, 200);
    }
    const session = await deps.registry.createSession({
      projectId: project.id,
      projectSlug: project.slug,
      url: body.url,
      actor,
      ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
      ...(body.viewport ? { viewport: body.viewport as BrowserViewport } : {}),
    });
    return c.json({ success: true, data: present(session) }, 201);
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
    if (!actor || !actorOwnsSessionProfile(session, actor))
      return { status: 403 as const };
    return { status: 200 as const, session, actor };
  };

  const refuse = (status: 400 | 403 | 404) =>
    status === 400
      ? invalid
      : status === 403
        ? denied
        : { success: false, code: 'not-found' };

  // `?view=summary` is what a pane polls (the latest few actions); the full
  // history is read on demand without it.
  app.get('/sessions/:browserSessionId', async (c) => {
    const view = c.req.query('view');
    if (view !== undefined && view !== 'summary') return c.json(invalid, 400);
    const found = await sessionFor(
      c.req.raw,
      c.req.param('browserSessionId'),
      'view',
    );
    if (found.status !== 200) return c.json(refuse(found.status), found.status);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    const data =
      view === 'summary'
        ? deps.registry.getSessionSummary(found.session.browserSessionId)
        : found.session;
    if (!data) return c.json({ success: false, code: 'not-found' }, 404);
    return c.json({ success: true, data: present(data) });
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
    // A navigation Station itself refused (one of its own listeners) is
    // said as Station's refusal, not as a generic load failure — to the
    // operator only. Telling a Project admin which addresses are Station's
    // would let them enumerate this host's LAN/tailnet interfaces.
    const blockedByStation =
      found.actor.kind === 'operator' &&
      result.errorText !== undefined &&
      isStationSelfUrl(
        result.session.url,
        deps.listeners(),
        localInterfaceAddresses(),
      );
    return c.json({
      success: true,
      data: {
        ...result,
        session: present(result.session),
        ...(blockedByStation ? { blocked: 'station-listener' } : {}),
      },
    });
  });

  app.post('/sessions/:browserSessionId/history', async (c) => {
    const body = await readJsonObject(c.req.raw, ['action', 'generation']);
    const generation = body ? generationOf(body) : null;
    if (
      !body ||
      typeof body.action !== 'string' ||
      !HISTORY_ACTIONS.has(body.action) ||
      generation === null
    )
      return c.json(invalid, 400);
    const found = await sessionFor(
      c.req.raw,
      c.req.param('browserSessionId'),
      'drive',
    );
    if (found.status !== 200) return c.json(refuse(found.status), found.status);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    const session = await deps.registry.navigateHistory(
      found.session.browserSessionId,
      body.action as 'back' | 'forward' | 'reload',
      {
        actor: found.actor,
        ...(generation !== undefined ? { generation } : {}),
      },
    );
    return c.json({ success: true, data: present(session) });
  });

  app.post('/sessions/:browserSessionId/viewport', async (c) => {
    const body = await readJsonObject(c.req.raw, ['viewport', 'generation']);
    const generation = body ? generationOf(body) : null;
    if (!body || !isValidBrowserViewport(body.viewport) || generation === null)
      return c.json(invalid, 400);
    const found = await sessionFor(
      c.req.raw,
      c.req.param('browserSessionId'),
      'drive',
    );
    if (found.status !== 200) return c.json(refuse(found.status), found.status);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    const session = await deps.registry.setViewport(
      found.session.browserSessionId,
      body.viewport as BrowserViewport,
      {
        actor: found.actor,
        ...(generation !== undefined ? { generation } : {}),
      },
    );
    return c.json({ success: true, data: present(session) });
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
    return c.json({ success: true, data: present(session) });
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

  // --- Registered local targets (D7) -------------------------------------
  //
  // Registering a target lets every Project admin's browser reach that one
  // local port. Reach is TRANSITIVE: if the service behind the port proxies
  // (a dev server's API proxy, a Station dev UI, nginx), the admin reaches
  // whatever it reaches. Suggestions carry `warnings` (`station-process`,
  // `may-proxy`), the owning pid, command line and cwd so the operator sees
  // what they would share; they are never pre-selected and never registered
  // automatically. Station's own listener ports can never be registered.
  const projectFor = async (
    request: Request,
    slug: string,
    need: 'view' | 'operator',
  ) => {
    const project = isValidBrowserProjectId(slug)
      ? deps.resolveProject(slug)
      : undefined;
    if (!project) return undefined;
    const allowed =
      need === 'operator'
        ? await deps.authorizeOperator(request)
        : (await deps.authorizeProject(request, project.id, 'view')) !==
          undefined;
    return allowed ? project : undefined;
  };

  /**
   * The caller's standing for one Project's browser (the pane's first read):
   * who they are to it, whether they are the operator, and whether a browser
   * is ready to launch. A caller with no standing is refused (403), which the
   * pane shows as "not available to you".
   */
  app.get('/projects/:projectSlug/access', async (c) => {
    const slug = c.req.param('projectSlug');
    const project = isValidBrowserProjectId(slug)
      ? deps.resolveProject(slug)
      : undefined;
    const actor = project
      ? await deps.authorizeProject(c.req.raw, project.id, 'view')
      : undefined;
    if (!project || !actor) return c.json(denied, 403);
    const operator = await deps.authorizeOperator(c.req.raw);
    const acquisition = deps.acquisition.status();
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({
      success: true,
      data: {
        projectId: project.id,
        role: actor.kind === 'operator' ? 'operator' : 'project-admin',
        // The profile this caller's sessions run in (D7).
        principalKey: browserProfileFor(project.id, actor)?.principalKey,
        operator,
        browser:
          acquisition.state === 'found-system' ||
          acquisition.state === 'downloaded'
            ? 'ready'
            : 'not-ready',
      },
    });
  });

  // --- Per-Project browser settings (D4) ------------------------------------
  //
  // `browserEvaluate` lets agents run arbitrary JavaScript in this Project's
  // browser pages. Reading needs the same standing as the pane; changing it
  // needs operator or Project-admin standing AND a request that is not
  // plainly an agent's (Station's internal token, an agent-tool marker, a
  // delegation device), so no agent can grant itself the permission through
  // Station's own channels. The boundary is honest about what it is: on a
  // personal host, any same-user process with a shell has home possession
  // (it can read the local-grant secret and mint a local credential), so
  // nothing here tells such a process apart from the operator in person.
  app.get('/projects/:projectSlug/settings', async (c) => {
    if (!deps.projectSettings) return c.json(denied, 403);
    const slug = c.req.param('projectSlug');
    const project = isValidBrowserProjectId(slug)
      ? deps.resolveProject(slug)
      : undefined;
    const actor = project
      ? await deps.authorizeProject(c.req.raw, project.id, 'view')
      : undefined;
    if (!project || !actor) return c.json(denied, 403);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({
      success: true,
      data: deps.projectSettings.get(project.id),
    });
  });

  app.put('/projects/:projectSlug/settings', async (c) => {
    if (!deps.projectSettings || !deps.isAgentRequest)
      return c.json(denied, 403);
    if (deps.isAgentRequest(c.req.raw)) return c.json(denied, 403);
    const slug = c.req.param('projectSlug');
    const project = isValidBrowserProjectId(slug)
      ? deps.resolveProject(slug)
      : undefined;
    const actor = project
      ? await deps.authorizeProject(c.req.raw, project.id, 'drive')
      : undefined;
    if (!project || !actor) return c.json(denied, 403);
    const body = await readJsonObject(c.req.raw, ['browserEvaluate']);
    if (!body || typeof body.browserEvaluate !== 'boolean')
      return c.json(invalid, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({
      success: true,
      data: deps.projectSettings.setBrowserEvaluate(
        project.id,
        body.browserEvaluate,
        actor.kind === 'project-admin'
          ? `principal:${actor.principalId}`
          : 'operator',
      ),
    });
  });

  app.get('/projects/:projectSlug/local-targets', async (c) => {
    const project = await projectFor(
      c.req.raw,
      c.req.param('projectSlug'),
      'view',
    );
    if (!project) return c.json(denied, 403);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({ success: true, data: deps.localTargets.list(project.id) });
  });

  app.post('/projects/:projectSlug/local-targets', async (c) => {
    const project = await projectFor(
      c.req.raw,
      c.req.param('projectSlug'),
      'operator',
    );
    if (!project) return c.json(denied, 403);
    const body = await readJsonObject(c.req.raw, ['host', 'port', 'label']);
    if (!body) return c.json(invalid, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    const target = deps.localTargets.add(
      project.id,
      { host: body.host, port: body.port, label: body.label },
      'operator',
      deps.listeners(),
    );
    return c.json({ success: true, data: target }, 201);
  });

  app.delete('/projects/:projectSlug/local-targets/:targetId', async (c) => {
    const project = await projectFor(
      c.req.raw,
      c.req.param('projectSlug'),
      'operator',
    );
    if (!project) return c.json(denied, 403);
    const targetId = c.req.param('targetId');
    if (!TARGET_ID.test(targetId)) return c.json(invalid, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({
      success: true,
      data: deps.localTargets.remove(project.id, targetId),
    });
  });

  // Suggestions reveal local processes, so they are the operator's alone.
  app.get('/projects/:projectSlug/local-target-suggestions', async (c) => {
    const project = await projectFor(
      c.req.raw,
      c.req.param('projectSlug'),
      'operator',
    );
    if (!project) return c.json(denied, 403);
    const suggestions = await deps.suggestLocalTargets(project);
    if (!deps.isRequestPrincipalCurrent(c.req.raw)) return c.json(denied, 403);
    return c.json({ success: true, data: suggestions });
  });

  return app;
}
