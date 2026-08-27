import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { ReservedAgentIdentityError } from '../../domain/agent-registry.js';
import {
  captureRuntimeConfigurationLease,
  RuntimeConfigurationConflictError,
  requireCurrentRuntimeConfiguration,
  requireStableRuntimeConfigurationAcross,
} from '../../runtime/plugins/runtime-configuration-lease.js';
import { createRuntimeModelSelection } from '../../runtime/plugins/runtime-provider-resolution.js';
import { executeRuntimeGenerationToolWithinLease } from '../../runtime/tools/runtime-generation-tools.js';
import { isTrustedNativeStationControlTool } from '../../runtime/tools/tool-provenance.js';
import type { RuntimeContext } from '../../runtime/types.js';
import { requireToolServerResult } from '../../services/plugins/tool-server-oauth.js';
import { controlActions } from '../../telemetry/metrics.js';
import { isAuthError } from '../../utils/auth-errors.js';
import { errorMessage } from '../schemas/schemas.js';
import { executeNativeInvocation } from './native-invocation.js';
import { runtimeAgentKey } from './runtime-agent-identity.js';

interface ToolResult {
  content?: Array<{ text?: string }>;
  isError?: boolean;
  success?: boolean;
  error?: { message?: string | { message?: string } };
  response?: unknown;
  [key: string]: unknown;
}

function unwrapMCPResult(toolResult: unknown): unknown {
  const text = (toolResult as ToolResult)?.content?.[0]?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.content?.[0]?.text) {
        return JSON.parse(parsed.content[0].text);
      }
      return parsed;
    } catch (error) {
      console.debug('Failed to parse MCP result JSON:', error);
      return text;
    }
  }
  return toolResult;
}

export async function invokeAgent(
  ctx: RuntimeContext,
  slug: string,
  input: string,
  model: string | undefined,
  toolNames: string[] | undefined,
  schema: unknown,
) {
  const runtimeSlug = runtimeAgentKey(slug);
  const configurationLease = captureRuntimeConfigurationLease(ctx);
  requireCurrentRuntimeConfiguration(ctx, configurationLease);
  const agent = ctx.activeAgents.get(runtimeSlug);
  if (!agent) {
    return {
      response: Response.json(
        { success: false, error: 'Agent not found' },
        { status: 404 },
      ),
    };
  }

  let prompt = input;
  if (schema) {
    prompt = `${input}\n\nYou must return your response as valid JSON matching this exact schema:\n${JSON.stringify(schema, null, 2)}\n\nReturn ONLY the JSON object, no markdown formatting, no explanations.`;
  }

  const options: Record<string, unknown> = {};
  if (model) {
    const selection = await createRuntimeModelSelection(
      (ctx.agentSpecs.get(runtimeSlug) ?? {}) as AgentSpec,
      model,
      {
        framework: ctx.framework,
        appConfig: ctx.appConfig,
        projectHomeDir: ctx.configLoader.getProjectHomeDir(),
        modelCatalog: ctx.modelCatalog,
        listProviderConnections: () =>
          ctx.providerService.listProviderConnections(),
        dispatchEvidenceSource: ctx.dispatchEvidenceSource,
        logger: ctx.logger,
      },
    );
    options.model = selection.model;
  }

  if (toolNames && Array.isArray(toolNames)) {
    const agentTools = ctx.agentTools.get(runtimeSlug) || [];
    options.tools = agentTools.filter((tool) => toolNames.includes(tool.name));
  }

  requireCurrentRuntimeConfiguration(ctx, configurationLease);
  const { value: result, runId } = await executeNativeInvocation(
    ctx.orchestrationEventStore.nativeInvocationStarter(),
    { kind: 'agent-invoke', sourceId: runtimeSlug },
    async () => {
      const generated = await agent.generateText(prompt, options);
      requireCurrentRuntimeConfiguration(ctx, configurationLease);
      return generated;
    },
  );

  let response: unknown = result.text;
  if (schema && typeof result.text === 'string') {
    try {
      let jsonText = result.text.trim();
      const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonText = jsonMatch[1].trim();
      }
      response = JSON.parse(jsonText);
    } catch (error) {
      ctx.logger.warn('Failed to parse JSON response', {
        error,
        text: result.text,
      });
    }
  }

  return {
    response: Response.json({
      success: true,
      response,
      usage: result.usage,
      steps: result.steps,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      reasoning: result.reasoning,
      runId,
    }),
  };
}

export async function invokeAgentTool(
  ctx: RuntimeContext,
  slug: string,
  toolName: string,
  toolArgs: unknown,
  startTime: number,
  executionContext: { userId: string },
) {
  const configurationLease = captureRuntimeConfigurationLease(ctx);
  return requireStableRuntimeConfigurationAcross(ctx, configurationLease, () =>
    invokeAgentToolWithStableConfiguration(
      ctx,
      slug,
      toolName,
      toolArgs,
      startTime,
      executionContext,
    ),
  );
}

async function invokeAgentToolWithStableConfiguration(
  ctx: RuntimeContext,
  slug: string,
  toolName: string,
  toolArgs: unknown,
  startTime: number,
  executionContext: { userId: string },
) {
  const resolvedSlug = runtimeAgentKey(slug);
  const agent = ctx.activeAgents.get(resolvedSlug);
  if (!agent) {
    return Response.json(
      { success: false, error: 'Agent not found' },
      { status: 404 },
    );
  }

  const allTools = ctx.agentTools.get(resolvedSlug) || [];
  let tool = allTools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    const normalized = ctx.getNormalizedToolName(toolName);
    tool = allTools.find((candidate) => candidate.name === normalized);
  }
  if (!tool) {
    return Response.json(
      { success: false, error: `Tool ${toolName} not found` },
      { status: 404 },
    );
  }

  const toolStart = performance.now();
  const invokedToolName = ctx.getOriginalToolName?.(tool.name) || tool.name;
  const isControlTool = isTrustedNativeStationControlTool(tool);
  let toolResult: unknown;
  try {
    toolResult = await executeRuntimeGenerationToolWithinLease(
      tool,
      toolArgs,
      executionContext,
    );
    if (!isControlTool) {
      requireToolServerResult(
        toolResult,
        'tool-call',
        invokedToolName,
        ctx.logger,
      );
    } else {
      const result = toolResult as ToolResult;
      if (result?.isError === true) {
        const text = result.content?.find(
          (entry) => typeof entry.text === 'string' && entry.text.trim(),
        )?.text;
        throw new Error(text?.trim() || 'Tool call failed');
      }
    }
    if (isControlTool) {
      controlActions.add(1, {
        tool: invokedToolName,
        outcome: 'success',
        reason: 'completed',
      });
    }
  } catch (error) {
    if (isControlTool) {
      controlActions.add(1, {
        tool: invokedToolName,
        outcome: 'failure',
        reason: errorMessage(error).slice(0, 120) || 'tool_error',
      });
    }
    throw error;
  }
  const toolDuration = performance.now() - toolStart;

  return Response.json({
    success: true,
    response: unwrapMCPResult(toolResult),
    metadata: {
      toolDuration: Math.round(toolDuration),
      totalDuration: Math.round(performance.now() - startTime),
    },
  });
}

export function invokeErrorResponse(
  logger: RuntimeContext['logger'],
  message: string,
  error: unknown,
) {
  logger.error(message, { error });
  return Response.json(
    { success: false, error: errorMessage(error) },
    {
      status:
        error instanceof RuntimeConfigurationConflictError
          ? 409
          : error instanceof ReservedAgentIdentityError
            ? 400
            : isAuthError(error)
              ? 401
              : 500,
    },
  );
}
