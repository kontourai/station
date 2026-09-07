import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  type MCPLocalClaim,
  type MCPLocalConnectionCustody,
  MCPLocalCustodyError,
} from '@kontourai/station-shared/mcp';
import { FunctionTool, McpClient } from '@strands-agents/sdk';
import { wrapPlatformMutationGatedTools } from '../../services/evidence/platform-mutation-gate.js';
import { createMCPToolProvenanceGeneration } from '../../services/orchestration/mcp-tool-provenance.js';
import {
  captureToolServerOperationFailure,
  requireToolServerResult,
} from '../../services/plugins/tool-server-oauth.js';
import { establishMcpSecretChild } from '../../services/secrets/mcp-secret-child-env.js';
import {
  currentTenantExecutionContext,
  isHostedTenantExecutionRequired,
} from '../bootstrap/runtime-tenant-context.js';
import {
  isBuiltinStationControl,
  withStationControlRuntimeEnv,
} from '../bootstrap/station-control-runtime-env.js';
import { sameMCPConnectionDefinition } from '../mcp/mcp-definition-currentness.js';
import { runWithCurrentNativeOutputCall } from '../native-output-turn-grant.js';
import {
  copyLoadedMCPToolProvenance,
  normalizeLoadedMCPTools,
} from '../tools/mcp-tool-names.js';
import { markTrustedNativeStationControlTool } from '../tools/tool-provenance.js';
import { createBuiltinVendedTool } from '../tools/vended-tool-compat.js';
import type { ITool, ToolCallDenial } from '../types.js';
import {
  createCustodiedStrandsClient,
  isStrandsClientCurrent,
} from './strands-mcp-custody.js';
import type { CreateAgentOptions } from './voltagent-adapter.js';

export interface StrandsToolLoaderState {
  mcpClients: Map<string, McpClient>;
  agentMcpClients: Map<string, string[]>;
}

type NativeClientEntry = {
  current: boolean;
  claim: MCPLocalClaim;
  client?: McpClient;
  creation?: Promise<McpClient>;
};
// This is a publication projection of the existing per-runtime custody owner.
const nativeStationControlPools = new Map<
  MCPLocalConnectionCustody,
  Map<string, NativeClientEntry>
>();

