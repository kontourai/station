import {
  type AgentSpec,
  BUILTIN_STATION_AGENT_MCP_SERVER_IDS,
} from '@kontourai/station-contracts/agent';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  type BuiltinAgentEngineBinding,
  engineControlPlaneCapability,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import type { UsageAggregator } from '../../analytics/usage-aggregator.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import { getAgentPolicyService } from '../../services/agents/agent-policy-service.js';
import type { ApprovalGuardianService } from '../../services/approvals/approval-guardian.js';
import type { MCPToolProvenanceGeneration } from '../../services/orchestration/mcp-tool-provenance.js';
import type { Logger } from '../../utils/logger.js';
import { BUILTIN_STATION_DOCS_TOOL_SERVER_ID } from '../bootstrap/station-control-runtime-env.js';
import type { MCPToolNameMappingEntry } from '../tools/mcp-tool-names.js';
import type { IAgentFramework } from '../types.js';
import type { WorkItemCapture } from '../work-item-capture.js';
import type { AgentHooksDeps } from './agent-hooks.js';
import { createAgentHooks } from './agent-hooks.js';

interface RuntimeDefaultAgentContext {
  appConfig: AppConfig;
  configLoader: ConfigLoader;
  framework: IAgentFramework;
  logger: Logger;
  usageAggregator?: UsageAggregator;
  defaultSystemPrompt: string;
  autoApproveTools: string[];
  replaceTemplateVariables: (text: string) => string;
  resolveDefaultModelHint: () => string | null;
  createModel: (spec: AgentSpec) => Promise<any>;
  loadAgentTools: (
    slug: string,
    spec: AgentSpec,
    provenanceGeneration: MCPToolProvenanceGeneration | undefined,
  ) => Promise<any[]>;
  /** Runtime-owned generation forwarded to the default-agent startup loader. */
  mcpToolProvenanceGeneration?: MCPToolProvenanceGeneration;
  guardTools?: (tools: any[]) => any[];
  activeAgents: Map<string, any>;
  agentTools: Map<string, any[]>;
  memoryAdapters: Map<string, FileMemoryAdapter>;
  agentMetadataMap: Map<string, any>;
  /**
   * archive#1834: hook-construction inputs for the default agent's tool gate.
   * Optional so both bootstrap paths can pass what they have; safe empty
   * defaults are used otherwise. `agentHooksMap` registration is what lets
   * interactive chat streams register a conversation-scoped approval
   * requester for `default` — without it every non-autoApproved tool would
   * fail closed even with a user present to ask.
   */
  toolNameMapping?: Map<string, MCPToolNameMappingEntry>;
  agentFixedTokens?: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  >;
  agentHooksMap?: Map<string, ReturnType<typeof createAgentHooks>>;
  /**
   * archive#1834 review round 2: the guardian the default agent's gate
   * consults, matching what persisted agents get from
   * `runtime-agent-builder.ts`. Present ⇒ wired; both production bootstrap
   * paths construct it from the same runtime services the builder uses.
   */
  approvalGuardian?: ApprovalGuardianService;
  /** Optional so isolated bootstrap callers retain the existing fail-closed behavior. */
  resolveUnattendedGrant?: AgentHooksDeps['resolveUnattendedGrant'];
  /**
   * archive#1194 (epic archive#1191, slice B): the resolved engine binding for the
   * built-in default agent, from the onboarding engine picker (or the
   * unchosen sensible default) — `null`/absent means Station's own engine,
   * byte-identical to this function's pre-#1194 behavior. Resolved by the
   * caller (`resolveBuiltinAgentEngineBinding`) against the LIVE ready-
   * connections list, so this function stays a pure "what do I do with this
   * binding" decision.
   */
  builtinEngineBinding?: BuiltinAgentEngineBinding | null;
  workItemCapture?: WorkItemCapture;
}

/**
 * archive#3063: the PERSISTED shape of the built-in station-control
 * integration — deliberately instance-INDEPENDENT. No `command`, no `args`,
 * no `env`: those are the running instance's spawn identity, resolved fresh
 * at load time by `ConfigLoader`'s builtin-runtime-identity overlay
 * (`stationControlRuntimeIdentity`, station-control-runtime-env.ts).
 *
 * Baking them into the file is what caused the archive#3063 cross-process reload
 * loop: two servers sharing one home (desktop app + launchd service) each
 * rewrote the file with their OWN dist path and port on every reload, and
 * each write retriggered the other process's config watcher — bytes that
 * can never converge, so the archive#1588 byte-identical save skip never engaged.
 * With this shape, both instances derive byte-identical files and a
 * converged home sees zero writes.
 */
export function createRuntimeSelfIntegration() {
  const selfIntegrationId = 'station-control';

  return {
    selfIntegrationId,
    selfIntegration: {
      id: selfIntegrationId,
      displayName: 'Station Control',
      description:
        'Manage agents, skills, integrations, and jobs via natural language',
      kind: 'mcp' as const,
      transport: 'stdio' as const,
    },
  };
}

