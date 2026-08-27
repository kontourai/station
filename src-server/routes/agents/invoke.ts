import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { jsonSchema } from 'ai';
import { Hono } from 'hono';
import { DEFAULT_MAX_STEPS } from '../../constants.js';
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
import { resolveClientOriginForRequest } from '../../security/runtime-request-security.js';
import { getAgentPolicyService } from '../../services/agents/agent-policy-service.js';
import { chatRequests } from '../../telemetry/metrics.js';
import {
  errorMessage,
  getBody,
  globalInvokeSchema,
  invokeSchema,
  invokeStreamSchema,
  param,
  toolApprovalSchema,
  validate,
} from '../schemas/schemas.js';
import { getCachedUser } from '../system/auth.js';
import {
  invokeAgent,
  invokeAgentTool,
  invokeErrorResponse,
} from './invoke-agent.js';
import { invokeGlobalPrompt } from './invoke-global.js';
import {
  executeNativeInvocation,
  NativeInvocationIndeterminateError,
  NativeInvocationPartialError,
  NativeInvocationStorageUnavailableError,
} from './native-invocation.js';
import { runtimeAgentKey } from './runtime-agent-identity.js';

function nativeInvocationErrorResponse(
  ctx: RuntimeContext,
  message: string,
  error: unknown,
): Response {
  if (error instanceof NativeInvocationIndeterminateError) {
    return Response.json(
      {
        success: false,
        code: error.code,
        outcome: error.outcome,
        runId: error.runId,
        error:
          'The provider invocation may have started. Observe the run before retrying.',
      },
      { status: 409 },
    );
  }
  if (error instanceof NativeInvocationPartialError) {
    return Response.json(
      {
        success: false,
        code: error.code,
        outcome: error.outcome,
        runId: error.runId,
        relatedRunIds: error.relatedRunIds,
        structureOutcome: error.structureOutcome,
        error:
          'The primary invocation completed, but structured formatting did not complete. Observe the run before retrying.',
      },
      { status: 409 },
    );
  }
  if (error instanceof NativeInvocationStorageUnavailableError) {
    return Response.json(
      {
        success: false,
        code: error.code,
        error: 'The invocation record is temporarily unavailable.',
      },
      { status: 503 },
    );
  }
  return invokeErrorResponse(ctx.logger, message, error);
}

