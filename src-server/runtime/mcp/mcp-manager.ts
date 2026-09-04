/**
 * MCP (Model Context Protocol) management functions
 * Handles MCP server lifecycle, tool loading, and tool name normalization
 */

import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import {
  type MCPConnection,
  type MCPLocalClaim,
  type MCPLocalConnectionCustody,
  MCPLocalCustodyError,
  type MCPToolInfo,
} from '@kontourai/station-shared/mcp';
import { DEFAULT_SERVER_PORT } from '@kontourai/station-shared/ports';
import type { Tool } from '@voltagent/core';
import type { ConfigLoader } from '../../domain/config-loader.js';
import { wrapPlatformMutationGatedTools } from '../../services/evidence/platform-mutation-gate.js';
import type { MCPToolProvenanceGeneration } from '../../services/orchestration/mcp-tool-provenance.js';
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
import { sameMCPConnectionDefinition } from './mcp-definition-currentness.js';
import {
  describeLoaderFailure,
  isLoaderProgrammingFailure,
  loaderErrorClass,
} from './tool-load-failure.js';

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

// Tenant pools are runtime-owner-qualified publication projections. Actual
// handles (including unpublished/failed ones) remain in that runtime's custody.
type NativeConnectionEntry = {
  current: boolean;
  claim: MCPLocalClaim;
  connection?: MCPConnection;
  creation?: Promise<MCPConnection>;
};
class NativeStationControlReleasedDuringCreationError extends Error {
  constructor() {
    super(
      'Tenant station-control connection was released while creation was pending.',
    );
  }
}
const nativeStationControlPools = new Map<
  MCPLocalConnectionCustody,
  Map<string, NativeConnectionEntry>
>();

async function retireNativeStationControlPools(
  owner?: MCPLocalConnectionCustody,
  tenantId?: string,
): Promise<void> {
  const settlements: Promise<unknown>[] = [];
  for (const [custody, pool] of nativeStationControlPools) {
    if (owner && custody !== owner) continue;
    const claims: MCPLocalClaim[] = [];
    const selected: Array<[string, NativeConnectionEntry]> = [];
    for (const [id, entry] of pool) {
      if (tenantId !== undefined && id !== tenantId) continue;
      entry.current = false; // Before cleanup or any await.
      claims.push(entry.claim);
      selected.push([id, entry]);
    }
    // Keep this owner reachable until its selected cleanup really settles.
    settlements.push(
      custody.releaseClaims(claims).then((cleanup) => {
        if (cleanup.state !== 'settled')
          throw new MCPLocalCustodyError(cleanup.state);
        for (const [id, entry] of selected)
          if (pool.get(id) === entry) pool.delete(id);
        if (!pool.size) nativeStationControlPools.delete(custody);
      }),
    );
  }
  const results = await Promise.allSettled(settlements);
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('Native station-control cleanup failed.');
}

export async function releaseNativeStationControlContext(
  context: TenantExecutionContext | undefined,
): Promise<void> {
  if (context)
    await retireNativeStationControlPools(undefined, context.tenantId);
}

/** Bounded local-handle retirement; not a process/descendant drain receipt. */
export async function releaseAllNativeStationControlConnections(
  owner?: MCPLocalConnectionCustody,
): Promise<void> {
  await retireNativeStationControlPools(owner);
}