/**
 * archive#1547: the built-in `station-docs` tool server.
 *
 * Note what this factory does NOT take and does NOT return: no `port`, and no
 * `env` key at all. That absence is load-bearing, not an oversight —
 * `session-agent-resolution.ts` rejects any tool server declaring a non-empty
 * `env` as `secret-boundary-env` on every channel, so declaring none is
 * exactly what lets this server be delivered to every engine, including the
 * ACP/wire engines that can never receive `station-control`.
 *
 * `runtime-default-agent.test.ts` pins that emptiness against this factory's
 * real output AND against `stationDocsRuntimeIdentity` (the load-time
 * overlay that now carries `command`/`args` — archive#3063). If a future
 * change needs a credential here, that test fails on purpose: this stops
 * being a credential-free docs server and becomes a different feature
 * needing a different security review.
 *
 * archive#3063: like `createRuntimeSelfIntegration` above, this is the
 * PERSISTED, instance-independent shape — `command`/`args` (the running
 * instance's dist path) moved into the load-time overlay so the file's
 * bytes are identical no matter which co-homed instance wrote them.
 */
export function createRuntimeDocsIntegration() {
  const docsIntegrationId = BUILTIN_STATION_DOCS_TOOL_SERVER_ID;

  return {
    docsIntegrationId,
    docsIntegration: {
      id: docsIntegrationId,
      displayName: 'Station Docs',
      description:
        'Read-only Station documentation — explains how Station works. Cannot read or change your Station.',
      kind: 'mcp' as const,
      transport: 'stdio' as const,
    },
  };
}

/**
 * archive#3063: writes the two built-in integration definitions
 * (`station-control`, `station-docs`) to the home's `integrations/` root in
 * their instance-independent persisted shape.
 *
 * Call sites, and the discipline they encode:
 *  - BOOT (`runtime-initialize.ts`, before the first agent construction):
 *    unconditional. `ConfigLoader.saveIntegration`'s byte-identical skip
 *    makes this a zero-write no-op on a converged home; a home carrying the
 *    pre-#3063 identity-baked schema is rewritten ONCE to the stable form
 *    and then goes quiet.
 *  - RELOAD (`bootstrapRuntimeDefaultAgent`, i.e. inside every
 *    `reloadAgents()`): `onlyIfMissing` — existence-gated, never
 *    content-gated. A reload may only ever CREATE an absent file (self-heal
 *    after a user deletes one), because a write creates the file, so a
 *    reload-driven write loop is structurally impossible. This is the archive#1588
 *    anti-pattern fix: a reload must not mutate its own watched inputs.
 */
export async function materializeBuiltinIntegrations(
  configLoader: Pick<ConfigLoader, 'saveIntegration' | 'hasIntegration'>,
  options: { onlyIfMissing?: boolean } = {},
): Promise<void> {
  const { selfIntegrationId, selfIntegration } = createRuntimeSelfIntegration();
  const { docsIntegrationId, docsIntegration } = createRuntimeDocsIntegration();
  for (const [id, def] of [
    [selfIntegrationId, selfIntegration],
    [docsIntegrationId, docsIntegration],
  ] as const) {
    if (options.onlyIfMissing && (await configLoader.hasIntegration(id))) {
      continue;
    }
    await configLoader.saveIntegration(id, def);
  }
}

