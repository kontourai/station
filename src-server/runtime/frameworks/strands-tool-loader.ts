import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FunctionTool, McpClient } from '@strands-agents/sdk';
import { wrapPlatformMutationGatedTools } from '../../services/evidence/platform-mutation-gate.js';
import {
  captureToolServerOperationFailure,
  requireToolServerResult,
} from '../../services/plugins/tool-server-oauth.js';
import { establishMcpSecretChild } from '../../services/secrets/mcp-secret-child-env.js';
import {
  normalizeToolName,
  parseToolName,
} from '../../utils/tool-name-normalizer.js';
import {
  currentTenantExecutionContext,
  isHostedTenantExecutionRequired,
} from '../bootstrap/runtime-tenant-context.js';
import {
  isBuiltinStationControl,
  withStationControlRuntimeEnv,
} from '../bootstrap/station-control-runtime-env.js';
import { runWithCurrentNativeOutputCall } from '../native-output-turn-grant.js';
import { markTrustedNativeStationControlTool } from '../tools/tool-provenance.js';
import { createBuiltinVendedTool } from '../tools/vended-tool-compat.js';
import type { ITool, ToolCallDenial } from '../types.js';
import type { CreateAgentOptions } from './voltagent-adapter.js';

export interface StrandsToolLoaderState {
  mcpClients: Map<string, McpClient>;
  agentMcpClients: Map<string, string[]>;
}

const nativeStationControlClients = new Map<string, McpClient>();
const nativeStationControlCreations = new Map<string, Promise<McpClient>>();
const nativeStationControlDeferredDisposals = new Map<string, McpClient[]>();
let nativeStationControlClientGeneration = 0;

class NativeStationControlReleasedDuringCreationError extends Error {
  constructor(
    message: string,
    readonly cleanupFailure?: unknown,
  ) {
    super(message);
  }
}

function retainNativeStationControlClient(
  tenantId: string,
  client: McpClient,
): void {
  const retained = nativeStationControlDeferredDisposals.get(tenantId) ?? [];
  retained.push(client);
  nativeStationControlDeferredDisposals.set(tenantId, retained);
}

async function disconnectNativeStationControlClients(
  clients: Array<[string, McpClient]>,
): Promise<void> {
  const failures: unknown[] = [];
  await Promise.all(
    clients.map(async ([tenantId, client]) => {
      try {
        await client.disconnect();
      } catch (error) {
        retainNativeStationControlClient(tenantId, client);
        failures.push(error);
      }
    }),
  );
  if (failures.length) {
    throw new AggregateError(
      failures,
      'Native station-control cleanup failed.',
    );
  }
}

/** Process shutdown cleanup for the tenant-keyed native station-control pool. */
export async function releaseAllNativeStationControlClients(): Promise<void> {
  // Invalidate first so a client constructed by an in-flight tool call cannot
  // repopulate the released pool after runtime shutdown.
  nativeStationControlClientGeneration += 1;
  const clients = [
    ...nativeStationControlClients.entries(),
    ...[...nativeStationControlDeferredDisposals.entries()].flatMap(
      ([tenantId, retained]) =>
        retained.map((client) => [tenantId, client] as [string, McpClient]),
    ),
  ];
  const creations = [...nativeStationControlCreations.values()];
  nativeStationControlClients.clear();
  nativeStationControlDeferredDisposals.clear();
  nativeStationControlCreations.clear();
  const results = await Promise.allSettled([
    disconnectNativeStationControlClients(clients),
    ...creations,
  ]);
  const failures = results.flatMap((result) => {
    if (result.status !== 'rejected') return [];
    if (
      result.reason instanceof NativeStationControlReleasedDuringCreationError
    ) {
      return result.reason.cleanupFailure ? [result.reason.cleanupFailure] : [];
    }
    return [result.reason];
  });
  if (failures.length) {
    throw new AggregateError(
      failures,
      'Native station-control cleanup failed.',
    );
  }
}

