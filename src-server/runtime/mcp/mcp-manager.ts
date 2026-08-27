/**
 * MCP (Model Context Protocol) management functions
 * Handles MCP server lifecycle, tool loading, and tool name normalization
 */

import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import {
  connectMCP,
  type MCPConnection,
  type MCPToolInfo,
} from '@kontourai/station-shared/mcp';
import { DEFAULT_SERVER_PORT } from '@kontourai/station-shared/ports';
import type { Tool } from '@voltagent/core';
import type { ConfigLoader } from '../../domain/config-loader.js';
import { wrapPlatformMutationGatedTools } from '../../services/evidence/platform-mutation-gate.js';
import { toolServerOAuthRedirectUrl } from '../../services/plugins/mcp-service.js';
import { ToolServerCredentialStore } from '../../services/plugins/tool-server-credential-store.js';
import {
  captureToolServerOperationFailure,
  requireToolServerResult,
  StationToolServerOAuthProvider,
  toolServerOAuthResourceIdentity,
} from '../../services/plugins/tool-server-oauth.js';
import { establishMcpSecretChild } from '../../services/secrets/mcp-secret-child-env.js';
import type { IntegrationSecretResolver } from '../../services/secrets/secret-binding-administration.js';
import {
  mcpLifecycle,
  mcpNegotiationDuration,
  mcpNegotiations,
} from '../../telemetry/metrics.js';
import { createChildDelegationContext } from '../agents/delegation.js';
import {
  currentTenantExecutionContext,
  isHostedTenantExecutionRequired,
} from '../bootstrap/runtime-tenant-context.js';
import {
  isBuiltinStationControl,
  withStationControlRuntimeEnv,
} from '../bootstrap/station-control-runtime-env.js';
import {
  type MCPToolNameMappingEntry,
  matchesToolPattern as matchMCPToolPattern,
  normalizeLoadedMCPTools,
  getNormalizedToolName as resolveNormalizedToolName,
  getOriginalToolName as resolveOriginalToolName,
} from '../tools/mcp-tool-names.js';
import { markTrustedNativeStationControlTool } from '../tools/tool-provenance.js';
import { createBuiltinVendedTool } from '../tools/vended-tool-compat.js';
import { isMCPAppsToolVisibleTo } from './mcp-apps-metadata.js';

/**
 * Create MCP server configuration from tool definition
 * @param resolvedEnv - If provided, used instead of toolDef.env (env resolution chain)
 */
function withResolvedMCPEnvironment(
  toolId: string,
  toolDef: ToolDef,
  resolvedEnv?: Record<string, string>,
  tenantExecutionContext?: TenantExecutionContext,
): ToolDef {
  const env = withStationControlRuntimeEnv(
    toolId,
    toolDef,
    resolvedEnv ?? toolDef.env,
    tenantExecutionContext,
  );

  const child = {
    ...toolDef,
    args: (toolDef.args || []).map((arg) =>
      arg === './' ? process.cwd() : arg,
    ),
    env,
  };
  // This clone is child-only. Do not let the shared portability normalizer
  // mistake an already-resolved env for exportable binding metadata.
  delete child.secretEnvRefs;
  return child;
}

// The catalog connection is context-free and used only to obtain schemas.
// Actual built-in station-control calls always route through this tenant-bound
// map; ordinary and third-party MCP clients keep their existing shared map.
const nativeStationControlConnections = new Map<string, MCPConnection>();
const nativeStationControlCreations = new Map<string, Promise<MCPConnection>>();
const nativeStationControlDeferredDisposals = new Map<
  string,
  MCPConnection[]
>();
let nativeStationControlConnectionGeneration = 0;

class NativeStationControlReleasedDuringCreationError extends Error {
  constructor(
    message: string,
    readonly cleanupFailure?: unknown,
  ) {
    super(message);
  }
}

function retainNativeStationControlConnection(
  tenantId: string,
  connection: MCPConnection,
): void {
  const retained = nativeStationControlDeferredDisposals.get(tenantId) ?? [];
  retained.push(connection);
  nativeStationControlDeferredDisposals.set(tenantId, retained);
}

