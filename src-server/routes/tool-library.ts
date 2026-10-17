import { randomUUID } from 'node:crypto';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type {
  OwnAccessView,
  ProjectAgentDraft,
  ToolLibrarySource,
  ToolLibraryView,
} from '@kontourai/station-contracts/tool-library';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import {
  ToolLibraryRefusal,
  type ToolLibraryService,
} from '../services/plugins/tool-library-service.js';
import { ProjectMembershipRefusal } from '../services/projects/project-membership-store.js';
import { guardProjectResponse } from '../services/projects/project-response-guard.js';
import { createLogger } from '../utils/logger.js';
import { errorMessage } from './schemas/schema-validation.js';

export interface ToolLibraryActor {
  access: OwnAccessView;
  project?: { id: string; slug: string; name: string };
  canManageAgents: boolean;
  canManagePolicy: boolean;
}
export interface ToolLibraryRouteDeps {
  service: ToolLibraryService;
  actor(c: Context, projectSlug?: string): Promise<ToolLibraryActor>;
  revalidate?(c: Context, actor: ToolLibraryActor): Promise<ToolLibraryActor>;
  withinProject<T>(
    c: Context,
    actor: ToolLibraryActor,
    operation: () => Promise<T>,
  ): Promise<T>;
  sources(): Promise<ToolLibrarySource[]>;
  discover?(
    actor: ToolLibraryActor,
    source: ToolLibrarySource,
  ): Promise<ToolLibrarySource>;
  engines?(): Promise<Array<{ id: string; name: string; engineId?: string }>>;
  install(c: Context, source: ToolLibrarySource): Promise<void>;
  listAgents(): Promise<Array<{ slug: string; project?: string }>>;
  getAgent(slug: string): Promise<AgentSpec>;
  saveAgent(
    slug: string | undefined,
    draft: ProjectAgentDraft,
    project: { id: string; slug: string },
    authorize: () => Promise<void>,
  ): Promise<string>;
  changed(): Promise<void>;
  account?(
    c: Context,
    actor: ToolLibraryActor,
    sourceId: string,
    action: 'status' | 'authorize' | 'callback',
    callbackUrl?: string,
  ): Promise<unknown>;
}
const id = z.string().min(1).max(512);
const intent = z.object({ expectedActor: id, projectId: id });
const toolRules = z
  .object({
    mcpServers: z.array(id).max(100),
    available: z.array(id).max(1000).optional(),
    autoApprove: z.array(id).max(1000).optional(),
    askBeforeUse: z.array(id).max(1000).optional(),
  })
  .strict();
const draftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    prompt: z.string().max(50000),
    engineId: id,
    tools: toolRules,
  })
  .strict();