async function nativeStationControlClient(
  toolId: string,
  toolDef: any,
): Promise<McpClient> {
  const context = currentTenantExecutionContext();
  if (!context) {
    if (!isHostedTenantExecutionRequired()) {
      throw new Error('No tenant-bound station-control client is active.');
    }
    throw new Error(
      'Tenant execution context is required for station-control.',
    );
  }
  const existing = nativeStationControlClients.get(context.tenantId);
  if (existing) return existing;
  const creating = nativeStationControlCreations.get(context.tenantId);
  if (creating) return creating;
  const generation = nativeStationControlClientGeneration;
  const args = (toolDef.args || []).map((arg: string) =>
    arg === './' ? process.cwd() : arg,
  );
  const client = new McpClient({
    transport: new StdioClientTransport({
      command: toolDef.command!,
      args,
      env: withStationControlRuntimeEnv(
        toolId,
        toolDef,
        { ...(process.env as Record<string, string>), ...toolDef.env },
        context,
      ) as Record<string, string>,
    }),
  });
  const creation = Promise.resolve(client).then(async (created) => {
    if (generation !== nativeStationControlClientGeneration) {
      try {
        await created.disconnect();
      } catch (error) {
        retainNativeStationControlClient(context.tenantId, created);
        throw new NativeStationControlReleasedDuringCreationError(
          'Tenant station-control client was released while creation was pending.',
          error,
        );
      }
      throw new NativeStationControlReleasedDuringCreationError(
        'Tenant station-control client was released while creation was pending.',
      );
    }
    nativeStationControlClients.set(context.tenantId, created);
    return created;
  });
  nativeStationControlCreations.set(context.tenantId, creation);
  try {
    return await creation;
  } finally {
    if (nativeStationControlCreations.get(context.tenantId) === creation) {
      nativeStationControlCreations.delete(context.tenantId);
    }
  }
}

type StrandsToolLoadOptions = Pick<
  CreateAgentOptions,
  | 'configLoader'
  | 'mcpConnectionStatus'
  | 'integrationMetadata'
  | 'toolNameMapping'
  | 'toolNameReverseMapping'
  | 'integrationSecretResolver'
  | 'logger'
>;

export function createStrandsFunctionTools(
  tools: ITool[],
  deniedToolCalls: Map<string, ToolCallDenial>,
): FunctionTool[] {
  return tools.map(
    (tool) =>
      new FunctionTool({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.parameters as any,
        callback: async (input: unknown, toolContext: any) => {
          const toolUseId = toolContext?.toolUse?.toolUseId;
          const denial = toolUseId ? deniedToolCalls.get(toolUseId) : undefined;
          if (toolUseId && denial !== undefined) {
            deniedToolCalls.delete(toolUseId);
            // station#1834: surface the gate's REAL reason as a tool ERROR.
            // Throwing here is how every other tool failure surfaces —
            // FunctionTool.stream() catches and wraps it in a
            // `status: 'error'` ToolResultBlock. The old behavior returned a
            // fabricated "denied by the user" SUCCESS string, so unattended
            // runs completed as if the blocked tool had simply agreed.
            //
            // station#3091: `denial.policyDenied` rides along on the thrown
            // Error as a custom own-property. Strands' own error handling
            // (`createErrorResult` in the installed SDK) holds the SAME
            // Error object reference on the resulting ToolResultBlock's
            // `.error` field rather than cloning it, so the marker survives
            // into `mapStrandsStreamEvent` unchanged — that's the carrying
            // seam this station#3091 fix depends on.
            //
            // station#3210: the authorship marker `stationComposedReason`
            // rides the same own-property channel, and is what
            // `mapStrandsStreamEvent` reads to decide verbatim vs. redacted.
            const error = new Error(denial.reason) as Error & {
              policyDenied?: true;
              stationComposedReason?: true;
            };
            if (denial.policyDenied) error.policyDenied = true;
            if (denial.stationComposedReason) {
              error.stationComposedReason = true;
            }
            throw error;
          }
          // Only the real Strands callback supplies this id. In particular,
          // never fall back to tool arguments, a generic MCP id, or stream
          // event timing: those are model-/transport-controlled values.
          return runWithCurrentNativeOutputCall(
            toolContext?.toolUse?.toolUseId,
            () => tool.execute(input, toolContext),
          );
        },
      }),
  );
}

