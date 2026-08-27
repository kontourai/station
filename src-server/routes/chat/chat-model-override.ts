import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import {
  captureRuntimeConfigurationLease,
  type RuntimeConfigurationLease,
  requireStableRuntimeConfigurationAcross,
  runtimeConfigurationLeaseIsCurrent,
} from '../../runtime/plugins/runtime-configuration-lease.js';
import {
  resolveBedrockConnectionAuth,
  resolveEffectiveBedrockRegion,
} from '../../runtime/plugins/runtime-provider-resolution.js';
import { guardRuntimeGenerationTools } from '../../runtime/tools/runtime-generation-tools.js';
import type { ITool, RuntimeContext } from '../../runtime/types.js';
import { errorMessage } from '../schemas/schemas.js';

type ModelOverrideResult = {
  agent: any;
  resolvedModelId?: string;
  status?: number;
  error?: string;
};

const overrideCreationFlights = new WeakMap<
  Map<string, any>,
  Map<string, Promise<ModelOverrideResult>>
>();

export async function resolveChatAgentModelOverride({
  ctx,
  slug,
  modelOverride,
  agent,
  providerConnection,
  configurationLease,
}: {
  ctx: RuntimeContext;
  slug: string;
  modelOverride?: string;
  agent: any;
  providerConnection?: ProviderConnectionConfig | null;
  configurationLease?: RuntimeConfigurationLease | null;
}): Promise<ModelOverrideResult> {
  if (!modelOverride) {
    return { agent };
  }

  if (!providerConnection) {
    return {
      agent,
      status: 400,
      error:
        'A configured provider connection is required for model overrides.',
    };
  }

  const lease = configurationLease ?? captureRuntimeConfigurationLease(ctx);
  if (!lease || !runtimeConfigurationLeaseIsCurrent(ctx, lease)) {
    return agentConfigurationConflict(agent);
  }
  const providerLaunchabilityRevision = lease.providerLaunchabilityRevision;
  const appConfigLaunchabilityRevision = lease.appConfigLaunchabilityRevision;
  const agentConfigurationRevision = lease.agentConfigurationRevision;
  let resolvedModel: string;
  const originalSpec = ctx.agentSpecs.get(slug);
  const originalTools = ctx.agentTools.get(slug);
  const appConfig = ctx.appConfig;
  const instructions = (agent as { instructions?: string }).instructions || '';
  const leaseIsCurrent = () => runtimeConfigurationLeaseIsCurrent(ctx, lease);
  try {
    if (providerConnection.type === 'bedrock') {
      const region = resolveEffectiveBedrockRegion(
        originalSpec ?? {},
        providerConnection,
        appConfig,
      );
      const auth = resolveBedrockConnectionAuth(providerConnection);
      // HIGH-4 (review fix round): ctx.modelCatalog is the process-global
      // catalog authenticated against the default credential chain — correct
      // for the chain-auth default path, but validating a model override
      // against a profile/api-key connection through it would silently
      // check the WRONG AWS account. A non-chain connection gets its own
      // freshly bound catalog instead (same pattern as
      // runtime-provider-resolution.ts's resolveManagedModelId).
      if (auth.authMode && auth.authMode !== 'chain') {
        const perConnectionCatalog = new BedrockModelCatalog(region, auth);
        try {
          resolvedModel =
            await perConnectionCatalog.resolveModelId(modelOverride);
        } finally {
          perConnectionCatalog.dispose();
        }
      } else {
        if (!ctx.modelCatalog) {
          throw new Error('Bedrock model catalog is not configured.');
        }
        const regionalCatalog =
          ctx.modelCatalog.forRegion?.(region) ?? ctx.modelCatalog;
        resolvedModel = await regionalCatalog.resolveModelId(modelOverride);
      }
    } else {
      resolvedModel = await ctx.providerService.resolveModelForProvider(
        providerConnection.id,
        modelOverride,
      );
    }
  } catch (validationError: unknown) {
    if (!leaseIsCurrent()) return agentConfigurationConflict(agent);
    ctx.logger.warn('Model override validation failed', {
      modelOverride,
      providerConnectionId: providerConnection.id,
      error: validationError,
    });
    return {
      agent,
      status: 400,
      error: `Invalid model ID: ${modelOverride}. Please select a valid model from the list.`,
    };
  }

  if (!leaseIsCurrent()) return agentConfigurationConflict(agent);
  const cacheKey = `${slug}:${providerConnection.id}:${resolvedModel}:${providerLaunchabilityRevision}:${appConfigLaunchabilityRevision}:${agentConfigurationRevision}`;
  const cachedAgent = ctx.activeAgents.get(cacheKey);
  if (cachedAgent) {
    return { agent: cachedAgent, resolvedModelId: resolvedModel };
  }

  let flights = overrideCreationFlights.get(ctx.activeAgents);
  if (!flights) {
    flights = new Map();
    overrideCreationFlights.set(ctx.activeAgents, flights);
  }
  const inFlight = flights.get(cacheKey);
  if (inFlight) return inFlight;

  const creation = (async (): Promise<ModelOverrideResult> => {
    try {
      // Build the model through the common, provider-agnostic createModel()
      // factory (ai-sdk for Ollama/OpenAI-compat, Strands/Bedrock for Bedrock)
      // instead of hardcoding Bedrock. The resolved connection is pinned via
      // execution.modelConnectionId so multi-connection setups pick the right one.
      const model = await ctx.framework.createModel(
        {
          ...(originalSpec ?? {}),
          model: resolvedModel,
          execution: {
            ...(originalSpec?.execution ?? {}),
            modelId: resolvedModel,
            modelConnectionId: providerConnection.id,
          },
        } as AgentSpec,
        {
          appConfig,
          projectHomeDir: ctx.configLoader.getProjectHomeDir(),
          modelCatalog: ctx.modelCatalog,
          listProviderConnections: () =>
            ctx.providerService.listProviderConnections(),
          dispatchEvidenceSource: ctx.dispatchEvidenceSource,
          logger: ctx.logger,
        },
      );

      if (!leaseIsCurrent()) return agentConfigurationConflict(agent);

      const guardedTools = guardRuntimeGenerationTools(
        (originalTools ?? []) as unknown as ITool[],
        leaseIsCurrent,
        (operation) =>
          requireStableRuntimeConfigurationAcross(ctx, lease, operation),
      );
      const tempWrapper = await ctx.framework.createTempAgent({
        name: cacheKey,
        instructions,
        model,
        tools: guardedTools,
        // #914: this rebuilds the agent for a session model override on an
        // *existing* conversation, so without the slug's own store the
        // override silently costs the user their history.
        memoryAdapter: ctx.memoryAdapters?.get(slug),
        // station#1834: the rebuilt agent keeps the slug's OWN gate — the
        // same hooks instance chat streams register approval requesters on,
        // so interactive approvals keep working under a model override
        // instead of the tools running ungated.
        hooks: ctx.agentHooksMap?.get(slug),
      });
      const resolvedAgent =
        ((tempWrapper as { raw?: unknown }).raw as typeof agent) || tempWrapper;

      if (!leaseIsCurrent()) return agentConfigurationConflict(agent);

      const cachePrefix = `${slug}:`;
      for (const key of ctx.activeAgents.keys()) {
        if (key !== cacheKey && key.startsWith(cachePrefix)) {
          ctx.activeAgents.delete(key);
        }
      }
      ctx.activeAgents.set(cacheKey, resolvedAgent);
      ctx.logger.info('Created agent with model override', {
        slug,
        modelOverride,
        providerConnectionId: providerConnection.id,
        resolvedModel,
      });

      return { agent: resolvedAgent, resolvedModelId: resolvedModel };
    } catch (modelError: unknown) {
      if (!leaseIsCurrent()) return agentConfigurationConflict(agent);
      ctx.logger.error('Failed to create agent with model override', {
        slug,
        modelOverride,
        error: modelError,
      });
      return {
        agent,
        status: 500,
        error: `Failed to switch to model ${modelOverride}: ${errorMessage(modelError)}`,
      };
    }
  })();
  flights.set(cacheKey, creation);
  try {
    return await creation;
  } finally {
    if (flights.get(cacheKey) === creation) flights.delete(cacheKey);
  }
}

function agentConfigurationConflict(agent: any): ModelOverrideResult {
  return {
    agent,
    status: 409,
    error:
      'Agent or model configuration changed during the request. Retry the request.',
  };
}