export async function bootstrapRuntimeDefaultAgent(
  context: RuntimeDefaultAgentContext,
): Promise<Record<string, any>> {
  // archive#1547: materialized BEFORE the external-engine early return below,
  // so an externally-bound built-in agent (which never builds a
  // Station-engine instance) still has a resolvable `station-docs` ToolDef
  // for `session-agent-resolution.ts` to deliver.
  //
  // archive#3063: existence-gated (`onlyIfMissing`). This function runs
  // inside every `reloadAgents()` — including the watcher-triggered ones —
  // and a reload that WRITES its own watched inputs is the archive#1588/#3063
  // reload-loop anti-pattern. The unconditional boot-time materialization
  // lives in `runtime-initialize.ts`; here we only self-heal a file a user
  // deleted mid-run, which is loop-safe because a write creates the file.
  await materializeBuiltinIntegrations(context.configLoader, {
    onlyIfMissing: true,
  });

  const binding = context.builtinEngineBinding ?? null;
  const builtinTools: AgentSpec['tools'] = {
    mcpServers: [...BUILTIN_STATION_AGENT_MCP_SERVER_IDS],
    autoApprove: context.autoApproveTools,
  };
  if (binding) {
    // archive#1194 (epic archive#1191, slice B): bound to an external engine via
    // the onboarding picker (or the sensible unchosen default) — Station's
    // own engine cannot execute another engine's identity, so this mirrors
    // the "no launchable model" skip below exactly (no VoltAgent instance,
    // no station-engine model resolution attempted), but the reason and the
    // resulting metadata are different: the binding is honestly recorded on
    // `agentMetadataMap` via `execution.agentConnectionId` (the same field
    // every other external-engine-bound agent record carries — archive#954)
    // so `GET /api/agents`'s `defaultSpec()` projection and every reader of
    // `resolveEngineCapabilityMatrix` classify this agent correctly, instead
    // of silently clobbering the user's choice back to "not configured".
    context.activeAgents.delete('default');
    context.agentTools.delete('default');
    context.memoryAdapters.delete('default');
    // archive#1834: drop the Station-engine gate too — a stale hooks entry
    // for an agent the external engine now owns would let chat streams
    // register requesters against an instance no agent consults.
    context.agentHooksMap?.delete('default');
    context.agentMetadataMap.set('default', {
      slug: 'default',
      name: 'Station',
      description: 'Default agent with full access to manage Station',
      updatedAt: new Date().toISOString(),
      tools: builtinTools,
      execution: { agentConnectionId: binding.connectionId },
    });
    context.logger.info(
      'Default agent bound to an external engine; Station-engine instance not built',
      {
        engineId: binding.matrix.engineId,
        // archive#1549: derive from the SAME two inputs the resolver used.
        // Passing the matrix alone would log 'observation-required' for a
        // connection that was bound because its observation said yes.
        capability: engineControlPlaneCapability(
          binding.matrix,
          binding.controlPlaneObservation,
        ),
      },
    );
    return {};
  }

  const defaultSpec = {
    model: context.resolveDefaultModelHint() ?? '',
    tools: builtinTools,
  } as AgentSpec;

  if (!defaultSpec.model?.trim()) {
    context.activeAgents.delete('default');
    context.agentTools.delete('default');
    context.memoryAdapters.delete('default');
    context.agentMetadataMap.delete('default');
    context.agentHooksMap?.delete('default');
    context.logger.info(
      'Default agent not registered because no launchable model is configured.',
    );
    return {};
  }

  const defaultModel = await context.createModel(defaultSpec);
  let defaultTools: any[] = [];

  try {
    defaultTools = await context.loadAgentTools(
      'default',
      defaultSpec,
      context.mcpToolProvenanceGeneration,
    );
    defaultTools = context.guardTools?.(defaultTools) ?? defaultTools;
    context.logger.info('Default agent tools loaded', {
      count: defaultTools.length,
    });
  } catch (error) {
    context.logger.warn(
      'Failed to load station-control tools for default agent',
      { error },
    );
  }

  // archive#914: one store, constructed once and shared. The agent used to be built
  // without a memory adapter while a *separate* `FileMemoryAdapter` was
  // registered under the same slug, so the agent wrote to the framework's own
  // in-process default while every read path (transcript, history, stats) went
  // to the registered adapter. `default` is not in `agentSpecs`, so its turns
  // were only reaching disk via the compensating temp-agent write that archive#914
  // removes — without this the built-in Station agent would persist nothing.
  const defaultMemoryAdapter = new FileMemoryAdapter({
    projectHomeDir: context.configLoader.getProjectHomeDir(),
    usageAggregator: context.usageAggregator,
  });

  // archive#1834: the default agent is the executor for every unattended
  // path (scheduler jobs, feedback analysis, global /invoke, the CLI), and
  // as a temp agent it used to carry NO beforeToolCall gate at all — any
  // tool it held executed unapproved. Build the real shared hooks with the
  // default spec's own autoApprove (the read-only station-control set), so
  // an unattended run can read but a mutating tool fails closed unless an
  // interactive requester (registered via agentHooksMap) approves it.
  const defaultHooks = createAgentHooks({
    spec: defaultSpec,
    appConfig: context.appConfig,
    configLoader: context.configLoader,
    agentFixedTokens: context.agentFixedTokens ?? new Map(),
    memoryAdapters: context.memoryAdapters,
    agentPolicyService: getAgentPolicyService(context.logger),
    approvalGuardian: context.approvalGuardian,
    resolveUnattendedGrant: context.resolveUnattendedGrant,
    toolNameMapping: context.toolNameMapping ?? new Map(),
    workItemCapture: context.workItemCapture,
    isCurrentRuntimeGeneration: (candidate) =>
      context.agentHooksMap?.get('default') === candidate,
    logger: context.logger,
  });

  const defaultAgent = await context.framework.createTempAgent({
    agentId: 'station',
    name: 'default',
    instructions: () =>
      context.replaceTemplateVariables(
        context.appConfig.systemPrompt || context.defaultSystemPrompt,
      ),
    model: defaultModel,
    tools: defaultTools,
    memoryAdapter: defaultMemoryAdapter,
    hooks: defaultHooks,
  });

  context.agentHooksMap?.set('default', defaultHooks);
  context.activeAgents.set('default', defaultAgent as any);
  context.agentTools.set('default', defaultTools);
  context.memoryAdapters.set('default', defaultMemoryAdapter);
  context.agentMetadataMap.set('default', {
    slug: 'default',
    name: 'Station',
    description: 'Default agent with full access to manage Station',
    updatedAt: new Date().toISOString(),
  });
  context.logger.info('Default agent created', {
    model: defaultSpec.model,
  });

  return { default: defaultAgent as any };
}
