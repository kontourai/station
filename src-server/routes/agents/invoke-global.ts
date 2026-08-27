import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { jsonSchema } from 'ai';
import { DEFAULT_MAX_STEPS } from '../../constants.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../domain/config-loader.js';
import { createAgentHooks } from '../../runtime/agents/agent-hooks.js';
import {
  captureRuntimeConfigurationLease,
  requireCurrentRuntimeConfiguration,
  requireStableRuntimeConfigurationAcross,
  runtimeConfigurationLeaseIsCurrent,
} from '../../runtime/plugins/runtime-configuration-lease.js';
import { createRuntimeModelSelection } from '../../runtime/plugins/runtime-provider-resolution.js';
import { guardRuntimeGenerationTools } from '../../runtime/tools/runtime-generation-tools.js';
import type { ITool, RuntimeContext } from '../../runtime/types.js';
import { getAgentPolicyService } from '../../services/agents/agent-policy-service.js';
import { INVOKE_GLOBAL_SERVICE_PRINCIPAL } from '../../services/identity/service-principals.js';
import {
  executeNativeInvocation,
  NativeInvocationIndeterminateError,
  NativeInvocationPartialError,
} from './native-invocation.js';

export async function invokeGlobalPrompt(
  ctx: RuntimeContext,
  payload: {
    prompt: string;
    schema: unknown;
    tools?: string[];
    maxSteps?: number;
    model?: string;
    structureModel?: string;
    system?: string;
  },
) {
  const configurationLease = captureRuntimeConfigurationLease(ctx);
  requireCurrentRuntimeConfiguration(ctx, configurationLease);
  const appConfig = ctx.appConfig;
  const {
    prompt,
    schema,
    tools: toolIds = [],
    maxSteps = DEFAULT_MAX_STEPS,
    model,
    structureModel,
    system,
  } = payload;

  const selectedTools =
    toolIds.length > 0
      ? (toolIds
          .map((id) => ctx.globalToolRegistry.get(id))
          .filter(Boolean) as ITool[])
      : [];
  const filteredTools = guardRuntimeGenerationTools(
    selectedTools,
    () =>
      configurationLease
        ? runtimeConfigurationLeaseIsCurrent(ctx, configurationLease)
        : false,
    (operation) =>
      requireStableRuntimeConfigurationAcross(
        ctx,
        configurationLease,
        operation,
      ),
  );

  const invokeModelId =
    model || appConfig.invokeModel || appConfig.defaultModel;
  const structureModelId =
    structureModel ||
    appConfig.structureModel ||
    invokeModelId ||
    appConfig.defaultModel;

  if (!invokeModelId) {
    throw new Error(
      'No invoke model configured. Set a default model or pass model explicitly.',
    );
  }
  const modelOptions = {
    framework: ctx.framework,
    appConfig,
    projectHomeDir: ctx.configLoader.getProjectHomeDir(),
    modelCatalog: ctx.modelCatalog,
    listProviderConnections: () =>
      ctx.providerService.listProviderConnections(),
  };
  const mainModel = (
    await createRuntimeModelSelection(
      {} as AgentSpec,
      invokeModelId,
      modelOptions,
    )
  ).model;
  requireCurrentRuntimeConfiguration(ctx, configurationLease);
  const fastModel = (
    await createRuntimeModelSelection(
      {} as AgentSpec,
      structureModelId,
      modelOptions,
    )
  ).model;
  requireCurrentRuntimeConfiguration(ctx, configurationLease);

  const resolvedDefault = appConfig.systemPrompt
    ? ctx.replaceTemplateVariables(appConfig.systemPrompt)
    : ctx.replaceTemplateVariables(DEFAULT_SYSTEM_PROMPT);

  // station#1834: an unattended invocation has no approval channel, so the
  // gate would deny every non-autoApproved tool. The authenticated caller
  // NAMING the tools in the request body is the consent artifact for this
  // invocation — treat that explicit list as the autoApprove grant. Policy
  // (config-protection) and the other gate checks still apply upstream of
  // the autoApprove match.
  const invokeHooks = createAgentHooks({
    spec: {
      name: 'invoke',
      prompt: '',
      tools: { autoApprove: filteredTools.map((tool) => tool.name) },
    } as AgentSpec,
    appConfig,
    configLoader: ctx.configLoader,
    agentFixedTokens: new Map(),
    memoryAdapters: new Map(),
    agentPolicyService: getAgentPolicyService(ctx.logger),
    toolNameMapping: ctx.toolNameMapping,
    logger: ctx.logger,
  });

  const tempAgent = await ctx.framework.createTempAgent({
    name: `invoke-${Date.now()}`,
    instructions: system || resolvedDefault,
    model: mainModel,
    tools: filteredTools,
    maxSteps,
    hooks: invokeHooks,
  });
  requireCurrentRuntimeConfiguration(ctx, configurationLease);

  const tempConversationId = `invoke-${Date.now()}`;
  const { value: textResult, runId } = await executeNativeInvocation(
    ctx.orchestrationEventStore.nativeInvocationStarter(),
    { kind: 'global-invoke', sourceId: 'global' },
    async () => {
      const generated = await tempAgent.generateText(prompt, {
        conversationId: tempConversationId,
        userId: INVOKE_GLOBAL_SERVICE_PRINCIPAL.id,
      });
      requireCurrentRuntimeConfiguration(ctx, configurationLease);
      return generated;
    },
  );

  if (!schema) {
    return {
      success: true,
      response: textResult.text,
      usage: textResult.usage,
      steps: textResult.steps?.length || 0,
      runId,
    };
  }

  let objectResult: {
    object: unknown;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  };
  let structureRunId: string;
  try {
    const structureAgent = await ctx.framework.createTempAgent({
      name: `invoke-structure-${Date.now()}`,
      instructions: 'Format the provided information as structured JSON.',
      model: fastModel || mainModel,
      tools: [],
      maxSteps: 1,
    });
    requireCurrentRuntimeConfiguration(ctx, configurationLease);

    const structured = await executeNativeInvocation(
      ctx.orchestrationEventStore.nativeInvocationStarter(),
      { kind: 'global-structure', sourceId: 'global' },
      async () => {
        const generated = await (
          structureAgent as {
            generateObject(
              prompt: string,
              schema: unknown,
              options: unknown,
            ): Promise<{
              object: unknown;
              usage?: {
                promptTokens?: number;
                completionTokens?: number;
                totalTokens?: number;
              };
            }>;
          }
        ).generateObject(
          `${textResult.text}\n\nFormat the above information as structured JSON.`,
          jsonSchema(schema),
          {
            conversationId: tempConversationId,
            userId: INVOKE_GLOBAL_SERVICE_PRINCIPAL.id,
          },
        );
        requireCurrentRuntimeConfiguration(ctx, configurationLease);
        return generated;
      },
    );
    objectResult = structured.value;
    structureRunId = structured.runId;
  } catch (error) {
    if (error instanceof NativeInvocationPartialError) throw error;
    if (error instanceof NativeInvocationIndeterminateError) {
      throw new NativeInvocationPartialError(
        runId,
        [error.runId],
        'indeterminate',
      );
    }
    throw new NativeInvocationPartialError(runId, [], 'not_started');
  }

  return {
    success: true,
    response: objectResult.object,
    usage: {
      promptTokens:
        (textResult.usage?.promptTokens || 0) +
        (objectResult.usage?.promptTokens || 0),
      completionTokens:
        (textResult.usage?.completionTokens || 0) +
        (objectResult.usage?.completionTokens || 0),
      totalTokens:
        (textResult.usage?.totalTokens || 0) +
        (objectResult.usage?.totalTokens || 0),
    },
    steps: textResult.steps?.length || 0,
    runId,
    relatedRunIds: [structureRunId],
  };
}
