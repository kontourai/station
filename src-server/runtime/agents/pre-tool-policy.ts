import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AgentPolicyService } from '../../services/agents/agent-policy-service.js';
import type { ApprovalGuardianService } from '../../services/approvals/approval-guardian.js';
import { toolDenials } from '../../telemetry/metrics.js';
import type { MCPToolNameMappingEntry } from '../tools/mcp-tool-names.js';
import type {
  InvocationContext,
  ToolCallContext,
  ToolCallDenial,
} from '../types.js';
import { isDelegatedToolAllowed } from './delegation.js';
import { type QuotedDenialText, stationDenial } from './denial-message.js';

type ToolDenialReason =
  | 'stale_generation'
  | 'delegated_tool_blocked'
  | 'policy_config_protection'
  | 'guardian_denied'
  | 'delegation_deny_approvals'
  | 'unattended_grant_denied'
  | 'no_approval_channel'
  | 'policy_evaluation_failed';

/**
 * `defer` means "Station's policy is not deciding this call; the engine's own
 * permission flow owns it". An engine adapter must NEVER translate it into
 * Claude's `PreToolUse` `permissionDecision: 'defer'`, which is a different
 * contract entirely — that value asks the engine to hand the call back to the
 * SDK host to execute, and the engine ends the turn unresolved when nobody
 * does (#1536 finding B1). Translate it to whatever the engine's own flow is,
 * or to no opinion at all.
 */
export type PreToolPolicyDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; denial: ToolCallDenial }
  | { behavior: 'ask' }
  | { behavior: 'defer' };

/**
 * An external adapter supplies derived names for matching only. The original
 * tool context remains authoritative for grants, display, and receipts.
 */
export interface PreToolPolicyToolIdentity {
  delegationToolName: string;
  configProtectionToolName: string;
}

export type StagedPreToolPolicyEvaluator = (
  tool: ToolCallContext,
  invocation: InvocationContext,
  options: {
    /** Claude has an SDK-owned interactive permission callback. */
    interaction: 'managed' | 'external';
    /** True only when managed hooks can actually ask a current requester. */
    hasInteractiveApproval?: boolean;
    identity?: PreToolPolicyToolIdentity;
  },
) => Promise<PreToolPolicyDecision>;

