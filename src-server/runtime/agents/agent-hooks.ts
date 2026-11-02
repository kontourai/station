import { mcpToolApprovalKey } from '@kontourai/station-shared/mcp-tool-selection';

/**
 * Framework-agnostic agent lifecycle hooks.
 *
 * These implement the BUSINESS LOGIC for tool approval, usage tracking,
 * and conversation stats. They work with IAgent/IMemory/ITool — no
 * framework imports. Each adapter wires them into its native hook system.
 *
 * This file replaces the VoltAgent-specific hook logic that was in
 * tool-executor.ts createToolApprovalHooks().
 */

import { currentAgentTurn } from '@kontourai/agent-runtime';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import type { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import type { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import { resolveBedrockRegion } from '../../providers/llm/bedrock-region.js';
import type { AgentPolicyService } from '../../services/agents/agent-policy-service.js';
import { extractToolFilePath } from '../../services/agents/agent-policy-service.js';
import type { ApprovalGuardianService } from '../../services/approvals/approval-guardian.js';
import type { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { recordPersonApprovedCall } from '../../services/plugins/mediated-untrusted-content-gate.js';
import {
  sharedUntrustedContentLedger,
  type UntrustedContentLedger,
  untrustedContentDecision,
} from '../../services/plugins/untrusted-content-policy.js';
import { toolDenials } from '../../telemetry/metrics.js';
import { findModelPricing } from '../../utils/pricing.js';
import { currentMcpPromptOrigin } from '../conversation/authorized-turn-correlation.js';
import {
  buildConversationStatsUpdate,
  calculateUsageCost,
  getMessageTextContent,
} from '../conversation/usage-stats.js';
import { resolveManagedModelIdentity } from '../plugins/runtime-provider-resolution.js';
import type { MCPToolNameMappingEntry } from '../tools/mcp-tool-names.js';
import { isAuthoredToolPatternMatch } from '../tools/tool-approval.js';
import {
  isAutoApproved,
  isIntrinsicStationEngineGrant,
} from '../tools/tool-executor.js';
import type {
  IAgentHooks,
  InvocationContext,
  TokenUsage,
  ToolCallContext,
  UnattendedGrantResolution,
} from '../types.js';
import type { WorkItemCapture } from '../work-item-capture.js';
import { stationDenial } from './denial-message.js';
import { createStagedPreToolPolicyEvaluator } from './pre-tool-policy.js';

// ── Hook factory dependencies ──────────────────────────

export interface AgentHooksDeps {
  /** Exact model-step context measurement; never an invocation billing total. */
  observeModelContext?: NonNullable<IAgentHooks['afterModelGeneration']>;
  projectToolPolicy?: (
    invocation: InvocationContext,
    tool: ToolCallContext,
  ) => void;
  spec: AgentSpec;
  appConfig: AppConfig;
  configLoader: ConfigLoader;
  modelCatalog?: BedrockModelCatalog;
  listProviderConnections?: () => ProviderConnectionConfig[];
  agentFixedTokens: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  >;
  memoryAdapters: Map<string, FileMemoryAdapter>;
  /** Unused by the factory itself; optional so hook-only callers (e.g. the
   * default temp agent bootstrap) need not thread a service nothing reads. */
  approvalRegistry?: ApprovalRegistry;
  approvalGuardian?: ApprovalGuardianService;
  /**
   * Flow Agents policy enforcement (S3). Managed agents are the only runtime
   * kind where Station owns tool dispatch, so this is the pre-execution seam
   * for the blocking config-protection policy and the post-write seam for
   * the quality-gate policy. Fail-open: no service, no behavior change.
   */
  agentPolicyService?: AgentPolicyService;
  /**
   * Reject tool execution when this hook instance no longer belongs to the
   * stable, currently published runtime generation.
   */
  isCurrentRuntimeGeneration?: (hooks: IAgentHooks) => boolean;
  /**
   * archive#1859 seam: resolve a standing grant for an UNATTENDED invocation —
   * one with no interactive approval channel (scheduler, `/invoke`, CLI).
   * Absent ⇒ deny: the seam itself is fail-closed, and nothing supplies it
   * yet. Returning `true` allows the call; anything else denies it.
   */
  resolveUnattendedGrant?: (
    tool: ToolCallContext,
    invocation: InvocationContext,
  ) => Promise<UnattendedGrantResolution>;
  toolNameMapping: Map<string, MCPToolNameMappingEntry>;
  workItemCapture?: WorkItemCapture;
  /** #3483: defaults to the ledger shared by every Agent's hooks. */
  untrustedContentLedger?: UntrustedContentLedger;
  logger: any;
}

/**
 * station-control tools whose result can carry a delegated child's output
 * back into the parent's turn.
 */
const DELEGATED_RESULT_TOOLS = new Set([
  'delegate_task',
  'get_task',
  'get_task_events',
  'continue_task',
  'respond_to_task_request',
  'list_delegated_tasks',
]);

// ── Factory ────────────────────────────────────────────

/**
 * Create framework-agnostic hook implementations.
 * Pass the returned hooks to the adapter via config.hooks.
 *
 * Chat streams register their approval requester by conversation because the
 * InjectableStream only exists during that request. The legacy mutable slot
 * remains for non-stream callers and focused hook tests.
 */
export function createAgentHooks(deps: AgentHooksDeps): IAgentHooks & {
  requestApproval?: (tool: ToolCallContext) => Promise<boolean>;
  registerApprovalRequester(
    conversationId: string,
    requester: (tool: ToolCallContext) => Promise<boolean>,
  ): () => void;
} {
  const autoApprove = deps.spec.tools?.autoApprove || [];
  const unattendedAutoApprove = deps.spec.tools?.unattendedAutoApprove;
  const approvalRequesters = new Map<
    string,
    (tool: ToolCallContext) => Promise<boolean>
  >();
  // #3483: turns that have read content an integration classifies untrusted.
  const untrustedContent =
    deps.untrustedContentLedger ?? sharedUntrustedContentLedger;
  const provenanceOf = (tool: ToolCallContext) =>
    tool.mcp?.provenance ?? deps.toolNameMapping.get(tool.toolName)?.provenance;
  // Read fresh on each call so a person's change applies to the next call.
  // A rejected read stays rejected: callers fail toward asking.
  const storedDefinition = (integrationId: string) =>
    Promise.resolve().then(() =>
      deps.configLoader.loadIntegration(integrationId),
    );

  let hooks: IAgentHooks & {
    requestApproval?: (tool: ToolCallContext) => Promise<boolean>;
    registerApprovalRequester(
      conversationId: string,
      requester: (tool: ToolCallContext) => Promise<boolean>,
    ): () => void;
  };
  const evaluatePreToolPolicy = createStagedPreToolPolicyEvaluator({
    spec: deps.spec,
    projectToolPolicy: deps.projectToolPolicy,
    agentPolicyService: deps.agentPolicyService,
    approvalGuardian: deps.approvalGuardian,
    isCurrentRuntimeGeneration: deps.isCurrentRuntimeGeneration
      ? () => deps.isCurrentRuntimeGeneration!(hooks)
      : undefined,
    resolveUnattendedGrant: deps.resolveUnattendedGrant,
    toolNameMapping: deps.toolNameMapping,
    isGranted: (tool) => {
      const source = deps.toolNameMapping.get(tool.toolName)?.provenance;
      return (
        isAutoApproved(
          tool.toolName,
          autoApprove.filter((pattern) => !pattern.startsWith('mcp/')),
        ) ||
        (source !== undefined &&
          isAutoApproved(
            mcpToolApprovalKey(source.integrationId, source.originalToolName),
            autoApprove,
          )) ||
        isIntrinsicStationEngineGrant(tool.toolName, deps.toolNameMapping)
      );
    },
    // #2613: the explicit unattended opt-in, matched like attended chat
    // matches `autoApprove` (runtime OR original MCP name). `isGranted` above
    // keeps legacy names runtime-only; qualified keys use loader provenance.
    isUnattendedGranted: (tool) =>
      isAuthoredToolPatternMatch(
        tool.toolName,
        unattendedAutoApprove,
        deps.toolNameMapping,
      ),
    untrustedContentPermission: async (tool, invocation) => {
      if (!(await untrustedContent.hasRead(invocation))) return undefined;
      const provenance = provenanceOf(tool);
      if (!provenance && tool.builtin) {
        return untrustedContentDecision(
          await storedDefinition(tool.builtin.integrationId).catch(
            () => undefined,
          ),
          tool.toolName,
        );
      }
      // Unknown sources cannot grant a tool permission by name alone.
      if (!provenance)
        return untrustedContentDecision(undefined, tool.toolName);
      return untrustedContentDecision(
        // No readable definition: no entries and no trusted hints, so ask.
        await storedDefinition(provenance.integrationId).catch(() => undefined),
        provenance.originalToolName,
      );
    },
    logger: deps.logger,
  });

  hooks = {
    afterModelGeneration: async (observation) => {
      if (
        !observation.invocation.sessionId ||
        !observation.invocation.turnId ||
        !observation.invocation.principalId ||
        deps.isCurrentRuntimeGeneration?.(hooks) === false
      )
        return;
      try {
        await deps.observeModelContext?.(observation);
      } catch {
        deps.logger.warn('Model context observation unavailable', {
          agentSlug: observation.invocation.agentSlug,
        });
      }
    },
    registerApprovalRequester: (conversationId, requester) => {
      approvalRequesters.set(conversationId, requester);
      return () => {
        if (approvalRequesters.get(conversationId) === requester) {
          approvalRequesters.delete(conversationId);
        }
      };
    },

    beforeToolCall: async (tool, invocation) => {
      const promptOrigin = currentMcpPromptOrigin();
      if (promptOrigin && !(await untrustedContent.hasRead(invocation))) {
        untrustedContent.mark(
          invocation,
          storedDefinition(promptOrigin.serverId).then(
            (definition) =>
              promptOrigin.untrusted || definition.contentTrust === 'untrusted',
          ),
        );
      }
      const scopedRequester = invocation.conversationId
        ? approvalRequesters.get(invocation.conversationId)
        : undefined;
      const requester = scopedRequester ?? hooks.requestApproval;
      const decision = await evaluatePreToolPolicy(tool, invocation, {
        interaction: 'managed',
        hasInteractiveApproval: !!requester,
      });
      if (decision.behavior === 'allow') return true;
      if (decision.behavior === 'deny') return decision.denial;
      if (decision.behavior === 'ask' && requester) {
        if (await requester(tool)) {
          // #3483: the person approved this call; the station-control
          // guard applies the same permission and reads this approval.
          const provenance = provenanceOf(tool);
          if (provenance && invocation.conversationId)
            recordPersonApprovedCall(
              invocation.conversationId,
              provenance.integrationId,
              provenance.originalToolName,
            );
          return true;
        }
        toolDenials.add(1, { reason: 'user_denied' });
        // archive#3210: these two reasons are pure Station templates — they
        // embed no guardian, hook, or tool-supplied prose at all — yet they
        // were the ONLY two denials the engine adapters redacted to
        // `Tool call failed.`, because they carry no `policyDenied` marker
        // (correctly: the policy evaluator did not produce them). Composing
        // them here stamps `stationComposedReason`, so a user who clicks Deny
        // is told that is what happened. `policyDenied` stays absent, so the
        // policy-denied badge still means what archive#3091 says it means.
        return stationDenial({
          toolName: tool.toolName,
          predicate: 'was denied: the user declined the approval request.',
        });
      }
      toolDenials.add(1, { reason: 'no_approval_channel' });
      return stationDenial({
        toolName: tool.toolName,
        predicate: 'was denied because no approval path is available.',
      });
    },

    afterToolCall: (tool, result, invocation) => {
      deps.logger.debug('[Hook] Tool executed', {
        toolName: tool.toolName,
        agentSlug: invocation.agentSlug,
      });

      const provenance = provenanceOf(tool);
      if (provenance) {
        untrustedContent.mark(
          invocation,
          // An unreadable definition rejects, which the ledger counts as
          // untrusted: a classification Station cannot read fails to asking.
          storedDefinition(provenance.integrationId).then(
            (def) => def.contentTrust === 'untrusted',
          ),
        );
        // A delegated child's output that read untrusted content brings it
        // into this turn.
        if (
          provenance.integrationId === 'station-control' &&
          DELEGATED_RESULT_TOOLS.has(provenance.originalToolName) &&
          untrustedContent.hasDescendantRead(invocation.conversationId)
        )
          untrustedContent.mark(invocation, Promise.resolve(true));
      }

      deps.workItemCapture?.capture({
        tool,
        result,
        invocation,
        current: () =>
          deps.isCurrentRuntimeGeneration?.(hooks) === true &&
          typeof invocation.principalId === 'string' &&
          invocation.principalId.length > 0,
      });

      if (
        deps.agentPolicyService &&
        !result.error &&
        deps.agentPolicyService.isWriteTool(tool.toolName)
      ) {
        const filePath = extractToolFilePath(tool.toolArgs);
        if (filePath) {
          const { warnings } = deps.agentPolicyService.afterWrite(filePath, {
            runtimeKind: 'managed',
          });
          for (const warning of warnings) {
            deps.logger.warn('Policy quality-gate warning', {
              toolName: tool.toolName,
              agentSlug: invocation.agentSlug,
              filePath,
              warning,
            });
          }
        }
      }
    },

    endInvocation: (invocation) => {
      untrustedContent.clear(invocation);
    },

    afterInvocation: async (ctx) => {
      const { invocation, usage, toolCallCount } = ctx;
      untrustedContent.clear(invocation);
      if (!invocation.conversationId) return;

      try {
        const adapter = deps.memoryAdapters.get(invocation.agentSlug);
        if (!adapter) return;

        if (!usage) return;

        const conversation = await adapter.getConversation(
          invocation.conversationId,
        );
        if (!conversation) return;
        const durableReceipt = currentAgentTurn()?.key.invocationId;
        if (
          durableReceipt &&
          conversation.metadata?.durableRuntimeStatsReceipt === durableReceipt
        )
          return;

        const agentSpec = await deps.configLoader.loadAgent(
          invocation.agentSlug,
        );
        let modelId =
          deps.spec.execution?.modelId ||
          agentSpec.execution?.modelId ||
          agentSpec.model ||
          deps.appConfig.defaultModel;
        let region = deps.appConfig.region;
        let providerType: string | undefined;
        if (deps.listProviderConnections) {
          try {
            const identity = resolveManagedModelIdentity(deps.spec, {
              appConfig: deps.appConfig,
              listProviderConnections: deps.listProviderConnections,
            });
            modelId = identity.modelId;
            region = identity.region ?? region;
            providerType = identity.providerType;
          } catch {
            // Usage persistence remains available for legacy provider state.
          }
        }
        const cost = await calculateUsageCost(
          modelId,
          usage,
          deps.modelCatalog,
          providerType,
          deps.appConfig,
          deps.logger,
          region,
        );

        // Get existing stats
        const existingStats = conversation.metadata?.stats as any;

        const fixedTokens = deps.agentFixedTokens.get(invocation.agentSlug);

        // Estimate user message tokens from latest message
        const messages = await adapter.getMessages(
          invocation.userId || '',
          invocation.conversationId,
        );
        const userMessages = messages.filter((m: any) => m.role === 'user');
        const latest = userMessages[userMessages.length - 1];
        const latestUserMessageText = latest
          ? getMessageTextContent(latest)
          : '';
        const { updatedStats, modelStats } = buildConversationStatsUpdate({
          existingStats,
          existingModelStats: (conversation.metadata?.modelStats ||
            {}) as Record<string, any>,
          usage,
          toolCallCount,
          modelId,
          latestUserMessageText,
          fixedTokens,
          cost,
        });

        await adapter.updateConversation(invocation.conversationId, {
          metadata: {
            ...conversation.metadata,
            ...(durableReceipt
              ? { durableRuntimeStatsReceipt: durableReceipt }
              : {}),
            stats: updatedStats,
            modelStats,
          },
        });

        await enrichLastMessage(
          adapter,
          invocation,
          modelId,
          providerType,
          usage,
          cost,
          deps,
        );
      } catch (error) {
        deps.logger.error('Failed to update conversation stats', { error });
      }
    },
  };

  return hooks;
}

// ── Helpers ────────────────────────────────────────────

async function enrichLastMessage(
  adapter: FileMemoryAdapter,
  invocation: InvocationContext,
  modelId: string,
  providerType: string | undefined,
  usage: TokenUsage,
  cost: number | null,
  deps: AgentHooksDeps,
) {
  try {
    const messages = await adapter.getMessages(
      `agent:${invocation.agentSlug}`,
      invocation.conversationId!,
    );
    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant') return;
    if (!modelId) return;

    const models = await deps.modelCatalog?.listModels();
    const modelInfo = models?.find((m: any) => m.modelId === modelId);
    const pricingInfo = await findModelPricing(
      deps.modelCatalog,
      modelId,
      resolveBedrockRegion({
        configRegion: deps.appConfig.region,
        env: process.env,
      }).region,
      providerType,
    );

    await adapter.removeLastMessage(
      `agent:${invocation.agentSlug}`,
      invocation.conversationId!,
    );
    const promptTokens = usage.promptTokens;
    const completionTokens = usage.completionTokens;
    const messageUsage = {
      ...(promptTokens !== undefined ? { inputTokens: promptTokens } : {}),
      ...(completionTokens !== undefined
        ? { outputTokens: completionTokens }
        : {}),
      ...(usage.totalTokens !== undefined
        ? { totalTokens: usage.totalTokens }
        : promptTokens !== undefined || completionTokens !== undefined
          ? { totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0) }
          : {}),
      estimatedCost: cost,
    };
    const enrichedMessage = {
      ...last,
      metadata: {
        ...(last as any).metadata,
        model: modelId,
        modelMetadata: modelInfo
          ? {
              capabilities: {
                inputModalities: modelInfo.inputModalities,
                outputModalities: modelInfo.outputModalities,
                supportsStreaming: modelInfo.responseStreamingSupported,
              },
              pricing: pricingInfo
                ? {
                    inputTokenPrice: pricingInfo.inputTokenPrice,
                    outputTokenPrice: pricingInfo.outputTokenPrice,
                    currency: 'USD',
                    region: deps.appConfig.region,
                  }
                : undefined,
            }
          : undefined,
        usage: messageUsage,
      },
    };
    await adapter.addMessage(
      enrichedMessage,
      `agent:${invocation.agentSlug}`,
      invocation.conversationId!,
      {
        model: modelId,
        modelMetadata: modelInfo
          ? {
              capabilities: {
                inputModalities: modelInfo.inputModalities,
                outputModalities: modelInfo.outputModalities,
                supportsStreaming: modelInfo.responseStreamingSupported,
              },
              pricing: pricingInfo
                ? {
                    inputTokenPrice: pricingInfo.inputTokenPrice,
                    outputTokenPrice: pricingInfo.outputTokenPrice,
                    currency: 'USD',
                    region: deps.appConfig.region,
                  }
                : undefined,
            }
          : undefined,
        usage: messageUsage,
        // This replaces the already-persisted assistant message with enriched
        // metadata. Its original write already updated usage statistics.
        suppressUsageAggregation: true,
      },
    );
    await adapter.applyEnrichmentUsage(
      `agent:${invocation.agentSlug}`,
      invocation.conversationId!,
      enrichedMessage,
      (last as any).metadata?.model || '',
    );
  } catch (error) {
    deps.logger.error('Failed to enrich message with model metadata', {
      error,
    });
  }
}
