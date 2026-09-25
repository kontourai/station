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
import {
  getStationControlCaller,
  jsonToolResult,
} from './station-control-shared.js';

/**
 * #2377 slice A: the tool-side half of the station-control authority table.
 * Refuses with the SAME typed code the server guard would answer, before the
 * tool makes its call, so an agent learns what to do without a round trip
 * (the shape `browserAgentCallerRefusal` set). The server guard remains the
 * enforcement point; this can only refuse earlier, never allow more.
 *
 * Skipped where it has nothing to add: tools not in the table (the browser
 * tools, whose own refusal is unchanged), route-enforced tools (`notify_user`
 * answers `caller-required` itself), read-only tools (any caller, or none,
 * may read in slice A), and tools that call no route (`install_plugin`
 * only explains).
 */
function withToolSideRefusal<Callback>(
  name: string,
  callback: Callback,
): Callback {
  const policy = stationControlToolPolicy(name);
  if (
    !policy ||
    policy.enforcedBy === 'route' ||
    policy.toolClass === 'read-only' ||
    policy.routes.length === 0
  )
    return callback;
  const run = callback as unknown as (...args: unknown[]) => unknown;
  return (async (...args: unknown[]) => {
    const input = args[0];
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
    return run(...args);
  }) as unknown as Callback;
}

/**
 * The small registration surface shared by Station's built-in control tools.
 * It keeps the domain modules independent of transport while registering
 * native v2 tools with object schemas.
 */
export class StationControlToolRegistry {
  constructor(private readonly server: McpServer) {}

  tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    callback: ToolCallback<z.ZodObject<Shape>>,
  ) {
    return this.server.registerTool(
      name,
      {
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
    return this.server.registerTool(
      name,
      { description, inputSchema },
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
    callback: ToolCallback<Schema>,
  ) {
    // @modelcontextprotocol/server v2 and ext-apps currently publish distinct
    // structural ServerContext types. The helper only calls registerTool;
    // keep the compatibility cast at this one adapter while still using the
    // official metadata normalization rather than reimplementing it.
    return registerAppTool(
      this.server as unknown as Parameters<typeof registerAppTool>[0],
      name,
      {
        description,
        inputSchema,
        ...config,
      } as unknown as Parameters<typeof registerAppTool>[2],
      withToolSideRefusal(name, callback) as unknown as Parameters<
        typeof registerAppTool
      >[3],
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
  const server = new McpServer(
    {
      name: 'station-control',
      version: '2.0.0',
    },
    {
      cacheHints: {
        'server/discover': { ttlMs: 300_000, cacheScope: 'private' },
        'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
      },
    },
  );
  const registry = new StationControlToolRegistry(server);
  registerAgentTools(registry);
  registerBoardTools(registry);
  registerCatalogTools(registry);
  registerOperationsTools(registry);
  registerPlatformTools(registry);
  registerBasisTools(registry);
  registerSessionInventoryTools(registry);
  registerNotifyTools(registry);
  return server;
}