export function createInvokeRoutes(
  ctx: RuntimeContext,
  options: {
    /** Runtime composition mints this from immutable request ingress. */
    readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
  } = {},
) {
  const app = new Hono();

  // POST /agents/:slug/invoke — silent agent invocation
  app.post('/agents/:slug/invoke', validate(invokeSchema), async (c) => {
    try {
      const slug = param(c, 'slug');
      const { input, model, tools: toolNames, schema } = getBody(c);
      chatRequests.add(1, { op: 'invoke' });
      const { response } = await invokeAgent(
        ctx,
        slug,
        input,
        model,
        toolNames,
        schema,
      );
      return response;
    } catch (error: unknown) {
      return nativeInvocationErrorResponse(
        ctx,
        'Failed to invoke agent',
        error,
      );
    }
  });

  // POST /agents/:slug/tools/:toolName — raw MCP tool call
  app.post('/agents/:slug/tools/:toolName', async (c) => {
    const startTime = performance.now();
    try {
      const slug = param(c, 'slug');
      const toolName = param(c, 'toolName');
      const toolArgs = await c.req.json();
      return await invokeAgentTool(ctx, slug, toolName, toolArgs, startTime, {
        userId: getCachedUser().alias,
      });
    } catch (error: unknown) {
      return invokeErrorResponse(ctx.logger, 'Failed to call tool', error);
    }
  });

  // POST /agents/:slug/invoke/stream
  app.post(
    '/agents/:slug/invoke/stream',
    validate(invokeStreamSchema),
    async (c) => {
      try {
        const slug = param(c, 'slug');
        const runtimeSlug = runtimeAgentKey(slug);
        const {
          prompt,
          model,
          tools: toolNames,
          maxSteps = DEFAULT_MAX_STEPS,
          schema: schemaJson,
        } = getBody(c);
        chatRequests.add(1, { op: 'invoke_stream' });
        const configurationLease = captureRuntimeConfigurationLease(ctx);
        requireCurrentRuntimeConfiguration(ctx, configurationLease);
        const appConfig = ctx.appConfig;

        const agent = ctx.activeAgents.get(runtimeSlug);
        if (!agent)
          return c.json({ success: false, error: 'Agent not found' }, 404);

        const options: Record<string, unknown> & {
          maxSteps: number;
          maxOutputTokens: number;
        } = { maxSteps, maxOutputTokens: 2000 };
        if (model) {
          const selection = await createRuntimeModelSelection(
            (ctx.agentSpecs.get(runtimeSlug) ?? {}) as AgentSpec,
            model,
            {
              framework: ctx.framework,
              appConfig,
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
          const allTools = ctx.agentTools.get(runtimeSlug) || [];
          const filteredTools = guardRuntimeGenerationTools(
            allTools.filter((t) => toolNames.includes(t.name)) as ITool[],
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

          requireCurrentRuntimeConfiguration(ctx, configurationLease);
          // station#1834: unattended streaming invoke — no approval channel.
          // The authenticated caller NAMING the tools in the request is the
          // consent artifact for this invocation, so that explicit list is
          // the autoApprove grant; policy (config-protection) still applies
          // upstream of the autoApprove match.
          const invokeHooks = createAgentHooks({
            spec: {
              name: `${slug}-temp`,
              prompt: '',
              tools: {
                autoApprove: filteredTools.map(
                  (tool) => (tool as { name: string }).name,
                ),
              },
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
            name: `${slug}-temp`,
            instructions:
              (agent as { instructions?: string }).instructions || '',
            model: options.model || agent.model,
            tools: filteredTools as unknown as ITool[],
            maxSteps,
            hooks: invokeHooks,
          });
          requireCurrentRuntimeConfiguration(ctx, configurationLease);

          if (schemaJson) {
            const { value: textResult, runId } = await executeNativeInvocation(
              ctx.orchestrationEventStore.nativeInvocationStarter(),
              { kind: 'agent-invoke-stream', sourceId: runtimeSlug },
              async () => {
                const generated = await tempAgent.generateText(
                  `${prompt}\n\nReturn ONLY valid JSON matching this schema (no markdown, no explanation):\n${JSON.stringify(schemaJson, null, 2)}`,
                );
                requireCurrentRuntimeConfiguration(ctx, configurationLease);
                return generated;
              },
            );
            let parsed: unknown;
            try {
              const cleaned = textResult
                .text!.replace(/```json\n?/g, '')
                .replace(/```\n?/g, '')
                .trim();
              parsed = JSON.parse(cleaned);
            } catch (e) {
              console.debug('Failed to parse JSON from agent response:', e);
              const jsonMatch = textResult.text!.match(/\{[\s\S]*\}/);
              parsed = jsonMatch
                ? JSON.parse(jsonMatch[0])
                : { error: 'Failed to parse JSON' };
            }
            return c.json({
              success: true,
              response: parsed,
              usage: textResult.usage,
              runId,
            });
          }

          const { value: result, runId } = await executeNativeInvocation(
            ctx.orchestrationEventStore.nativeInvocationStarter(),
            { kind: 'agent-invoke-stream', sourceId: runtimeSlug },
            async () => {
              const generated = await tempAgent.generateText(prompt);
              requireCurrentRuntimeConfiguration(ctx, configurationLease);
              return generated;
            },
          );
          return c.json({
            success: true,
            response: result.text,
            usage: result.usage,
            runId,
          });
        }

        requireCurrentRuntimeConfiguration(ctx, configurationLease);
        const { value: result, runId } = await executeNativeInvocation(
          ctx.orchestrationEventStore.nativeInvocationStarter(),
          { kind: 'agent-invoke-stream', sourceId: runtimeSlug },
          async () => {
            const generated = schemaJson
              ? await agent.generateObject(
                  prompt,
                  jsonSchema(schemaJson) as unknown as Parameters<
                    typeof agent.generateObject
                  >[1],
                  options,
                )
              : await agent.generateText(prompt, options);
            requireCurrentRuntimeConfiguration(ctx, configurationLease);
            return generated;
          },
        );

        return c.json({
          success: true,
          response: schemaJson ? result.object : result.text,
          usage: result.usage,
          runId,
        });
      } catch (error: unknown) {
        return nativeInvocationErrorResponse(
          ctx,
          'Failed to stream invoke',
          error,
        );
      }
    },
  );

  // POST /tool-approval/:approvalId
  app.post(
    '/tool-approval/:approvalId',
    validate(toolApprovalSchema),
    async (c) => {
      try {
        const approvalId = param(c, 'approvalId');
        const { approved } = getBody(c);

        ctx.logger.info('[Approval Endpoint] Received approval response', {
          approvalId,
          approved,
        });

        if (
          ctx.approvalRegistry.resolveAuthorized(
            approvalId,
            approved,
            options.readAuthorityForRequest?.(c.req.raw),
            resolveClientOriginForRequest(c.req.raw),
          )
        ) {
          return c.json({ success: true });
        }

        ctx.logger.warn('[Approval Endpoint] Approval request not found', {
          approvalId,
        });
        return c.json(
          { success: false, error: 'Approval request not found' },
          404,
        );
      } catch (error: unknown) {
        ctx.logger.error('Approval response error', { error });
        return c.json({ success: false, error: errorMessage(error) }, 500);
      }
    },
  );

  // POST /invoke — global invoke using globalToolRegistry
  app.post('/invoke', validate(globalInvokeSchema), async (c) => {
    try {
      const {
        prompt,
        schema,
        tools: toolIds = [],
        maxSteps = DEFAULT_MAX_STEPS,
        model,
        structureModel,
        system,
      } = getBody(c);
      chatRequests.add(1, { op: 'invoke_global' });
      const response = await invokeGlobalPrompt(ctx, {
        prompt,
        schema,
        tools: toolIds,
        maxSteps,
        model,
        structureModel,
        system,
      });
      return c.json(response);
    } catch (error: unknown) {
      return nativeInvocationErrorResponse(ctx, 'Failed to invoke', error);
    }
  });

  return app;
}