async function nativeStationControlConnection(
  toolId: string,
  toolDef: ToolDef,
  resolvedEnv: Record<string, string> | undefined,
  custody: MCPLocalConnectionCustody,
): Promise<MCPConnection> {
  const context = currentTenantExecutionContext();
  if (!context) {
    if (!isHostedTenantExecutionRequired())
      throw new Error('No tenant-bound station-control connection is active.');
    throw new Error(
      'Tenant execution context is required for station-control.',
    );
  }
  let pool = nativeStationControlPools.get(custody);
  if (!pool) {
    pool = new Map();
    nativeStationControlPools.set(custody, pool);
  }
  const existing = pool.get(context.tenantId);
  if (existing?.current && existing.claim.isCurrent()) {
    if (existing.connection) return existing.connection;
    if (existing.creation) return existing.creation;
  }
  const claim = custody.acquire(toolId, 'native-control');
  const entry: NativeConnectionEntry = { current: true, claim };
  pool.set(context.tenantId, entry);
  entry.creation = Promise.resolve().then(async () => {
    try {
      const connection = await claim.connect(
        withResolvedMCPEnvironment(toolId, toolDef, resolvedEnv, context),
      );
      if (!entry.current || !claim.isCurrent())
        throw new NativeStationControlReleasedDuringCreationError();
      entry.connection = connection;
      return connection;
    } catch (error) {
      if (!entry.current)
        throw new NativeStationControlReleasedDuringCreationError();
      entry.current = false;
      await custody.release(claim);
      throw error;
    }
  });
  return entry.creation;
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
  provenanceGeneration: MCPToolProvenanceGeneration,
  logger: any,
  configLoader: ConfigLoader,
  serverPort: number,
  integrationSecretResolver: IntegrationSecretResolver | undefined,
  custody: MCPLocalConnectionCustody,
  claim: MCPLocalClaim,
  retain: () => void,
): Promise<Tool<any>[]> {
  const mcpKey = toolId;

  let mcpConfig: MCPConnection;
  let isNewConfig = false;

  // Check if MCP config already exists
  if (mcpConfigs.has(mcpKey)) {
    mcpConfig = mcpConfigs.get(mcpKey)!;
    if (mcpConfig.isUsable?.() === false)
      throw new MCPLocalCustodyError('stale');
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
          claim.connect(
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
      const currentDefinition = await configLoader.loadIntegration(toolId);
      if (
        !claim.isCurrent() ||
        !sameMCPConnectionDefinition(toolDef, currentDefinition)
      )
        throw new MCPLocalCustodyError('stale');
      const concurrent = mcpConfigs.get(mcpKey);
      if (concurrent && concurrent !== mcpConfig) {
        const cleanup = await custody.release(claim);
        if (cleanup.state !== 'settled' || concurrent.isUsable?.() === false)
          throw new MCPLocalCustodyError(
            cleanup.state === 'failed' ? 'failed' : 'stale',
          );
        mcpConfig = concurrent;
      } else {
        mcpConfigs.set(mcpKey, mcpConfig);
        retain();
      }
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
  const loadedTools = mcpConfig.tools
    .filter((tool) => isMCPAppsToolVisibleTo(tool, 'model'))
    .map((tool) =>
      toStationMCPTool(
        mcpConfig,
        tool,
        logger,
        isNativeStationControl,
        isNativeStationControl
          ? async (args) => {
              if (mcpConfig.isUsable?.() === false)
                throw new MCPLocalCustodyError('stale');
              const connection = currentTenantExecutionContext()
                ? await nativeStationControlConnection(
                    toolId,
                    toolDef,
                    undefined,
                    custody,
                  )
                : isHostedTenantExecutionRequired()
                  ? await nativeStationControlConnection(
                      toolId,
                      toolDef,
                      undefined,
                      custody,
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
  const loaderIdentities = new Map(
    loadedTools.map((loaded, index) => {
      const source = mcpConfig.tools.filter((tool) =>
        isMCPAppsToolVisibleTo(tool, 'model'),
      )[index]!;
      return [
        loaded,
        { serverId: source.serverId, originalToolName: source.originalName },
      ] as const;
    }),
  );

  // Normalize tool names for Nova compatibility and store mapping with parsed data
  const normalizedTools = normalizeLoadedMCPTools(
    agentSlug,
    loadedTools,
    toolNameMapping,
    toolNameReverseMapping,
    provenanceGeneration,
    toolId,
    (tool) => {
      const identity = loaderIdentities.get(tool);
      if (!identity) throw new Error('Missing reviewed MCP loader identity.');
      return identity;
    },
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
 * How far a per-tool load got before it threw.
 *
 * `connect` is the phase that may have spoken to a tool server, so only
 * `connect` can be carrying remote text. The flip is deliberately EARLY — it
 * happens before `createMCPTools`, which still does Station-owned work (secret
 * binding resolution, child environment assembly, client construction) before
 * it reaches the wire, and it stays set through the post-`listTools` wrapping —
 * so Station-owned failures in those stretches still report as connection
 * failures. This distinction narrows the mislabelled population to the paths
 * that never reach a server at all (built-in vended tools, custody acquisition,
 * config loading, the kind dispatch); it does not close the class. Tightening
 * it needs a phase the callee can advance, not a moved assignment.
 */
type AgentToolLoadPhase = 'preconnect' | 'connect';

/**
 * Write a failure status for an integration whose load threw (#1486).
 *
 * Before this, the per-tool catch wrote nothing, so `GET /agents/:slug/health`
 * kept serving whatever the previous load left behind — a success from an
 * earlier reload, or nothing at all. Every failed iteration now leaves a
 * `{ connected: false }` entry.
 *
 * The one status this does NOT overwrite is a failure THIS iteration already
 * recorded: `createMCPTools` classifies at the connect seam, where it still has
 * the original error and can say "did not respond in time" rather than the
 * generic reachability line the catch would recompose from the wrapped
 * `ToolServerOperationError`. Identity against the entry observed at the top of
 * the iteration is what separates that from a stale entry.
 */
function recordFailedToolLoadStatus(
  mcpConnectionStatus: Map<string, { connected: boolean; error?: string }>,
  toolId: string,
  statusAtEntry: { connected: boolean; error?: string } | undefined,
  status: { connected: boolean; error?: string },
): void {
  const recorded = mcpConnectionStatus.get(toolId);
  const recordedThisIteration =
    recorded !== statusAtEntry && recorded?.connected === false;
  if (recordedThisIteration) return;
  mcpConnectionStatus.set(toolId, status);
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
  provenanceGeneration: MCPToolProvenanceGeneration,
  integrationSecretResolver: IntegrationSecretResolver | undefined,
  custody: MCPLocalConnectionCustody,
): Promise<Tool<any>[]> {
  const tools: Tool<any>[] = [];

  if (!spec.tools?.mcpServers || spec.tools.mcpServers.length === 0) {
    return tools;
  }

  // Load each MCP server from catalog
  for (const entry of spec.tools.mcpServers) {
    let claim: MCPLocalClaim | undefined;
    let retained = false;
    // #1486: everything up to the `createMCPTools` call is Station's own code
    // and configuration. The built-in vended-tool branch never leaves this
    // phase, so a throw from it cannot be a connection outcome.
    let phase: AgentToolLoadPhase = 'preconnect';
    // Identity of the entry as this iteration began. `createMCPTools` records
    // its own, more specific failure status at the connect seam; comparing
    // identity is how the catch tells that apart from a status left over by an
    // EARLIER load, which is the staleness this fix exists to end.
    const statusAtEntry = mcpConnectionStatus.get(entry);
    try {
      const toolId = entry;
      claim = custody.acquire(toolId, 'managed');
      const toolDef = await configLoader.loadIntegration(entry);
      if (!claim.isCurrent()) throw new MCPLocalCustodyError('stale');

      if (toolDef.enabled === false) {
        mcpConnectionStatus.set(toolId, { connected: false });
        continue;
      }

      if (toolDef.kind === 'mcp') {
        // From here on this iteration may talk to a tool server, and every
        // value it handles may be derived from that server's response.
        // Whatever throws below keeps the redacted connection vocabulary.
        phase = 'connect';
        const mcpTools = await createMCPTools(
          agentSlug,
          toolId,
          toolDef,
          mcpConfigs,
          mcpConnectionStatus,
          integrationMetadata,
          toolNameMapping,
          toolNameReverseMapping,
          provenanceGeneration,
          logger,
          configLoader,
          serverPort,
          integrationSecretResolver,
          custody,
          claim,
          () => {
            retained = true;
          },
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
      if (phase === 'preconnect' && isLoaderProgrammingFailure(error)) {
        // Never connected, and the shape is one only Station's own code or
        // configuration produces: report the real class, do not assert a
        // connection outcome that was never observed (#1486).
        const { detail, messageWithheld } = describeLoaderFailure(error);
        logger.error('Failed to load agent tool before any connection', {
          agent: agentSlug,
          toolId: entry,
          failure: 'loader',
          errorClass: loaderErrorClass(error),
          messageWithheld,
          // Withheld means withheld: `error.stack` opens with the message, so
          // the object itself cannot ride into the log store either.
          ...(messageWithheld ? {} : { error }),
        });
        recordFailedToolLoadStatus(mcpConnectionStatus, entry, statusAtEntry, {
          connected: false,
          error: detail,
        });
      } else {
        const errorClass = classifyMCPError(error);
        const publicError = publicMCPConnectionError(entry, errorClass);
        logger.error('Failed to load tool', {
          agent: agentSlug,
          toolId: entry,
          errorClass,
          error: publicError,
        });
        recordFailedToolLoadStatus(mcpConnectionStatus, entry, statusAtEntry, {
          connected: false,
          error: publicError,
        });
      }
    } finally {
      if (claim && !retained) await custody.release(claim);
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