export interface StagedPreToolPolicyDeps {
  spec: AgentSpec;
  agentPolicyService?: AgentPolicyService;
  approvalGuardian?: ApprovalGuardianService;
  isCurrentRuntimeGeneration?: () => boolean;
  resolveUnattendedGrant?: (
    tool: ToolCallContext,
    invocation: InvocationContext,
  ) => Promise<boolean>;
  toolNameMapping: Map<string, MCPToolNameMappingEntry>;
  isGranted(tool: ToolCallContext): boolean;
  logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Every denial this evaluator produces, composed in one place.
 *
 * archive#3210: the tool name is passed SEPARATELY from the prose and is
 * interpolated only inside `denial-message.ts`, so a new stage added below
 * cannot accidentally put an unbounded, newline-carrying tool name into
 * Station's own sentence — the signature does not offer a way to. Foreign
 * text (an LLM guardian's verdict, an external hook's output) has its own
 * parameter, and is bounded, quoted and attributed rather than being spliced
 * into the sentence as if Station had said it.
 */
function deny(
  reason: ToolDenialReason,
  toolName: string,
  predicate: string,
  quoted?: QuotedDenialText,
): PreToolPolicyDecision {
  toolDenials.add(1, { reason });
  return {
    behavior: 'deny',
    // archive#3091: `policyDenied` marks this as an evaluator-produced
    // denial (as opposed to a human declining via an approval requester,
    // which agent-hooks.ts constructs without this flag) — the client's
    // policy-denied badge derives from this field, never inferred.
    // archive#3210: `stationDenial` additionally stamps
    // `stationComposedReason`, which is the separate signal that gates
    // verbatim rendering. The badge's derivation is unchanged.
    denial: stationDenial({
      toolName,
      predicate,
      ...(quoted ? { quoted } : {}),
      policyDenied: true,
    }),
  };
}

/** Station's own half of a config-protection denial, always present. */
const CONFIG_PROTECTION_PREDICATE =
  'was blocked by the config-protection policy.';

/**
 * How a config-protection verdict's `reason` should be rendered, derived from
 * the authorship the policy service declared for it (archive#3210).
 *
 * `station` text continues Station's own sentence, because Station wrote it:
 * either the pure-TypeScript guard's remediation prose or the `native`
 * engine's own fallback literal. `external-hook` text is the hook process's
 * raw `stderr`/`stdout` and is bounded, quoted and attributed instead.
 *
 * An undeclared author renders as `external-hook`. That is the fail-closed
 * direction: quoting Station's own words costs a slightly stilted sentence,
 * whereas speaking a hook's words in Station's voice is the defect itself.
 */
function policyReasonRendering(verdict: {
  reason?: string;
  reasonAuthor?: 'station' | 'external-hook';
}): { author: 'station' | 'external-hook'; text: string } {
  return {
    author: verdict.reasonAuthor === 'station' ? 'station' : 'external-hook',
    text: verdict.reason?.trim() ?? '',
  };
}

function policyBlockPredicate(verdict: {
  reason?: string;
  reasonAuthor?: 'station' | 'external-hook';
}): string {
  const rendering = policyReasonRendering(verdict);
  if (rendering.author !== 'station' || rendering.text.length === 0) {
    return CONFIG_PROTECTION_PREDICATE;
  }
  // Station prose completing a Station sentence — deliberately not bounded or
  // quoted, which is what `denial-message.ts`'s guarantee (1) covers. It is a
  // constant in `agent-policy-service.ts`; the only interpolation it carries
  // is a basename drawn from that file's closed PROTECTED_FILES set.
  return `${CONFIG_PROTECTION_PREDICATE} ${rendering.text}`;
}

function policyBlockQuotation(verdict: {
  reason?: string;
  reasonAuthor?: 'station' | 'external-hook';
}): QuotedDenialText | undefined {
  const rendering = policyReasonRendering(verdict);
  if (rendering.author === 'station' || rendering.text.length === 0) {
    return undefined;
  }
  return { source: 'config-protection hook', text: rendering.text };
}

/**
 * The one Station-owned sequence of pre-tool blocking and grant stages.
 * Engine adapters only translate its final decision into their native hook
 * contract; they must not reproduce a policy stage.
 */
export function createStagedPreToolPolicyEvaluator(
  deps: StagedPreToolPolicyDeps,
): StagedPreToolPolicyEvaluator {
  const evaluate: StagedPreToolPolicyEvaluator = async (
    tool: ToolCallContext,
    invocation: InvocationContext,
    options: Parameters<StagedPreToolPolicyEvaluator>[2],
  ) => {
    const identity = options.identity ?? {
      delegationToolName: tool.toolName,
      configProtectionToolName: tool.toolName,
    };
    if (deps.isCurrentRuntimeGeneration && !deps.isCurrentRuntimeGeneration()) {
      deps.logger.warn('Stale agent generation blocked tool execution', {
        toolName: identity.delegationToolName,
        agentSlug: invocation.agentSlug,
        conversationId: invocation.conversationId,
      });
      return deny(
        'stale_generation',
        tool.toolName,
        "was blocked because the agent's runtime configuration changed mid-run. Retry the request.",
      );
    }

    if (
      !isDelegatedToolAllowed({
        toolName: identity.delegationToolName,
        delegation: invocation.delegation,
        toolNameMapping: deps.toolNameMapping,
      })
    ) {
      deps.logger.warn('Delegated child agent blocked tool execution', {
        toolName: tool.toolName,
        agentSlug: invocation.agentSlug,
        conversationId: invocation.conversationId,
      });
      return deny(
        'delegated_tool_blocked',
        tool.toolName,
        'is not allowed in this delegated child session.',
      );
    }

    if (deps.agentPolicyService) {
      const verdict = deps.agentPolicyService.checkToolCall(
        identity.configProtectionToolName,
        tool.toolArgs,
        { runtimeKind: 'managed' },
      );
      if (verdict.decision === 'block') {
        deps.logger.warn('Policy blocked tool execution (config-protection)', {
          toolName: tool.toolName,
          agentSlug: invocation.agentSlug,
          conversationId: invocation.conversationId,
          reason: verdict.reason,
          engine: verdict.engine,
          reasonAuthor: policyReasonRendering(verdict).author,
        });
        // archive#3210: `verdict.reason` has two possible authors and the
        // attribution is DERIVED from the one the policy service declared,
        // never hardcoded. Hardcoding "quoted from the config-protection
        // hook" is the same defect this issue is about, pointed the other
        // way: two of the reachable block paths — the pure-TypeScript guard
        // used when the hook module cannot be loaded, and the `native`
        // engine's empty-output fallback — carry Station's OWN remediation
        // prose, and telling the user Station's instructions are "not
        // Station's wording" credits a process that never ran.
        //
        // `verdict.engine` is deliberately NOT the discriminator: `native`
        // produces both authors, so it would still misattribute the fallback.
        return deny(
          'policy_config_protection',
          tool.toolName,
          policyBlockPredicate(verdict),
          policyBlockQuotation(verdict),
        );
      }
    }

    if (deps.isGranted(tool)) return { behavior: 'allow' };

    if (deps.approvalGuardian?.isEnabled()) {
      const review = await deps.approvalGuardian.reviewToolCall({
        agentName: deps.spec.name,
        agentSlug: invocation.agentSlug,
        conversationId: invocation.conversationId,
        toolName: tool.toolName,
        toolDescription: tool.toolDescription,
        toolArgs: tool.toolArgs,
      });
      if (review.decision === 'allow') {
        deps.logger.info('Approval guardian allowed tool execution', {
          toolName: tool.toolName,
          agentSlug: invocation.agentSlug,
          reason: review.reason,
        });
        return { behavior: 'allow' };
      }
      if (
        review.decision === 'deny' &&
        deps.approvalGuardian.getMode() === 'enforce'
      ) {
        deps.logger.warn('Approval guardian denied tool execution', {
          toolName: tool.toolName,
          agentSlug: invocation.agentSlug,
          reason: review.reason,
        });
        // archive#3210: `review.reason` is LLM-authored, from a prompt that
        // embeds the tool's own MCP-server-supplied description and its
        // arguments. It is genuinely useful to the user, so it is preserved —
        // but bounded and attributed, never presented as Station's verdict.
        return deny(
          'guardian_denied',
          tool.toolName,
          'was denied by the approval guardian.',
          { source: 'approval guardian', text: review.reason ?? '' },
        );
      }
    }

    if (invocation.delegation?.denyApprovals) {
      deps.logger.warn('Delegated child agent denied approval-bound tool', {
        toolName: tool.toolName,
        agentSlug: invocation.agentSlug,
        conversationId: invocation.conversationId,
      });
      return deny(
        'delegation_deny_approvals',
        tool.toolName,
        'requires approval, and delegated child sessions cannot grant approvals.',
      );
    }

    // The Claude SDK's canUseTool remains its interactive authority. Defer so
    // it asks exactly once rather than creating a second Station request here.
    // `defer` is Station declining to decide — see `PreToolPolicyDecision`: it
    // is never Claude's `permissionDecision: 'defer'`.
    //
    // KNOWN GAP (#1536 follow-up): this returns before the unattended stages
    // below, so an external session with nobody to ask waits on an approval
    // request instead of taking their fail-fast denial. Fixing it needs an
    // unattended signal the external adapters do not carry —
    // `invocation.unattendedPrincipal` is populated only by the two managed
    // framework adapters from `currentScheduledPrincipal()`, so simply moving
    // the stages up would make `resolveUnattendedGrant` return `false` for
    // every ATTENDED external call and deny it. Do not reorder without
    // threading that signal through first.
    if (options.interaction === 'external') return { behavior: 'defer' };
    if (options.hasInteractiveApproval) return { behavior: 'ask' };

    if (deps.resolveUnattendedGrant) {
      if ((await deps.resolveUnattendedGrant(tool, invocation)) === true) {
        return { behavior: 'allow' };
      }
      deps.logger.warn('Unattended grant denied tool execution', {
        toolName: tool.toolName,
        agentSlug: invocation.agentSlug,
        conversationId: invocation.conversationId,
      });
      return deny(
        'unattended_grant_denied',
        tool.toolName,
        "was denied for this unattended run. Add it to the agent's tools.autoApprove list to grant it.",
      );
    }
    deps.logger.warn('No approval channel; denied tool execution', {
      toolName: tool.toolName,
      agentSlug: invocation.agentSlug,
      conversationId: invocation.conversationId,
      reason: 'no_approval_channel',
    });
    return deny(
      'no_approval_channel',
      tool.toolName,
      "requires approval, but this run has no approval channel to ask (unattended runs — scheduled jobs, /invoke, CLI — have no one to consent). Add the tool to the agent's tools.autoApprove list to grant it for unattended runs.",
    );
  };
  return async (tool, invocation, options) => {
    try {
      return await evaluate(tool, invocation, options);
    } catch (error) {
      deps.logger.warn('Pre-tool policy evaluation failed closed', {
        toolName: tool.toolName,
        agentSlug: invocation.agentSlug,
        conversationId: invocation.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return deny(
        'policy_evaluation_failed',
        tool.toolName,
        'was denied because the pre-tool policy could not be evaluated.',
      );
    }
  };
}
