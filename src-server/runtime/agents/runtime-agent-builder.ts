import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { Agent, type Tool } from '@voltagent/core';
import { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import type { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import { getAgentPolicyService } from '../../services/agents/agent-policy-service.js';
import type { SkillService } from '../../services/agents/skill-service.js';
import { ApprovalGuardianService } from '../../services/approvals/approval-guardian.js';
import type { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import type { MCPToolProvenanceGeneration } from '../../services/orchestration/mcp-tool-provenance.js';
import type { IntegrationSecretResolver } from '../../services/secrets/secret-binding-administration.js';
import type { Logger } from '../../utils/logger.js';
import type {
  AgentBundle,
  DispatchEvidenceSource,
  IAgentFramework,
} from '../types.js';
import type { WorkItemCapture } from '../work-item-capture.js';
import { type AgentHooksDeps, createAgentHooks } from './agent-hooks.js';

interface RuntimeAgentBuilderContext {
  agentSlug: string;
  appConfig: AppConfig;
  configLoader: ConfigLoader;
  framework: IAgentFramework;
  skillService: SkillService;
  logger: Logger;
  serverPort: number;
  integrationSecretResolver?: IntegrationSecretResolver;
  modelCatalog?: BedrockModelCatalog;
  usageAggregator?: any;
  listProviderConnections?: () => any[];
  /** Live connection evidence for Dispatch candidate grading. */
  dispatchEvidenceSource?: DispatchEvidenceSource;
  approvalRegistry: ApprovalRegistry;
  mcpConfigs: Map<string, any>;
  mcpCustody: MCPLocalConnectionCustody;
  mcpConnectionStatus: Map<string, { connected: boolean; error?: string }>;
  integrationMetadata: Map<
    string,
    { type: string; transport?: string; toolCount?: number }
  >;
  toolNameMapping: Map<
    string,
    {
      original: string;
      normalized: string;
      server: string | null;
      tool: string;
    }
  >;
  toolNameReverseMapping: Map<string, string>;
  mcpToolProvenanceGeneration: MCPToolProvenanceGeneration;
  memoryAdapters: Map<string, FileMemoryAdapter>;
  agentFixedTokens: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  >;
  agentTools: Map<string, Tool<any>[]>;
  globalToolRegistry: Map<string, Tool<any>>;
  agentHooksMap: Map<string, ReturnType<typeof createAgentHooks>>;
  agentSpecs: Map<string, AgentSpec>;
  isAgentHooksCurrent?: (
    agentSlug: string,
    hooks: ReturnType<typeof createAgentHooks>,
  ) => boolean;
  guardTools?: (tools: Tool<any>[]) => Tool<any>[];
  replaceTemplateVariables: (text: string, agentName?: string) => string;
  /** Optional for hook-only/test callers; production bootstrap supplies it. */
  resolveUnattendedGrant?: AgentHooksDeps['resolveUnattendedGrant'];
  workItemCapture?: WorkItemCapture;
}

export type RuntimeAgentPreparationState = Pick<
  RuntimeAgentBuilderContext,
  | 'agentFixedTokens'
  | 'agentHooksMap'
  | 'agentSpecs'
  | 'agentTools'
  | 'globalToolRegistry'
  | 'integrationMetadata'
  | 'mcpConfigs'
  | 'mcpConnectionStatus'
  | 'memoryAdapters'
  | 'mcpToolProvenanceGeneration'
  | 'toolNameMapping'
  | 'toolNameReverseMapping'
>;

export interface PreparedRuntimeAgentInstance {
  agent: Agent;
  bundle: AgentBundle;
  hooks: ReturnType<typeof createAgentHooks>;
  slug: string;
  spec: AgentSpec;
}

export async function buildRuntimeAgentInstance(
  context: RuntimeAgentBuilderContext,
): Promise<Agent> {
  const prepared = await prepareRuntimeAgentInstance(context);
  return activatePreparedRuntimeAgentInstance(prepared, context);
}

export async function prepareRuntimeAgentInstance(
  context: RuntimeAgentBuilderContext,
  preparationState: RuntimeAgentPreparationState = context,
): Promise<PreparedRuntimeAgentInstance> {
  const spec = await context.configLoader.loadAgent(context.agentSlug);

  const instructions = createRuntimeInstructions(
    spec,
    context.appConfig,
    context.skillService,
    context.replaceTemplateVariables,
  );

  const memoryAdapter = new FileMemoryAdapter({
    projectHomeDir: context.configLoader.getProjectHomeDir(),
    usageAggregator: context.usageAggregator,
  });

  const hooks = createAgentHooks({
    spec,
    appConfig: context.appConfig,
    configLoader: context.configLoader,
    modelCatalog: context.modelCatalog,
    listProviderConnections: context.listProviderConnections,
    agentFixedTokens: preparationState.agentFixedTokens,
    memoryAdapters: preparationState.memoryAdapters,
    approvalRegistry: context.approvalRegistry,
    approvalGuardian: new ApprovalGuardianService({
      appConfig: context.appConfig,
      framework: context.framework,
      listProviderConnections: context.listProviderConnections,
      logger: context.logger,
      modelCatalog: context.modelCatalog,
      projectHomeDir: context.configLoader.getProjectHomeDir(),
    }),
    agentPolicyService: getAgentPolicyService(context.logger),
    resolveUnattendedGrant: context.resolveUnattendedGrant,
    isCurrentRuntimeGeneration: context.isAgentHooksCurrent
      ? (candidate) =>
          context.isAgentHooksCurrent?.(
            context.agentSlug,
            candidate as ReturnType<typeof createAgentHooks>,
          ) === true
      : undefined,
    toolNameMapping: preparationState.toolNameMapping,
    workItemCapture: context.workItemCapture,
    logger: context.logger,
  });

  const bundle = await context.framework.createAgent(
    context.agentSlug,
    spec,
    {
      appConfig: context.appConfig,
      projectHomeDir: context.configLoader.getProjectHomeDir(),
      usageAggregator: context.usageAggregator,
      modelCatalog: context.modelCatalog,
      listProviderConnections: context.listProviderConnections,
      dispatchEvidenceSource: context.dispatchEvidenceSource,
      logger: context.logger,
      approvalRegistry: context.approvalRegistry,
      hooks,
    },
    {
      processedPrompt: instructions,
      memoryAdapter,
      configLoader: context.configLoader,
      mcpConfigs: preparationState.mcpConfigs,
      mcpCustody: context.mcpCustody,
      mcpConnectionStatus: preparationState.mcpConnectionStatus,
      integrationMetadata: preparationState.integrationMetadata,
      toolNameMapping: preparationState.toolNameMapping,
      toolNameReverseMapping: preparationState.toolNameReverseMapping,
      mcpToolProvenanceGeneration: preparationState.mcpToolProvenanceGeneration,
      approvalRegistry: context.approvalRegistry,
      agentFixedTokens: preparationState.agentFixedTokens,
      memoryAdapters: preparationState.memoryAdapters,
      logger: context.logger,
      serverPort: context.serverPort,
      integrationSecretResolver: context.integrationSecretResolver,
      guardTools: context.guardTools,
    },
  );

  const skillTool = context.skillService.getSkillTool(spec.skills);
  if (skillTool) {
    (bundle.tools as Tool<any>[]).push(skillTool as Tool<any>);
  }

  context.logger.info('[Agent Initialized]', {
    agent: context.agentSlug,
    runtime: context.appConfig.runtime || 'voltagent',
    ...bundle.fixedTokens,
    totalFixedTokens:
      bundle.fixedTokens.systemPromptTokens +
      bundle.fixedTokens.mcpServerTokens,
  });

  return {
    agent: ((bundle.agent as any).raw || bundle.agent) as Agent,
    bundle,
    hooks,
    slug: context.agentSlug,
    spec,
  };
}

export function activatePreparedRuntimeAgentInstance(
  prepared: PreparedRuntimeAgentInstance,
  context: RuntimeAgentBuilderContext,
): Agent {
  context.agentSpecs.set(prepared.slug, prepared.spec);
  applyRuntimeAgentBundle(
    prepared.slug,
    prepared.bundle,
    prepared.hooks,
    context,
  );
  return prepared.agent;
}

function createRuntimeInstructions(
  spec: AgentSpec,
  appConfig: AppConfig,
  skillService: SkillService,
  replaceTemplateVariables: (text: string, agentName?: string) => string,
): () => string {
  const rawSystemPrompt = appConfig.systemPrompt || '';
  const rawAgentPrompt = spec.prompt;
  const skillCatalog = skillService.getSkillCatalogPrompt(spec.skills);

  return () => {
    const parts = [
      rawSystemPrompt ? replaceTemplateVariables(rawSystemPrompt) : '',
      replaceTemplateVariables(rawAgentPrompt),
      skillCatalog,
    ].filter(Boolean);
    return parts.join('\n\n');
  };
}

function applyRuntimeAgentBundle(
  agentSlug: string,
  bundle: AgentBundle,
  hooks: ReturnType<typeof createAgentHooks>,
  context: RuntimeAgentBuilderContext,
): void {
  context.memoryAdapters.set(agentSlug, bundle.memoryAdapter);
  const agentTools = bundle.tools as Tool<any>[];

  context.agentTools.set(agentSlug, agentTools);
  context.agentFixedTokens.set(agentSlug, bundle.fixedTokens);
  context.agentHooksMap.set(agentSlug, hooks);

  for (const tool of agentTools) {
    if (!context.globalToolRegistry.has(tool.name)) {
      context.globalToolRegistry.set(tool.name, tool as Tool<any>);
    }
  }
}
