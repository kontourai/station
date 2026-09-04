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
  StationOwnedToolServerError,
  ToolServerOperationError,
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

/**
 * How far a per-tool load got before it threw.
 *
 * `connect` is the phase that has spoken to a tool server, so only `connect`
 * can be carrying remote text. The flip is deliberately EARLY — it happens
 * before `establishMcpSecretChild` / `withStationControlRuntimeEnv` /
 * `createCustodiedStrandsClient`, and it stays set through the post-`listTools`
 * normalization — so Station-owned failures in those stretches still report as
 * connection failures. This distinction narrows the mislabelled population to
 * the paths that never reach a server at all (built-in vended tools, disabled
 * and non-stdio integrations, custody acquisition, config loading); it does not
 * close the class. Tightening it needs a third phase, not a moved assignment.
 */
type StrandsToolLoadPhase = 'preconnect' | 'connect';

/**
 * #1485: the per-tool catch is the single failure seam for every phase of a
 * tool load, but only one of those phases connects to anything. Passing every
 * throw through `captureToolServerOperationFailure` relabels it
 * `Tool server connection failed` — a connection outcome asserted for a path
 * that never connected, which is what reported #1482's `TypeError` on the
 * built-in vended-tool branch as a tool-server failure.
 *
 * Redaction is the default and stays the default (#1428 routes genuine
 * provider/transport/auth failures here precisely so remote text never reaches
 * a log or `mcpConnectionStatus`). A throw escapes redaction only when BOTH:
 *
 *  1. it was raised before this iteration attempted a connection
 *     (`phase === 'preconnect'`) — every throw from the connect / listTools /
 *     callTool path stays redacted, whatever its class, because its message can
 *     be built from remote data; and
 *  2. its class is one the JavaScript runtime raises for a defect in the
 *     program itself, or the throw is not an `Error` at all
 *     (`LOADER_PROGRAMMING_ERROR_NAMES`, plus Node's `ERR_ASSERTION` code).
 *
 * Any other preconnect throw — a custody error, a `Tool '<id>' not found`
 * config-loader `Error`, anything already wearing Station's own bounded
 * vocabulary — keeps today's redacted message.
 */
