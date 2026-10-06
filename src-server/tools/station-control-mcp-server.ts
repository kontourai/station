import {
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import {
  McpServer,
  type StandardSchemaWithJSON,
  type ToolCallback,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import { registerAgentTools } from './station-control-agent-tools.js';
import { registerBasisTools } from './station-control-basis-tools.js';
import { registerBoardTools } from './station-control-board-tools.js';
import { registerCatalogTools } from './station-control-catalog-tools.js';
import { registerDeclarePullRequestTools } from './station-control-declare-pull-request-tools.js';
import { registerNotifyTools } from './station-control-notify-tools.js';
import { registerOperationsTools } from './station-control-operations-tools.js';
import { registerPlatformTools } from './station-control-platform-tools.js';
import {
  evaluateStationControlPolicy,
  personOnlyApplies,
  type StationControlRefusal,
  stationControlRefusal,
  stationControlRefusalBody,
  stationControlToolPolicy,
} from './station-control-policy.js';
import { registerSessionInventoryTools } from './station-control-session-inventory-tools.js';
import { registerSessionSearchTools } from './station-control-session-search-tools.js';
import { registerSessionTools } from './station-control-session-tools.js';
import {
  getStationControlCaller,
  jsonToolResult,
} from './station-control-shared.js';
import { registerKnowledgeDataTools } from './station-knowledge-tools.js';

/**
 * #2377 slice A: the tool-side half of the station-control authority table.
 * Refuses with the SAME typed code the server guard would answer, before the
 * tool makes its call, so an agent learns what to do without a round trip
 * (the shape `browserAgentCallerRefusal` set). The server guard remains the
 * enforcement point; this can only refuse earlier, never allow more.
 *
 * Skipped where it has nothing to add: tools not in the table (the browser
 * tools, whose own refusal is unchanged), route-enforced tools (`notify_user`
 * answers `caller-required` itself), reads of data that belongs to no person
 * (any caller, or none, may read them), and tools that call no route
 * (`install_plugin` only explains). A principal-scoped or operator-wide read
 * is checked (slice B): a caller-less or owner-less session learns why here,
 * whatever envelope the tool's SDK call would have put the server's code in.
 */
function withToolSideRefusal<
  Callback extends (input: never, ...rest: never[]) => unknown,
>(name: string, callback: Callback): Callback {
  const policy = stationControlToolPolicy(name);
  if (
    !policy ||
    policy.enforcedBy === 'route' ||
    (policy.toolClass === 'read-only' && policy.role === 'none') ||
    policy.routes.length === 0
  )
    return callback;
  const guarded = async (
    ...args: Parameters<Callback>
  ): Promise<ReturnType<Callback> | ReturnType<typeof jsonToolResult>> => {
    const input: unknown = args[0];
    // A person-only request is refused before any caller lookup: no caller
    // could take it.
    const refusal: StationControlRefusal | undefined = personOnlyApplies(
      policy,
      input,
    )
      ? stationControlRefusal('station_control_person_only')
      : evaluateStationControlPolicy(policy, {
          caller: await getStationControlCaller(),
          body: input,
        });
    if (refusal) return jsonToolResult(stationControlRefusalBody(refusal));
    return Reflect.apply(callback, undefined, args) as ReturnType<Callback>;
  };
  // The SDK types a callback by its schema; `guarded` takes exactly the same
  // arguments and returns either the callback's result or a tool result.
  return guarded as Callback;
}

function stationControlToolMetadata(name: string) {
  const groups: [string, RegExp][] = [
    ['Knowledge', /knowledge/],
    ['Evidence', /basis|review|receipt/],
    ['Agents', /agent/],
    ['Projects', /project|layout|^board_/],
    ['Chats', /conversation|session|message/],
    ['Tasks', /task|delegat|ssh_environment|pull_request/],
    ['Scheduling', /job|schedul/],
    ['Skills', /skill/],
    ['Integrations', /integration|provider|plugin/],
  ];
  const group =
    groups.find(([, pattern]) => pattern.test(name))?.[0] ?? 'Station';
  const policy = stationControlToolPolicy(name);
  return {
    title: name
      .replaceAll('_', ' ')
      .replace(/^./, (letter) => letter.toUpperCase()),
    _meta: { 'ai.kontour/tool-group': group },
    ...(policy
      ? { annotations: { readOnlyHint: policy.toolClass === 'read-only' } }
      : {}),
  };
}

/**
 * The small registration surface shared by Station's built-in control tools.
 * It keeps the domain modules independent of transport while registering
 * native v2 tools with object schemas.
 */
export class StationControlToolRegistry {
  constructor(
    private readonly server: McpServer,
    private readonly catalog?: (
      name: string,
      description: string,
      shape?: z.ZodRawShape,
    ) => void,
    private readonly allowedTools?: readonly string[],
  ) {}

  tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    callback: ToolCallback<z.ZodObject<Shape>>,
  ) {
    if (this.allowedTools && !this.allowedTools.includes(name)) return;
    this.catalog?.(name, description, shape);
    return this.server.registerTool(
      name,
      {
        ...stationControlToolMetadata(name),
        description,
        inputSchema: z.object(shape),
      },
      withToolSideRefusal(name, callback),
    );
  }

  toolWithSchema<Schema extends StandardSchemaWithJSON>(
    name: string,
    description: string,
    inputSchema: Schema,
    callback: ToolCallback<Schema>,
  ) {
    if (this.allowedTools && !this.allowedTools.includes(name)) return;
    this.catalog?.(name, description);
    return this.server.registerTool(
      name,
      { ...stationControlToolMetadata(name), description, inputSchema },
      withToolSideRefusal(name, callback),
    );
  }

  appTool<Schema extends StandardSchemaWithJSON>(
    name: string,
    description: string,
    inputSchema: Schema,
    config: {
      _meta: Record<string, unknown>;
      annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    },
    unguardedCallback: ToolCallback<Schema>,
  ) {
    // @modelcontextprotocol/server v2 and ext-apps currently publish distinct
    // structural ServerContext types. The helper only calls registerTool;
    // keep the compatibility cast at this one adapter while still using the
    // official metadata normalization rather than reimplementing it.
    if (this.allowedTools && !this.allowedTools.includes(name)) return;
    this.catalog?.(name, description);
    const callback = withToolSideRefusal(name, unguardedCallback);
    const metadata = stationControlToolMetadata(name);
    return registerAppTool(
      this.server as unknown as Parameters<typeof registerAppTool>[0],
      name,
      {
        description,
        inputSchema,
        ...metadata,
        ...config,
        _meta: { ...metadata._meta, ...config._meta },
        annotations: {
          ...metadata.annotations,
          ...config.annotations,
        },
      } as unknown as Parameters<typeof registerAppTool>[2],
      callback as unknown as Parameters<typeof registerAppTool>[3],
    );
  }

  resource(
    name: string,
    uri: string,
    resource: {
      uri: string;
      mimeType: 'text/html;profile=mcp-app';
      text: string;
      _meta: {
        ui: { csp: { connectDomains: string[]; resourceDomains: string[] } };
      };
    },
  ) {
    return registerAppResource(
      this.server as unknown as Parameters<typeof registerAppResource>[0],
      name,
      uri,
      { mimeType: resource.mimeType, _meta: resource._meta },
      async () => ({ contents: [resource] }),
    );
  }
}

/**
 * One definition backs both protocol eras and every transport. The v2 server
 * entry supplies native 2026-07-28 discovery/envelope handling; its serving
 * adapters provide the explicit legacy compatibility boundary.
 */
export function createStationControlMcpServer(): McpServer {
  return createSelectedStationControlMcpServer();
}

export function createSelectedStationControlMcpServer(
  allowedTools?: readonly string[],
  catalog?: (name: string, description: string, shape?: z.ZodRawShape) => void,
  profile: 'station-control' | 'station-knowledge' = 'station-control',
): McpServer {
  const server = new McpServer(
    {
      name: profile,
      version: '2.0.0',
    },
    {
      capabilities: { tools: {} },
      cacheHints: {
        'server/discover': { ttlMs: 300_000, cacheScope: 'private' },
        'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
      },
    },
  );
  const registry = new StationControlToolRegistry(
    server,
    catalog,
    allowedTools,
  );
  if (profile === 'station-knowledge') {
    registerKnowledgeDataTools(registry);
    return server;
  }
  registerAgentTools(registry);
  registerBoardTools(registry);
  registerCatalogTools(registry);
  registerOperationsTools(registry);
  registerPlatformTools(registry);
  registerBasisTools(registry);
  registerSessionInventoryTools(registry);
  registerSessionSearchTools(registry);
  registerSessionTools(registry);
  registerNotifyTools(registry);
  registerDeclarePullRequestTools(registry);
  return server;
}

export function stationControlToolCatalog() {
  const tools: {
    name: string;
    description: string;
    readOnly: boolean;
    group: string;
    title: string;
  }[] = [];
  createSelectedStationControlMcpServer(undefined, (name, description) => {
    tools.push({
      name,
      description,
      group: stationControlToolMetadata(name)._meta['ai.kontour/tool-group'],
      title: stationControlToolMetadata(name).title,
      readOnly: stationControlToolPolicy(name)?.toolClass === 'read-only',
    });
  });
  return tools;
}