export function createToolLibraryRoutes(deps: ToolLibraryRouteDeps) {
  const app = new Hono();
  const installing = new Set<string>();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.onError((error, c) => {
    if (
      error instanceof ToolLibraryRefusal ||
      error instanceof ProjectMembershipRefusal
    )
      return c.json(
        {
          success: false,
          error: errorMessage(error),
          code: `tool_library_${error.code}`,
        },
        error.code === 'forbidden'
          ? 403
          : error.code === 'conflict'
            ? 409
            : 503,
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ success: false, error: 'Invalid tool request.' }, 400);
    createLogger({ name: 'tool-library' }).error('Tool request failed', {
      error,
      cause: error.cause,
    });
    return c.json(
      { success: false, error: 'Tool access is unavailable.' },
      503,
    );
  });
  async function body(c: Context) {
    const value = await c.req.text();
    if (value.length > 100000)
      throw new ToolLibraryRefusal('conflict', 'Request is too large.');
    return JSON.parse(value) as unknown;
  }
  const projectSlug = (c: Context) => c.req.query('project') || undefined;
  async function current(c: Context, actor: ToolLibraryActor) {
    const fresh = deps.revalidate
      ? await deps.revalidate(c, actor)
      : await deps.actor(c, actor.project?.slug);
    if (
      fresh.access.principalId !== actor.access.principalId ||
      fresh.project?.id !== actor.project?.id
    )
      throw new ToolLibraryRefusal(
        'conflict',
        'Your access changed. Reopen this view.',
      );
    return fresh;
  }
  async function operator(c: Context, actor: ToolLibraryActor) {
    if (!(await current(c, actor)).access.station.canInstallTools)
      throw new ToolLibraryRefusal(
        'forbidden',
        'Only a Station operator can add tool sources.',
      );
  }
  async function response(
    c: Context,
    actor: ToolLibraryActor,
    data: unknown,
    admin = false,
  ) {
    return guardProjectResponse(
      c.json({ success: true, data, principalId: actor.access.principalId }),
      async () => {
        try {
          const fresh = await current(c, actor);
          return !admin || fresh.canManageAgents;
        } catch {
          return false;
        }
      },
    );
  }
  app.get('/access', async (c) => {
    const actor = await deps.actor(c);
    return response(c, actor, actor.access);
  });
  app.get('/catalog', async (c) => {
    const actor = await deps.actor(c, projectSlug(c));
    const all = await deps.sources();
    const snapshot = deps.service.view(actor.project?.id);
    const requests = snapshot.requests;
    const sources = all
      .filter(
        (source) =>
          actor.access.station.operator ||
          (!source.operatorOnly && snapshot.shared[source.id] !== false),
      )
      .map((source) => ({
        ...source,
        sharedWithProjects:
          source.id !== 'station-control' &&
          snapshot.shared[source.id] !== false,
        permitted: actor.project
          ? source.id !== 'station-control' &&
            snapshot.shared[source.id] !== false &&
            deps.service.allows(actor.project.id, source.id)
          : actor.access.station.operator,
        request: requests
          .filter(
            (row) =>
              row.projectId === actor.project?.id &&
              row.sourceId === source.id &&
              row.sourceKind === source.kind,
          )
          .slice(-1)
          .map((row) => ({ id: row.id, status: row.status }))[0],
      }));
    const view: ToolLibraryView = {
      engines: await deps.engines?.(),
      sources,
      operator: actor.access.station.operator,
      canManageAgents: actor.canManageAgents,
      canManagePolicy: actor.canManagePolicy,
      project: actor.project,
      policy: snapshot.policy,
    };
    return response(c, actor, view);
  });
  app.get('/accounts/:id', async (c) => {
    const actor = await deps.actor(c, projectSlug(c));
    const source = (await deps.sources()).find(
      (row) => row.id === c.req.param('id') && row.kind === 'integration',
    );
    if (
      !source?.personalAccount ||
      !source.installed ||
      source.operatorOnly ||
      !actor.project ||
      !deps.service.allows(actor.project.id, source.id)
    )
      throw new ToolLibraryRefusal(
        'forbidden',
        'This account source is unavailable.',
      );
    return response(
      c,
      actor,
      await deps.account?.(c, actor, source.id, 'status'),
    );
  });
  app.post('/accounts/:id/:action', async (c) => {
    const data = intent
      .extend({ project: id, callbackUrl: z.string().max(8192).optional() })
      .strict()
      .parse(await body(c));
    const actor = await deps.actor(c, data.project);
    if (
      !actor.project ||
      actor.project.id !== data.projectId ||
      actor.access.principalId !== data.expectedActor ||
      !actor.canManageAgents
    )
      throw new ToolLibraryRefusal(
        'forbidden',
        'Project admin access is required.',
      );
    const source = (await deps.sources()).find(
      (row) => row.id === c.req.param('id') && row.kind === 'integration',
    );
    if (
      !source?.personalAccount ||
      !deps.service.allows(actor.project.id, source.id)
    )
      throw new ToolLibraryRefusal(
        'forbidden',
        'This account source is unavailable.',
      );
    const action = c.req.param('action');
    if (action !== 'authorize' && action !== 'callback')
      throw new ToolLibraryRefusal('conflict', 'Unknown account action.');
    const result = await deps.withinProject(c, actor, () =>
      deps.account!(c, actor, source.id, action, data.callbackUrl),
    );
    return response(c, actor, result);
  });
  app.post('/sources/:id/discover', async (c) => {
    const data = z
      .object({
        expectedActor: id,
        project: id.optional(),
        projectId: id.optional(),
      })
      .strict()
      .parse(await body(c));
    const actor = await deps.actor(c, data.project);
    if (
      actor.access.principalId !== data.expectedActor ||
      actor.project?.id !== data.projectId ||
      !actor.canManageAgents
    )
      throw new ToolLibraryRefusal('forbidden', 'Project access changed.');
    const source = (await deps.sources()).find(
      (row) => row.id === c.req.param('id') && row.kind === 'integration',
    );
    if (
      !source?.installed ||
      (!actor.access.station.operator &&
        (!actor.project || !deps.service.allows(actor.project.id, source.id)))
    )
      throw new ToolLibraryRefusal('forbidden', 'This source is unavailable.');
    if (!deps.discover)
      throw new ToolLibraryRefusal('unavailable', 'Discovery is unavailable.');
    const discovered = await deps.discover(actor, source);
    return response(c, actor, discovered);
  });
  app.post('/add', async (c) => {
    const data = z
      .object({
        id,
        kind: z.enum(['integration', 'plugin']),
        expectedActor: id,
      })
      .strict()
      .parse(await body(c));
    const actor = await deps.actor(c);
    if (data.expectedActor !== actor.access.principalId)
      throw new ToolLibraryRefusal('conflict', 'Your account changed.');
    await operator(c, actor);
    const source = (await deps.sources()).find(
      (row) => row.id === data.id && row.kind === data.kind,
    );
    if (!source)
      throw new ToolLibraryRefusal(
        'conflict',
        'This source is no longer available.',
      );
    await deps.install(c, source);
    return c.json({ success: true, data: { id: source.id } });
  });
  app.post('/requests', async (c) => {
    const data = intent
      .extend({
        sourceId: id,
        kind: z.enum(['integration', 'plugin']),
        project: id,
      })
      .strict()
      .parse(await body(c));
    const actor = await deps.actor(c, data.project);
    if (
      !actor.project ||
      actor.project.id !== data.projectId ||
      actor.access.principalId !== data.expectedActor ||
      !actor.canManageAgents
    )
      throw new ToolLibraryRefusal(
        'forbidden',
        'Project admin access is required.',
      );
    const source = (await deps.sources()).find(
      (row) => row.id === data.sourceId && row.kind === data.kind,
    );
    if (
      !source ||
      source.operatorOnly ||
      !deps.service.allows(actor.project.id, source.id)
    )
      throw new ToolLibraryRefusal(
        'forbidden',
        'This source is not available to Projects.',
      );
    const request = await deps.withinProject(c, actor, () =>
      deps.service.request(
        {
          projectId: actor.project!.id,
          projectSlug: actor.project!.slug,
          projectName: actor.project!.name,
          requesterId: actor.access.principalId,
          requesterName: actor.access.name,
          sourceId: source.id,
          sourceKind: source.kind,
          sourceName: source.name,
          registryId: source.origin?.registryId,
        },
        async () => {
          if (!(await current(c, actor)).canManageAgents)
            throw new ToolLibraryRefusal(
              'forbidden',
              'Project access changed.',
            );
        },
      ),
    );
    return response(c, actor, request);
  });
  app.get('/requests', async (c) => {
    const actor = await deps.actor(c, projectSlug(c));
    if (!actor.access.station.operator && !actor.project)
      throw new ToolLibraryRefusal('forbidden', 'Choose a Project.');
    const requests = deps.service
      .requests()
      .filter(
        (row) =>
          actor.access.station.operator || row.projectId === actor.project?.id,
      );
    return response(c, actor, requests);
  });
  app.post('/requests/:id/:action', async (c) => {
    const data = z
      .object({ expectedActor: id })
      .strict()
      .parse(await body(c));
    const actor = await deps.actor(c);
    if (actor.access.principalId !== data.expectedActor)
      throw new ToolLibraryRefusal('conflict', 'Your account changed.');
    await operator(c, actor);
    const request = deps.service
      .requests()
      .find((row) => row.id === c.req.param('id'));
    if (!request)
      throw new ToolLibraryRefusal('conflict', 'This request is unavailable.');
    const action = c.req.param('action');
    if (action === 'decline')
      return c.json({
        success: true,
        data: await deps.service.transition(request.id, 'declined', () =>
          operator(c, actor),
        ),
      });
    const projectActor = await deps.actor(c, request.projectSlug);
    if (projectActor.project?.id !== request.projectId)
      throw new ToolLibraryRefusal(
        'conflict',
        'The requesting Project no longer exists.',
      );
    const authorize = () => operator(c, projectActor);
    const source = (await deps.sources()).find(
      (row) => row.id === request.sourceId && row.kind === request.sourceKind,
    );
    if (!source || source.origin?.registryId !== request.registryId)
      throw new ToolLibraryRefusal(
        'conflict',
        'The requested catalog source changed.',
      );
    if (!['approve', 'complete'].includes(action))
      throw new ToolLibraryRefusal('conflict', 'Unknown request action.');
    if (!deps.service.allows(request.projectId, source.id))
      throw new ToolLibraryRefusal(
        'forbidden',
        'The Project owner must allow this source first.',
      );
    if (installing.has(request.id))
      throw new ToolLibraryRefusal('conflict', 'Setup is already in progress.');
    if (
      action === 'approve' ||
      (request.status === 'setting-up' && !source.installed)
    ) {
      installing.add(request.id);
      try {
        if (request.status !== 'setting-up')
          await deps.service.transition(request.id, 'setting-up', authorize);
        if (
          source.kind === 'integration' &&
          (!source.installed || !source.enabled)
        )
          await deps.install(c, source);
      } catch (error) {
        await deps.service.transition(
          request.id,
          'failed',
          authorize,
          'Setup did not finish. Review the source and try again.',
        );
        throw error;
      } finally {
        installing.delete(request.id);
      }
    }
    const installed = (await deps.sources()).find(
      (row) => row.id === request.sourceId && row.kind === request.sourceKind,
    );
    if (!installed?.installed || !installed.enabled)
      return c.json({
        success: true,
        data: deps.service.requests().find((row) => row.id === request.id),
      });
    await current(c, projectActor);
    const completed = await deps.withinProject(c, projectActor, () =>
      deps.service.admitRequest(request.id, installed, authorize),
    );
    await deps.changed();
    return c.json({ success: true, data: completed });
  });
  app.put('/projects/:slug/policy', async (c) => {
    const data = intent
      .extend({
        mode: z.enum(['all', 'selected']),
        sources: z.array(id).max(200),
        revision: z.number().int().positive(),
      })
      .strict()
      .parse(await body(c));
    const actor = await deps.actor(c, c.req.param('slug'));
    if (
      !actor.project ||
      actor.project.id !== data.projectId ||
      actor.access.principalId !== data.expectedActor ||
      !actor.canManagePolicy
    )
      throw new ToolLibraryRefusal(
        'forbidden',
        'Project owner access is required.',
      );
    const pluginServers = Object.fromEntries(
      (await deps.sources())
        .filter((source) => source.kind === 'plugin' && source.installed)
        .map((source) => [source.id, source.serverIds ?? []]),
    );
    const policy = await deps.withinProject(c, actor, () =>
      deps.service.setPolicy(
        actor.project!.id,
        { mode: data.mode, sources: data.sources },
        data.revision,
        async () => {
          if (!(await current(c, actor)).canManagePolicy)
            throw new ToolLibraryRefusal(
              'forbidden',
              'Project access changed.',
            );
        },
        pluginServers,
      ),
    );
    await deps.changed();
    return response(c, actor, policy);
  });
  app.put('/sources/:id/sharing', async (c) => {
    const data = z
      .object({ shared: z.boolean(), expectedActor: id })
      .strict()
      .parse(await body(c));
    const actor = await deps.actor(c);
    if (data.expectedActor !== actor.access.principalId)
      throw new ToolLibraryRefusal('conflict', 'Your account changed.');
    const plugins = Object.fromEntries(
      (await deps.sources())
        .filter((source) => source.kind === 'plugin' && source.installed)
        .map((source) => [source.id, source.serverIds ?? []]),
    );
    await deps.service.setShared(
      c.req.param('id'),
      data.shared,
      () => operator(c, actor),
      plugins,
    );
    await deps.changed();
    return c.json({ success: true });
  });
  app.get('/projects/:slug/agents', async (c) => {
    const actor = await deps.actor(c, c.req.param('slug'));
    if (!actor.project || !actor.canManageAgents)
      throw new ToolLibraryRefusal(
        'forbidden',
        'Project admin access is required.',
      );
    const bindings = deps.service.view(actor.project.id).agents;
    const agents = await Promise.all(
      (await deps.listAgents())
        .filter(
          (row) =>
            row.project === actor.project!.slug &&
            bindings[row.slug]?.projectId === actor.project!.id,
        )
        .map(async (row) => ({
          slug: row.slug,
          projectId: actor.project!.id,
          spec: await deps.getAgent(row.slug).then((spec) => ({
            name: spec.name,
            prompt: spec.prompt,
            description: spec.description,
            project: actor.project!.slug,
            tools: {
              mcpServers: spec.tools?.mcpServers ?? [],
              available: spec.tools?.available,
              autoApprove: spec.tools?.autoApprove,
              askBeforeUse: spec.tools?.askBeforeUse,
              mcpMode: 'replace' as const,
            },
            execution: {
              agentConnectionId: spec.execution?.agentConnectionId,
            },
          })),
        })),
    );
    return response(c, actor, agents, true);
  });
  app.post('/projects/:slug/agents', async (c) => save(c));
  app.put('/projects/:slug/agents/:agent', async (c) => save(c));
  async function save(c: Context) {
    const data = intent
      .extend({ draft: draftSchema })
      .strict()
      .parse(await body(c));
    const actor = await deps.actor(c, c.req.param('slug'));
    if (
      !actor.project ||
      actor.project.id !== data.projectId ||
      actor.access.principalId !== data.expectedActor ||
      !actor.canManageAgents
    )
      throw new ToolLibraryRefusal(
        'forbidden',
        'Project admin access is required.',
      );
    const slug = c.req.param('agent');
    if (slug && deps.service.agentBinding(slug)?.projectId !== actor.project.id)
      throw new ToolLibraryRefusal(
        'forbidden',
        'This Agent is not editable in this Project.',
      );
    const sources = data.draft.tools.mcpServers.length
      ? await deps.sources()
      : [];
    for (const sourceId of data.draft.tools.mcpServers) {
      const source = sources.find(
        (row) => row.id === sourceId && row.kind === 'integration',
      );
      if (
        !source?.installed ||
        !source.enabled ||
        !deps.service.allows(actor.project.id, sourceId)
      )
        throw new ToolLibraryRefusal(
          'forbidden',
          `This Project cannot use ${sourceId}.`,
        );
    }
    const authorize = async () => {
      if (!(await current(c, actor)).canManageAgents)
        throw new ToolLibraryRefusal('forbidden', 'Project access changed.');
    };
    const saved = await deps.withinProject(c, actor, async () => {
      await authorize();
      const reservedSlug = slug ?? `project-agent-${randomUUID()}`;
      await deps.service.bindAgent(
        reservedSlug,
        actor.project!.id,
        actor.project!.slug,
        authorize,
      );
      const saved = await deps.saveAgent(
        reservedSlug,
        data.draft,
        actor.project!,
        authorize,
      );
      return saved;
    });
    return response(c, actor, { slug: saved });
  }
  return app;
}