const LOADER_PROGRAMMING_ERROR_NAMES = new Set([
  'AssertionError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

/**
 * Escaping redaction decides that the CLASS is safe to name. It does not
 * decide that the MESSAGE is, and for these it is not: their text is composed
 * from the data the loader was examining rather than from program text.
 *
 * `SyntaxError` is the live one. `configLoader.loadIntegration` runs preconnect
 * and reaches two unguarded `JSON.parse` calls on secret-bearing files —
 * `integration.json` (which can still hold plaintext legacy `env` values,
 * src-server/domain/config-loader-storage.ts) and the tool-server credential
 * store (plaintext secrets and OAuth tokens,
 * packages/shared/src/tool-server-credential-store.ts). V8 composes a
 * `SyntaxError` message from a WINDOW OF THE PARSED SOURCE, so a corrupt file
 * would publish secret fragments through `mcpConnectionStatus.error` into
 * `GET /agents/:slug/health` and into the log store. `AssertionError` composes
 * its message from the values compared, and a thrown non-`Error` IS a value.
 *
 * For these the class is surfaced and the text is dropped everywhere — status
 * AND log. Not "logged but redacted on egress": tool-server-oauth.ts records
 * that an earlier revision admitted raw error text to the debug logger on
 * exactly that theory and it did not hold, because `/api/diagnostics/logs`
 * serves those records to any authenticated diagnostics reader. `error.stack`
 * begins with `${name}: ${message}`, so the whole Error object is withheld too,
 * not just the message field.
 */
const LOADER_DATA_DERIVED_MESSAGE_NAMES = new Set([
  'AssertionError',
  'SyntaxError',
]);

/**
 * A surfaced detail is Station-composed but can quote a JavaScript runtime
 * message, so it is bounded and control characters are flattened before it
 * reaches a status map an HTTP response renders. The limit is the TOTAL
 * length, truncation marker included.
 */
const LOADER_FAILURE_DETAIL_LIMIT = 300;
const LOADER_FAILURE_TRUNCATION_MARK = '… (truncated)';

function loaderErrorClass(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor?.name || 'Error';
  }
  return `non-error:${typeof error}`;
}

/** How the surfaced detail names the throw when its text is withheld. */
function loaderFailureLabel(error: unknown): string {
  return error instanceof Error
    ? loaderErrorClass(error)
    : `Non-Error thrown (${typeof error})`;
}

function isLoaderProgrammingFailure(error: unknown): boolean {
  // A tool server reaches this seam by throwing an Error in every path this
  // loader has; a thrown non-Error is Station's own code failing to throw
  // properly. The classification does not lean on that being exhaustive — a
  // non-Error's text is withheld either way (see LOADER_DATA_DERIVED_*).
  if (!(error instanceof Error)) return true;
  // Already bounded, Station-owned vocabulary — capture returns these as-is.
  if (
    error instanceof ToolServerOperationError ||
    error instanceof StationOwnedToolServerError
  ) {
    return false;
  }
  if (LOADER_PROGRAMMING_ERROR_NAMES.has(loaderErrorClass(error))) return true;
  return (error as { code?: unknown }).code === 'ERR_ASSERTION';
}

function isLoaderMessageDataDerived(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return (
    LOADER_DATA_DERIVED_MESSAGE_NAMES.has(loaderErrorClass(error)) ||
    (error as { code?: unknown }).code === 'ERR_ASSERTION'
  );
}

function boundLoaderDetail(detail: string): string {
  if (detail.length <= LOADER_FAILURE_DETAIL_LIMIT) return detail;
  const head = detail.slice(
    0,
    LOADER_FAILURE_DETAIL_LIMIT - LOADER_FAILURE_TRUNCATION_MARK.length,
  );
  return `${head}${LOADER_FAILURE_TRUNCATION_MARK}`;
}

type LoaderFailureReport = {
  /** What `mcpConnectionStatus.error` receives. */
  detail: string;
  /** True when the throw's own text was dropped rather than surfaced. */
  messageWithheld: boolean;
};

function describeLoaderFailure(error: unknown): LoaderFailureReport {
  const label = loaderFailureLabel(error);
  if (isLoaderMessageDataDerived(error)) {
    return { detail: label, messageWithheld: true };
  }
  const message = error instanceof Error ? error.message : '';
  if (!message) return { detail: label, messageWithheld: false };
  // Control and format characters would otherwise ride a multi-line runtime
  // message into a single-line status field.
  const flattened = message.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  return {
    detail: boundLoaderDetail(`${label}: ${flattened}`),
    messageWithheld: false,
  };
}

type StrandsToolLoadOptions = Pick<
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
    // #1485: everything up to the connection attempt is Station's own code and
    // configuration. The built-in vended-tool branch never leaves this phase.
    let phase: StrandsToolLoadPhase = 'preconnect';
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

      // From here on this iteration talks to a tool server, and every value it
      // handles may be derived from that server's response. Whatever throws
      // below keeps #1428's redaction.
      phase = 'connect';
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
      if (phase === 'preconnect' && isLoaderProgrammingFailure(error)) {
        // Never connected, and the shape is one only Station's own code or
        // configuration produces: report the real class, do not assert a
        // connection outcome that was never observed (#1485).
        const { detail, messageWithheld } = describeLoaderFailure(error);
        opts.logger.error('Failed to load agent tool before any connection', {
          agent: slug,
          toolId,
          failure: 'loader',
          errorClass: loaderErrorClass(error),
          messageWithheld,
          // Withheld means withheld: `error.stack` opens with the message, so
          // the object itself cannot ride into the log store either.
          ...(messageWithheld ? {} : { error }),
        });
        opts.mcpConnectionStatus.set(toolId, {
          connected: false,
          error: detail,
        });
      } else {
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