async function disconnectNativeStationControlConnections(
  connections: Array<[string, MCPConnection]>,
): Promise<void> {
  const failures: unknown[] = [];
  await Promise.all(
    connections.map(async ([tenantId, connection]) => {
      try {
        await connection.disconnect();
      } catch (error) {
        retainNativeStationControlConnection(tenantId, connection);
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

export async function releaseNativeStationControlContext(
  context: TenantExecutionContext | undefined,
): Promise<void> {
  if (!context) return;
  const connections = [
    ...(nativeStationControlConnections.has(context.tenantId)
      ? [
          [
            context.tenantId,
            nativeStationControlConnections.get(context.tenantId)!,
          ] as [string, MCPConnection],
        ]
      : []),
    ...(nativeStationControlDeferredDisposals.get(context.tenantId) ?? []).map(
      (connection) => [context.tenantId, connection] as [string, MCPConnection],
    ),
  ];
  if (!connections.length) return;
  nativeStationControlConnections.delete(context.tenantId);
  nativeStationControlDeferredDisposals.delete(context.tenantId);
  await disconnectNativeStationControlConnections(connections);
}

/** Process shutdown cleanup for the tenant-keyed native station-control pool. */
export async function releaseAllNativeStationControlConnections(): Promise<void> {
  // Invalidate first. A creation that resolves after this point must dispose
  // its child instead of repopulating a pool the runtime has released.
  nativeStationControlConnectionGeneration += 1;
  const connections = [
    ...nativeStationControlConnections.entries(),
    ...[...nativeStationControlDeferredDisposals.entries()].flatMap(
      ([tenantId, retained]) =>
        retained.map(
          (connection) => [tenantId, connection] as [string, MCPConnection],
        ),
    ),
  ];
  const creations = [...nativeStationControlCreations.values()];
  nativeStationControlConnections.clear();
  nativeStationControlDeferredDisposals.clear();
  nativeStationControlCreations.clear();
  const results = await Promise.allSettled([
    disconnectNativeStationControlConnections(connections),
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

async function nativeStationControlConnection(
  toolId: string,
  toolDef: ToolDef,
  resolvedEnv: Record<string, string> | undefined,
): Promise<MCPConnection> {
  const context = currentTenantExecutionContext();
  if (!context) {
    if (!isHostedTenantExecutionRequired()) {
      throw new Error('No tenant-bound station-control connection is active.');
    }
    throw new Error(
      'Tenant execution context is required for station-control.',
    );
  }
  const existing = nativeStationControlConnections.get(context.tenantId);
  if (existing) return existing;
  const creating = nativeStationControlCreations.get(context.tenantId);
  if (creating) return creating;
  const generation = nativeStationControlConnectionGeneration;
  const creation = (async () => {
    const connection = await connectMCP(
      withResolvedMCPEnvironment(toolId, toolDef, resolvedEnv, context),
    );
    if (generation !== nativeStationControlConnectionGeneration) {
      try {
        await connection.disconnect();
      } catch (error) {
        retainNativeStationControlConnection(context.tenantId, connection);
        throw new NativeStationControlReleasedDuringCreationError(
          'Tenant station-control connection was released while creation was pending.',
          error,
        );
      }
      throw new NativeStationControlReleasedDuringCreationError(
        'Tenant station-control connection was released while creation was pending.',
      );
    }
    nativeStationControlConnections.set(context.tenantId, connection);
    return connection;
  })();
  nativeStationControlCreations.set(context.tenantId, creation);
  try {
    return await creation;
  } finally {
    if (nativeStationControlCreations.get(context.tenantId) === creation) {
      nativeStationControlCreations.delete(context.tenantId);
    }
  }
}

/**
 * Create MCP tools for a tool definition
 */
async function createMCPTools(
  agentSlug: string,
  toolId: string,
  toolDef: ToolDef,
  mcpConfigs: Map<string, MCPConnection>,
  mcpConnectionStatus: Map<string, { connected: boolean; error?: string }>,
  integrationMetadata: Map<
    string,
    { type: string; transport?: string; toolCount?: number }
  >,
  toolNameMapping: Map<string, MCPToolNameMappingEntry>,
  toolNameReverseMapping: Map<string, string>,
  logger: any,
  configLoader: ConfigLoader,
  serverPort: number,
  integrationSecretResolver?: IntegrationSecretResolver,
): Promise<Tool<any>[]> {
  const mcpKey = toolId;

  let mcpConfig: MCPConnection;
  let isNewConfig = false;

  // Check if MCP config already exists
  if (mcpConfigs.has(mcpKey)) {
    mcpConfig = mcpConfigs.get(mcpKey)!;
  } else {
    const startedAt = performance.now();
    const reconnecting = mcpConnectionStatus.has(mcpKey);
    try {
      mcpConfig = await establishMcpSecretChild(
        {
          integrationId: toolId,
          def: toolDef,
          resolver: integrationSecretResolver,
          isBuiltinStationControl: isBuiltinStationControl(toolId, toolDef),
        },
        (resolvedSecrets) =>
          connectMCP(
            withResolvedMCPEnvironment(
              toolId,
              toolDef,
              resolvedSecrets
                ? { ...toolDef.env, ...resolvedSecrets }
                : toolDef.env,
            ),
            {
              authProvider: createRuntimeOAuthProvider(
                configLoader,
                toolDef,
                serverPort,
              ),
            },
          ),
      );
      mcpConfigs.set(mcpKey, mcpConfig);
      isNewConfig = true;

      const { negotiation } = mcpConfig;
      const attributes = {
        era: negotiation.era,
        protocol_version: boundedProtocolVersion(negotiation.protocolVersion),
        fallback: String(negotiation.fellBackToLegacy),
        extensions: boundedExtensionCount(negotiation.extensionIds.length),
        outcome: 'success',
      };
      mcpNegotiations.add(1, attributes);
      mcpNegotiationDuration.record(performance.now() - startedAt, attributes);
      mcpLifecycle.add(1, {
        event: reconnecting ? 'reconnect' : 'connect',
        server: toolId,
      });
      logger.debug('MCP client connected', {
        agent: agentSlug,
        tool: toolId,
        era: negotiation.era,
        protocolVersion: negotiation.protocolVersion,
        extensionCount: negotiation.extensionIds.length,
      });
    } catch (error) {
      const publicError = captureToolServerOperationFailure(
        error,
        'connect',
        toolId,
        logger,
      );
      const errorClass = classifyMCPError(error);
      const attributes = {
        era: 'unknown',
        protocol_version: 'unknown',
        fallback: 'unknown',
        extensions: '0',
        outcome: 'failure',
        error_class: errorClass,
      };
      mcpNegotiations.add(1, attributes);
      mcpNegotiationDuration.record(performance.now() - startedAt, attributes);
      mcpConnectionStatus.set(mcpKey, {
        connected: false,
        error: publicMCPConnectionError(toolId, errorClass),
      });
      mcpLifecycle.add(1, { event: 'error', server: toolId });
      throw publicError;
    }
  }

  // MCP Apps tools may be app-only. They remain in the raw connection catalog
  // for the host bridge, but never enter an agent/model tool catalog.
  const isNativeStationControl = isBuiltinStationControl(toolId, toolDef);
  const tools = mcpConfig.tools
    .filter((tool) => isMCPAppsToolVisibleTo(tool, 'model'))
    .map((tool) =>
      toStationMCPTool(
        mcpConfig,
        tool,
        logger,
        isNativeStationControl,
        isNativeStationControl
          ? async (args) => {
              const connection = currentTenantExecutionContext()
                ? await nativeStationControlConnection(
                    toolId,
                    toolDef,
                    undefined,
                  )
                : isHostedTenantExecutionRequired()
                  ? await nativeStationControlConnection(
                      toolId,
                      toolDef,
                      undefined,
                    )
                  : mcpConfig;
              return connection.client.callTool({
                name: tool.originalName,
                arguments: args ?? {},
              });
            }
          : undefined,
      ),
    );

  // Normalize tool names for Nova compatibility and store mapping with parsed data
  const normalizedTools = normalizeLoadedMCPTools(
    agentSlug,
    tools,
    toolNameMapping,
    toolNameReverseMapping,
    logger,
  );

  // Mark as connected after successful getTools
  mcpConnectionStatus.set(mcpKey, { connected: true });

  // Store integration metadata
  integrationMetadata.set(mcpKey, {
    type: 'mcp',
    transport: toolDef.transport,
    toolCount: normalizedTools.length,
  });

  if (isNewConfig) {
    logger.info('MCP tools loaded', {
      agent: agentSlug,
      tool: toolId,
      count: normalizedTools.length,
      sampleNames: normalizedTools.slice(0, 3).map((t) => t.name),
    });
  }

  return normalizedTools;
}

/**
 * Check if tool name matches any pattern in the list
 */
function matchesToolPattern(
  toolName: string,
  patterns: string[],
  toolNameMapping: Map<string, MCPToolNameMappingEntry>,
): boolean {
  return matchMCPToolPattern(toolName, patterns, toolNameMapping);
}

/**
 * Load tools for an agent (regular tools + MCP tools)
 */
export async function loadAgentTools(
  agentSlug: string,
  spec: AgentSpec,
  configLoader: ConfigLoader,
  mcpConfigs: Map<string, MCPConnection>,
  mcpConnectionStatus: Map<string, { connected: boolean; error?: string }>,
  integrationMetadata: Map<
    string,
    { type: string; transport?: string; toolCount?: number }
  >,
  toolNameMapping: Map<string, MCPToolNameMappingEntry>,
  toolNameReverseMapping: Map<string, string>,
  logger: any,
  serverPort: number = DEFAULT_SERVER_PORT,
  integrationSecretResolver?: IntegrationSecretResolver,
): Promise<Tool<any>[]> {
  const tools: Tool<any>[] = [];

  if (!spec.tools?.mcpServers || spec.tools.mcpServers.length === 0) {
    return tools;
  }

  // Load each MCP server from catalog
  for (const entry of spec.tools.mcpServers) {
    try {
      const toolId = entry;
      const toolDef = await configLoader.loadIntegration(entry);

      if (toolDef.enabled === false) {
        mcpConnectionStatus.set(toolId, { connected: false });
        continue;
      }

      if (toolDef.kind === 'mcp') {
        const mcpTools = await createMCPTools(
          agentSlug,
          toolId,
          toolDef,
          mcpConfigs,
          mcpConnectionStatus,
          integrationMetadata,
          toolNameMapping,
          toolNameReverseMapping,
          logger,
          configLoader,
          serverPort,
          integrationSecretResolver,
        );
        const enabledTools = mcpTools.filter(
          (tool) => !toolDef.disabledTools?.includes(tool.name),
        );
        tools.push(
          ...wrapPlatformMutationGatedTools(
            wrapDelegationAwareTools(enabledTools, {
              agentSlug,
              spec,
              toolId,
            }),
            { agentSlug, toolId },
          ),
        );
      } else if (toolDef.kind === 'builtin') {
        const builtinTool = createBuiltinTool(agentSlug, toolDef, logger);
        if (builtinTool) {
          tools.push(builtinTool);
          mcpConnectionStatus.set(toolId, { connected: true });
          integrationMetadata.set(toolId, {
            type: 'builtin',
            toolCount: 1,
          });
        }
      }
    } catch (error) {
      const errorClass = classifyMCPError(error);
      logger.error('Failed to load tool', {
        agent: agentSlug,
        toolId: entry,
        errorClass,
        error: publicMCPConnectionError(entry, errorClass),
      });
    }
  }

  // Apply available filter (defaults to all tools)
  const available = spec.tools.available || ['*'];

  logger.debug('Tool filtering', {
    agent: agentSlug,
    totalTools: tools.length,
    availablePatterns: available,
    toolNames: tools.slice(0, 5).map((t) => t.name),
  });

  if (!available.includes('*')) {
    const filtered = tools.filter((tool) =>
      matchesToolPattern(tool.name, available, toolNameMapping),
    );
    logger.info('Tools filtered', {
      agent: agentSlug,
      before: tools.length,
      after: filtered.length,
      removed: tools.length - filtered.length,
    });
    return filtered;
  }

  return tools;
}

export function createRuntimeOAuthProvider(
  configLoader: ConfigLoader,
  def: ToolDef,
  serverPort: number,
): StationToolServerOAuthProvider | undefined {
  if (
    (def.transport !== 'sse' && def.transport !== 'streamable-http') ||
    !def.endpoint
  ) {
    return undefined;
  }
  const resourceIdentity = toolServerOAuthResourceIdentity(def);
  if (!resourceIdentity) return undefined;
  return new StationToolServerOAuthProvider(
    new ToolServerCredentialStore(configLoader.getProjectHomeDir()),
    def.id,
    resourceIdentity,
    toolServerOAuthRedirectUrl(serverPort, def.id),
  );
}

function toStationMCPTool(
  connection: MCPConnection,
  tool: MCPToolInfo,
  logger: any,
  isNativeStationControl: boolean,
  execute?: (args: Record<string, unknown>) => Promise<unknown>,
): Tool<any> {
  const stationTool = {
    id: tool.name,
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? {
      type: 'object',
      properties: {},
    },
    _meta: tool._meta,
    ui: tool.ui,
    execute: async (args: Record<string, unknown>) => {
      try {
        const result = await (execute?.(args) ??
          connection.client.callTool({
            name: tool.originalName,
            arguments: args ?? {},
          }));
        return isNativeStationControl
          ? result
          : requireToolServerResult(result, 'tool-call', tool.serverId, logger);
      } catch (error) {
        if (error instanceof NativeStationControlReleasedDuringCreationError) {
          throw error;
        }
        throw captureToolServerOperationFailure(
          error,
          'tool-call',
          tool.serverId,
          logger,
        );
      }
    },
  } as unknown as Tool<any>;
  return isNativeStationControl
    ? markTrustedNativeStationControlTool(stationTool)
    : stationTool;
}

function boundedProtocolVersion(version: string | undefined): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(version ?? '')
    ? (version as string)
    : 'unknown';
}

function boundedExtensionCount(count: number): string {
  if (count === 0) return '0';
  if (count === 1) return '1';
  if (count <= 4) return '2-4';
  return '5+';
}

function classifyMCPError(error: unknown): string {
  const name =
    error instanceof Error ? error.constructor?.name.toLowerCase() : '';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (name.includes('timeout') || message.includes('timed out'))
    return 'timeout';
  if (
    name.includes('protocol') ||
    message.includes('protocol') ||
    message.includes('json-rpc')
  ) {
    return 'protocol';
  }
  if (
    name.includes('spawn') ||
    message.includes('enoent') ||
    message.includes('connection') ||
    message.includes('fetch')
  ) {
    return 'transport';
  }
  return 'unknown';
}

function publicMCPConnectionError(toolId: string, errorClass: string): string {
  const recovery =
    errorClass === 'timeout'
      ? 'The server did not respond in time.'
      : errorClass === 'protocol'
        ? 'The server did not complete MCP negotiation.'
        : 'The server command or endpoint could not be reached.';
  return `Could not connect to integration '${toolId}'. ${recovery} Check its setup and credentials.`;
}

/**
 * Create a built-in tool from definition
 */
export function createBuiltinTool(
  agentSlug: string,
  toolDef: ToolDef,
  _logger: any,
): Tool<any> | null {
  return createBuiltinVendedTool(agentSlug, toolDef) as Tool<any> | null;
}

/**
 * Get original tool name from normalized name
 */
export function getOriginalToolName(
  normalizedName: string,
  toolNameMapping: Map<string, MCPToolNameMappingEntry>,
): string {
  return resolveOriginalToolName(normalizedName, toolNameMapping);
}

/**
 * Get normalized tool name from original name
 */
export function getNormalizedToolName(
  originalName: string,
  toolNameReverseMapping: Map<string, string>,
): string {
  return resolveNormalizedToolName(originalName, toolNameReverseMapping);
}

export function wrapDelegationAwareTools(
  tools: Tool<any>[],
  options: {
    agentSlug: string;
    spec: AgentSpec;
    toolId: string;
  },
): Tool<any>[] {
  if (options.toolId !== 'station-control') {
    return tools;
  }

  const bareName = (name: string): string =>
    name.replace(/^station-control_/, '');

  return tools.map((tool) => {
    const controlName = bareName(tool.name);
    if (
      controlName !== 'send_message' &&
      controlName !== 'delegate_task' &&
      controlName !== 'list_delegated_tasks' &&
      controlName !== 'get_task' &&
      controlName !== 'get_task_events' &&
      controlName !== 'continue_task' &&
      controlName !== 'respond_to_task_request' &&
      controlName !== 'interrupt_task' &&
      controlName !== 'update_skill'
    ) {
      return tool;
    }

    return {
      ...tool,
      execute: async (args: Record<string, unknown>, execOptions?: any) => {
        const nextArgs = { ...args };
        const parentConversationId =
          typeof execOptions?.conversationId === 'string'
            ? execOptions.conversationId
            : undefined;
        if (
          controlName === 'send_message' ||
          controlName === 'delegate_task' ||
          controlName === 'list_delegated_tasks' ||
          controlName === 'get_task' ||
          controlName === 'get_task_events' ||
          controlName === 'continue_task' ||
          controlName === 'respond_to_task_request' ||
          controlName === 'interrupt_task'
        ) {
          const hasConversationId =
            typeof nextArgs.conversationId === 'string' &&
            nextArgs.conversationId.length > 0;
          if (!hasConversationId && execOptions?.userId) {
            nextArgs._userId = execOptions.userId;
          }
        }
        if (controlName === 'send_message' || controlName === 'delegate_task') {
          if (parentConversationId) {
            nextArgs._delegation = createChildDelegationContext({
              agentSlug: options.agentSlug,
              conversationId: parentConversationId,
              spec: options.spec,
              current: execOptions?.delegation,
            });
            if (controlName === 'delegate_task') {
              nextArgs.parentTaskId = parentConversationId;
            }
          }
        }
        if (controlName === 'update_skill' && !nextArgs._sourceContext) {
          nextArgs._sourceContext = {
            kind: 'agent',
            agentSlug: options.agentSlug,
            ...(parentConversationId
              ? { conversationId: parentConversationId }
              : {}),
          };
        }
        if (!tool.execute) {
          throw new Error(`Tool ${tool.name} does not have an execute method`);
        }
        return tool.execute(nextArgs, execOptions);
      },
    };
  });
}