export function applyStrandsAvailableToolFilter(
  tools: ITool[],
  available: string[] = ['*'],
): ITool[] {
  if (available.includes('*')) {
    return tools;
  }

  return tools.filter((tool) =>
    available.some((pattern) => {
      if (pattern === tool.name) {
        return true;
      }
      if (pattern.endsWith('*')) {
        return tool.name.startsWith(pattern.slice(0, -1));
      }
      return false;
    }),
  );
}

export async function loadStrandsTools(options: {
  slug: string;
  spec: AgentSpec;
  opts: StrandsToolLoadOptions;
  state: StrandsToolLoaderState;
}): Promise<ITool[]> {
  const { slug, spec, opts, state } = options;
  if (!spec.tools?.mcpServers?.length) {
    return [];
  }

  const allTools: ITool[] = [];
  const agentClientIds: string[] = [];

  for (const toolId of spec.tools.mcpServers) {
    try {
      const toolDef = await opts.configLoader.loadIntegration(toolId);

      if (toolDef.enabled === false) {
        opts.mcpConnectionStatus.set(toolId, { connected: false });
        continue;
      }

      if (toolDef.kind === 'builtin') {
        const builtinTool = createBuiltinVendedTool(slug, toolDef);
        if (builtinTool) {
          allTools.push(builtinTool);
          opts.mcpConnectionStatus.set(toolId, { connected: true });
          opts.integrationMetadata.set(toolId, {
            type: 'builtin',
            toolCount: 1,
          });
        }
        continue;
      }

      if (toolDef.kind !== 'mcp') {
        continue;
      }
      if (toolDef.transport !== 'stdio') {
        opts.logger.warn('Strands adapter only supports stdio MCP transport', {
          toolId,
          transport: toolDef.transport,
        });
        continue;
      }

      let client = state.mcpClients.get(toolId);
      let mcpTools: Awaited<ReturnType<McpClient['listTools']>>;
      if (!client) {
        const established = await establishMcpSecretChild(
          {
            integrationId: toolId,
            def: toolDef,
            resolver: opts.integrationSecretResolver,
            isBuiltinStationControl: isBuiltinStationControl(toolId, toolDef),
          },
          async (resolvedSecrets) => {
            const args = (toolDef.args || []).map((arg: string) =>
              arg === './' ? process.cwd() : arg,
            );
            const fresh = new McpClient({
              transport: new StdioClientTransport({
                command: toolDef.command!,
                args,
                env: withStationControlRuntimeEnv(toolId, toolDef, {
                  ...(process.env as Record<string, string>),
                  ...toolDef.env,
                  ...resolvedSecrets,
                }) as Record<string, string>,
              }),
            });
            try {
              return { client: fresh, tools: await fresh.listTools() };
            } catch (error) {
              // The client was never admitted to `mcpClients`, so its
              // transport has no owner unless this first handshake is closed
              // here. Preserve the original establishment failure.
              await fresh.disconnect().catch(() => {});
              throw error;
            }
          },
        );
        client = established.client;
        mcpTools = established.tools;
        state.mcpClients.set(toolId, client);
      } else {
        mcpTools = await client.listTools();
      }
      const isNativeStationControl = isBuiltinStationControl(toolId, toolDef);

      const serverTools: ITool[] = [];
      for (const tool of mcpTools) {
        const normalized = normalizeToolName(tool.toolSpec.name);
        if (normalized !== tool.toolSpec.name) {
          const parsed = parseToolName(tool.toolSpec.name);
          opts.toolNameMapping.set(normalized, {
            original: tool.toolSpec.name,
            normalized,
            server: parsed.server,
            tool: parsed.tool,
          });
          opts.toolNameReverseMapping.set(tool.toolSpec.name, normalized);
        }

        const stationTool = {
          name: normalized,
          description: tool.toolSpec.description,
          parameters: tool.toolSpec.inputSchema,
          ...extractStrandsToolUIMetadata(tool.toolSpec),
          execute: async (input: any) => {
            const activeClient = isNativeStationControl
              ? currentTenantExecutionContext() ||
                isHostedTenantExecutionRequired()
                ? await nativeStationControlClient(toolId, toolDef)
                : client!
              : client!;
            const result = await activeClient.callTool(tool, input);
            return isNativeStationControl
              ? result
              : requireToolServerResult(
                  result,
                  'tool-call',
                  toolId,
                  opts.logger,
                );
          },
        } as ITool;
        serverTools.push(
          isNativeStationControl
            ? markTrustedNativeStationControlTool(stationTool)
            : stationTool,
        );
      }
      // Mutating station-control tools execute through the
      // platform-mutation gate regardless of dispatch path (S3 item 4).
      const enabledServerTools = serverTools.filter(
        (tool) => !toolDef.disabledTools?.includes(tool.name),
      );
      allTools.push(
        ...wrapPlatformMutationGatedTools(enabledServerTools, {
          agentSlug: slug,
          toolId,
        }),
      );

      opts.mcpConnectionStatus.set(toolId, { connected: true });
      opts.integrationMetadata.set(toolId, {
        type: 'mcp',
        transport: toolDef.transport,
        toolCount: mcpTools.length,
      });
      agentClientIds.push(toolId);

      opts.logger.info('Strands MCP tools loaded', {
        agent: slug,
        tool: toolId,
        count: mcpTools.length,
      });
    } catch (error) {
      const safeError = captureToolServerOperationFailure(
        error,
        'connect',
        toolId,
        opts.logger,
      );
      opts.logger.error('Failed to load MCP tool via Strands', {
        agent: slug,
        toolId,
        error: safeError,
      });
      opts.mcpConnectionStatus.set(toolId, {
        connected: false,
        error: safeError.message,
      });
    }
  }

  state.agentMcpClients.set(slug, agentClientIds);
  return applyStrandsAvailableToolFilter(
    allTools,
    spec.tools.available || ['*'],
  );
}