/** Bounded local SDK-handle retirement, never descendant/remote drain proof. */
export async function releaseAllNativeStationControlClients(
  owner?: MCPLocalConnectionCustody,
): Promise<void> {
  const settlements: Promise<unknown>[] = [];
  for (const [custody, pool] of nativeStationControlPools) {
    if (owner && custody !== owner) continue;
    const selected = [...pool];
    for (const [, entry] of selected) entry.current = false;
    settlements.push(
      custody
        .releaseClaims(selected.map(([, entry]) => entry.claim))
        .then((cleanup) => {
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

async function nativeStationControlClient(
  toolId: string,
  toolDef: any,
  custody: MCPLocalConnectionCustody,
): Promise<McpClient> {
  const context = currentTenantExecutionContext();
  if (!context) {
    if (!isHostedTenantExecutionRequired())
      throw new Error('No tenant-bound station-control client is active.');
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
    if (existing.client) return existing.client;
    if (existing.creation) return existing.creation;
  }
  const claim = custody.acquire(toolId, 'native-control');
  const entry: NativeClientEntry = { current: true, claim };
  pool.set(context.tenantId, entry);
  entry.creation = Promise.resolve().then(async () => {
    try {
      const client = createCustodiedStrandsClient(claim, {
        command: toolDef.command!,
        args: (toolDef.args || []).map((arg: string) =>
          arg === './' ? process.cwd() : arg,
        ),
        env: withStationControlRuntimeEnv(
          toolId,
          toolDef,
          { ...(process.env as Record<string, string>), ...toolDef.env },
          context,
        ) as Record<string, string>,
      });
      await client.connect();
      if (!entry.current || !claim.isCurrent())
        throw new Error(
          'Tenant station-control client was released while creation was pending.',
        );
      entry.client = client;
      return client;
    } catch (error) {
      if (!entry.current)
        throw new Error(
          'Tenant station-control client was released while creation was pending.',
        );
      entry.current = false;
      await custody.release(claim);
      throw error;
    }
  });
  return entry.creation;
}

// Exported so callers — tests included — bind to this contract by type
// rather than by an `as any` fixture. A required option added here must
// break their compilation, not silently take the loader's failure path.
export type StrandsToolLoadOptions = Pick<
  CreateAgentOptions,
  | 'configLoader'
  | 'mcpCustody'
  | 'mcpConnectionStatus'
  | 'integrationMetadata'
  | 'toolNameMapping'
  | 'toolNameReverseMapping'
  | 'mcpToolProvenanceGeneration'
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
            // archive#1834: surface the gate's REAL reason as a tool ERROR.
            // Throwing here is how every other tool failure surfaces —
            // FunctionTool.stream() catches and wraps it in a
            // `status: 'error'` ToolResultBlock. The old behavior returned a
            // fabricated "denied by the user" SUCCESS string, so unattended
            // runs completed as if the blocked tool had simply agreed.
            //
            // archive#3091: `denial.policyDenied` rides along on the thrown
            // Error as a custom own-property. Strands' own error handling
            // (`createErrorResult` in the installed SDK) holds the SAME
            // Error object reference on the resulting ToolResultBlock's
            // `.error` field rather than cloning it, so the marker survives
            // into `mapStrandsStreamEvent` unchanged — that's the carrying
            // seam this archive#3091 fix depends on.
            //
            // archive#3210: the authorship marker `stationComposedReason`
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
  const provenanceGeneration =
    opts.mcpToolProvenanceGeneration ?? createMCPToolProvenanceGeneration();

  for (const toolId of spec.tools.mcpServers) {
    let claim: MCPLocalClaim | undefined;
    let retained = false;
    try {
      claim = opts.mcpCustody.acquire(toolId, 'managed');
      const toolDef = await opts.configLoader.loadIntegration(toolId);
      if (!claim.isCurrent()) throw new MCPLocalCustodyError('stale');

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
            const fresh = createCustodiedStrandsClient(claim!, {
              command: toolDef.command!,
              args,
              env: withStationControlRuntimeEnv(toolId, toolDef, {
                ...(process.env as Record<string, string>),
                ...toolDef.env,
                ...resolvedSecrets,
              }) as Record<string, string>,
            });
            return { client: fresh, tools: await fresh.listTools() };
          },
        );
        client = established.client;
        mcpTools = established.tools;
        const current = await opts.configLoader.loadIntegration(toolId);
        if (
          !claim.isCurrent() ||
          !sameMCPConnectionDefinition(toolDef, current)
        )
          throw new MCPLocalCustodyError('stale');
        const concurrent = state.mcpClients.get(toolId);
        if (concurrent && concurrent !== client) {
          const cleanup = await opts.mcpCustody.release(claim);
          if (cleanup.state !== 'settled')
            throw new MCPLocalCustodyError(cleanup.state);
          client = concurrent;
          mcpTools = await client.listTools();
        } else {
          state.mcpClients.set(toolId, client);
          retained = true;
        }
      } else {
        mcpTools = await client.listTools();
      }
      const isNativeStationControl = isBuiltinStationControl(toolId, toolDef);

      const serverTools: ITool[] = [];
      for (const tool of mcpTools) {
        const [loadedIdentity] = normalizeLoadedMCPTools(
          slug,
          [{ name: tool.toolSpec.name }] as any,
          opts.toolNameMapping,
          opts.toolNameReverseMapping,
          provenanceGeneration,
          toolId,
          () => ({
            // Strands' client owns this loaded-tool list; the configured
            // integration is its exact client identity at this boundary.
            serverId: toolId,
            originalToolName: tool.toolSpec.name,
          }),
          opts.logger,
        );
        const normalized = loadedIdentity!.name;

        const stationTool = copyLoadedMCPToolProvenance(loadedIdentity, {
          name: normalized,
          description: tool.toolSpec.description,
          parameters: tool.toolSpec.inputSchema,
          ...extractStrandsToolUIMetadata(tool.toolSpec),
          execute: async (input: any) => {
            if (!isStrandsClientCurrent(client!))
              throw new MCPLocalCustodyError('stale');
            const activeClient = isNativeStationControl
              ? currentTenantExecutionContext() ||
                isHostedTenantExecutionRequired()
                ? await nativeStationControlClient(
                    toolId,
                    toolDef,
                    opts.mcpCustody,
                  )
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
        } as ITool);
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
    } finally {
      if (claim && !retained) await opts.mcpCustody.release(claim);
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

  const failures: unknown[] = [];
  for (const id of clientIds) {
    const client = state.mcpClients.get(id);
    if (!client) {
      continue;
    }
    try {
      await client.disconnect();
      if (state.mcpClients.get(id) === client) state.mcpClients.delete(id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new MCPLocalCustodyError('failed');
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
