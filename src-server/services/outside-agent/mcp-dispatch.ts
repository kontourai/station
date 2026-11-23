// UNWIRED(#4115): release composition remains refused until R6.
import {
  type CallToolResult,
  isCallToolResult,
  ProtocolError,
  Server,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import type { StationControlToolRegistry } from '../../tools/station-control-mcp-server.js';
import {
  stationControlToolListable,
  stationControlToolPolicy,
} from '../../tools/station-control-policy.js';
import { registerProjectReadTools } from '../../tools/station-control-project-read-tools.js';
import { registerActiveWorkTool } from '../../tools/station-control-work-discovery-tools.js';
import type { ProjectService } from '../projects/project-service.js';
import {
  type createOutsideActiveWorkReader,
  MAX_OUTSIDE_ACTIVE_WORK_CURSOR,
} from './active-work.js';
import type { Records } from './oauth-records.js';

export interface OutsideAgentCaller {
  readonly kind: 'outside-agent';
  readonly assurance: 'bearer-exposed';
  readonly grantId: string;
  readonly clientId: string;
  readonly familyId: string;
  readonly grantVersion: number;
  readonly delegatingPrincipalId: string;
  readonly projectScope: Records['grant']['selection']['projectScope'];
}

function outsideAgentCaller(grant: Records['grant']): OutsideAgentCaller {
  return Object.freeze({
    kind: 'outside-agent',
    assurance: 'bearer-exposed',
    grantId: grant.id,
    clientId: grant.clientId,
    familyId: grant.familyId,
    grantVersion: grant.version,
    delegatingPrincipalId: grant.selection.delegatingPrincipalId,
    projectScope: Object.freeze({ ...grant.selection.projectScope }),
  });
}
function unknown(): never {
  throw new ProtocolError(-32602, 'Unknown tool');
}

/** Both the transport dispatch and the read owner re-admit the current grant. No synthetic Session or REST bearer. */
export function createOutsideMcpDispatch(input: {
  current(): Records['grant'];
  projects: Pick<ProjectService, 'listProjects' | 'getProject'>;
  layoutStorage?: Pick<IStorageAdapter, 'projectRevision' | 'listLayouts'>;
  listActiveWork?: ReturnType<typeof createOutsideActiveWorkReader>;
  reserveCall(): () => void;
}) {
  const catalog = new Set(['list_projects', 'get_project']);
  const { layoutStorage, listActiveWork } = input;
  if (layoutStorage) catalog.add('list_project_layouts');
  if (listActiveWork) catalog.add('list_active_work');
  const admitted = (name: string, grant: Records['grant']): boolean => {
    const policy = stationControlToolPolicy(name);
    return (
      catalog.has(name) &&
      grant.selection.accessLevel === 'read-only' &&
      grant.selection.scopes.includes('station-control:read') &&
      !!policy &&
      policy.toolClass === 'read-only' &&
      stationControlToolListable(policy, 'bearer-exposed')
    );
  };
  const tools = new Map<
    string,
    {
      definition: Tool;
      call(args: unknown, ctx: ServerContext): Promise<CallToolResult>;
    }
  >();
  const caller = (name: string) => {
    const grant = input.current();
    if (!admitted(name, grant)) unknown();
    return outsideAgentCaller(grant);
  };
  const registry: Pick<StationControlToolRegistry, 'tool' | 'toolWithSchema'> =
    {
      tool(name, description, shape, callback) {
        const schema = z.object(shape).strict();
        tools.set(name, {
          definition: {
            name,
            description,
            inputSchema: catalog.has(name)
              ? (z.toJSONSchema(schema) as Tool['inputSchema'])
              : { type: 'object' },
            annotations: { readOnlyHint: true },
          },
          call: async (args, ctx) => {
            const parsed = schema.safeParse(args ?? {});
            if (!parsed.success)
              throw new ProtocolError(-32602, 'Invalid tool arguments');
            const result = await callback(parsed.data, ctx);
            if (!isCallToolResult(result))
              throw new Error('Unsupported tool result');
            return result;
          },
        });
      },
      toolWithSchema(name, description, schema, callback) {
        tools.set(name, {
          definition: {
            name,
            description,
            inputSchema: catalog.has(name)
              ? {
                  ...schema['~standard'].jsonSchema.input({
                    target: 'draft-2020-12',
                  }),
                  type: 'object',
                }
              : { type: 'object' },
            annotations: { readOnlyHint: true },
          },
          call: async (args, ctx) => {
            const parsed = await schema['~standard'].validate(args ?? {});
            if (parsed.issues)
              throw new ProtocolError(-32602, 'Invalid tool arguments');
            const result = await callback(parsed.value, ctx);
            if (!isCallToolResult(result))
              throw new Error('Unsupported tool result');
            return result;
          },
        });
      },
    };
  registerProjectReadTools(registry, {
    async list() {
      const approved = caller('list_projects').projectScope;
      if (approved.kind === 'global') return [];
      return input.projects
        .listProjects()
        .filter((p) => p.id === approved.projectId);
    },
    async get(slug) {
      const approved = caller('get_project').projectScope;
      const metadata =
        approved.kind === 'project'
          ? input.projects
              .listProjects()
              .find((p) => p.id === approved.projectId && p.slug === slug)
          : undefined;
      if (!metadata) throw new Error('Project not found');
      const project = input.projects.getProject(slug);
      if (project.id !== metadata.id) throw new Error('Project not found');
      return project;
    },
    ...(layoutStorage && {
      async layouts(slug: string) {
        const approved = () => caller('list_project_layouts').projectScope;
        const check = (project: { id: string; slug: string }) => {
          const scope = approved();
          if (
            scope.kind !== 'project' ||
            project.id !== scope.projectId ||
            project.slug !== slug
          )
            throw new Error('Project layouts unavailable');
        };
        try {
          if (approved().kind !== 'project')
            throw new Error('Project layouts unavailable');
          const revision = layoutStorage.projectRevision(slug);
          const layouts = await revision.withCurrentRead(async (current) => {
            check(current);
            return layoutStorage.listLayouts(slug);
          });
          check(layoutStorage.projectRevision(slug).value);
          return layouts
            .filter((layout) => layout.projectSlug === slug)
            .map(({ id, slug, projectSlug, name, type, tabCount }) => ({
              id,
              slug,
              projectSlug,
              name,
              type,
              tabCount,
            }));
        } catch {
          throw new Error('Project layouts unavailable');
        }
      },
    }),
  });
  if (listActiveWork) {
    registerActiveWorkTool(
      registry,
      (args) =>
        listActiveWork(caller('list_active_work'), args, () => {
          caller('list_active_work');
        }),
      MAX_OUTSIDE_ACTIVE_WORK_CURSOR,
    );
  }
  const server = new Server(
    { name: 'station-outside-agent', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      supportedProtocolVersions: ['2025-11-25', '2025-06-18'],
    },
  );
  server.setRequestHandler('tools/list', async () => {
    const grant = input.current();
    return {
      tools: [...tools.values()]
        .filter((t) => admitted(t.definition.name, grant))
        .map((t) => t.definition),
    };
  });
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const release = input.reserveCall();
    try {
      // Independent of listing/registration: a hidden shared callback must never run.
      if (!admitted(request.params.name, input.current())) unknown();
      const args = request.params.arguments ?? {};
      if (Object.keys(args).some((key) => key.startsWith('_')))
        throw new ProtocolError(-32602, 'Invalid tool arguments');
      const tool = tools.get(request.params.name);
      if (!tool) unknown();
      const result = await tool.call(args, ctx);
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
        throw new ProtocolError(-32603, 'MCP response limit');
      return result;
    } finally {
      release();
    }
  });
  return server;
}