export async function destroyStrandsAgentTools(
  slug: string,
  state: StrandsToolLoaderState,
): Promise<void> {
  const clientIds = state.agentMcpClients.get(slug);
  if (!clientIds) {
    return;
  }

  for (const id of clientIds) {
    const client = state.mcpClients.get(id);
    if (!client) {
      continue;
    }
    await client.disconnect().catch(() => {});
    state.mcpClients.delete(id);
  }

  state.agentMcpClients.delete(slug);
}

function extractStrandsToolUIMetadata(
  toolSpec: object,
): Pick<ITool, '_meta' | 'ui' | 'resource'> {
  const toolSpecRecord = toolSpec as Record<string, unknown>;
  const _meta = recordField(toolSpecRecord, '_meta');
  const directUi = recordField(toolSpecRecord, 'ui');
  const metaUi = recordField(_meta, 'ui');
  const resource = recordField(toolSpecRecord, 'resource');
  const resourceUri =
    stringField(directUi, 'resourceUri') ??
    stringField(metaUi, 'resourceUri') ??
    stringField(toolSpecRecord, 'resourceUri') ??
    stringField(resource, 'uri');

  return {
    _meta,
    ui: resourceUri ? { resourceUri } : undefined,
    resource: resourceUri ? { uri: resourceUri } : undefined,
  };
}

function recordField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}
