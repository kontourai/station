import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AgentPolicyService } from '../../services/agents/agent-policy-service.js';
import type { ApprovalGuardianService } from '../../services/approvals/approval-guardian.js';
import { toolDenials } from '../../telemetry/metrics.js';
import { errorMessage } from '../../utils/error-message.js';
import type { MCPToolNameMappingEntry } from '../tools/mcp-tool-names.js';
import type {
  InvocationContext,
  ToolCallContext,
  ToolCallDenial,
  UnattendedGrantResolution,
} from '../types.js';
import { isDelegatedToolAllowed } from './delegation.js';
import { type QuotedDenialText, stationDenial } from './denial-message.js';

type ToolDenialReason =
  | 'stale_generation'
  | 'delegated_tool_blocked'
  | 'policy_config_protection'
  | 'guardian_denied'
  | 'guardian_deferred_unattended'
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

interface StagedPreToolPolicyDeps {
  spec: AgentSpec;
  agentPolicyService?: AgentPolicyService;
  approvalGuardian?: ApprovalGuardianService;
  isCurrentRuntimeGeneration?: () => boolean;
  resolveUnattendedGrant?: (
    tool: ToolCallContext,
    invocation: InvocationContext,
  ) => Promise<UnattendedGrantResolution>;
  toolNameMapping: Map<string, MCPToolNameMappingEntry>;
  isGranted(tool: ToolCallContext): boolean;
  /**
   * #2613: the agent's explicit `tools.unattendedAutoApprove` opt-in. Asked
   * only for a Station-engine call nobody can consent to — no interactive
   * requester, or a delegated child that may not grant approvals — and only
   * after the approval guardian, which keeps its enforce-mode veto. Absent ⇒
   * no opt-in.
   */
  isUnattendedGranted?(tool: ToolCallContext): boolean;
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

/**
 * #2613: what an unattended denial tells the user to do. `tools.autoApprove`
 * is not the remedy: a pattern written against the original MCP name
 * (`station-control_*`) matches only in attended chat, so pointing there sent
 * users to an edit that changes nothing here. The message names the explicit
 * unattended opt-in instead.
 */
const UNATTENDED_REMEDY =
  "Patterns in tools.autoApprove are for attended chat; to allow this tool with nobody present, add it to this agent's tools.unattendedAutoApprove list.";

const CHILD_REMEDY =
  "To allow it here, add it to this agent's tools.unattendedAutoApprove list.";

/**
 * The narrower remedy a scheduled job also has: the operator's standing
 * grant for that one job (`/api/agents/unattended-grants`, consulted by
 * `resolveUnattendedGrant`), which does not widen the agent everywhere.
 */
const SCHEDULED_JOB_REMEDY =
  'To allow it for this scheduled job alone, an operator can instead record an unattended tool grant for the job through /api/agents/unattended-grants, keyed by the exact tool name above.';

/** The per-job remedy is moot when the grant store itself cannot be read. */
const SCHEDULED_JOB_STORE_UNAVAILABLE =
  'The unattended grant store could not be read, so no per-job grant was checked.';

/**
 * The opt-in is honoured on Station's engine only, so an external (ACP or
 * Claude) child is not sent to an edit that changes nothing there.
 */
function childDenialPredicate(interaction: 'managed' | 'external'): string {
  const predicate =
    'requires approval, and delegated child sessions cannot grant approvals.';
  return interaction === 'managed' ? `${predicate} ${CHILD_REMEDY}` : predicate;
}

function unattendedGrantDenialPredicate(
  invocation: InvocationContext,
  resolution: UnattendedGrantResolution,
): string {
  const predicate = `was denied for this unattended run. ${UNATTENDED_REMEDY}`;
  if (invocation.unattendedPrincipal?.kind !== 'scheduled-job')
    return predicate;
  return resolution === 'store-unavailable'
    ? `${predicate} ${SCHEDULED_JOB_STORE_UNAVAILABLE}`
    : `${predicate} ${SCHEDULED_JOB_REMEDY}`;
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
 * #2613: a Station-engine call nobody can consent to — no interactive
 * requester, or a delegated child that may not grant approvals. Only such a
 * call reaches the unattended stages: the explicit `tools.unattendedAutoApprove`
 * opt-in (matched in attended chat's form, since `tools.autoApprove` is matched
 * on this path against the runtime name only) and the per-job standing grant.
 * Attended calls never do (they `ask`), and neither do external engines, whose
 * unattended chain is undelivered (see the KNOWN GAP in the evaluator).
 */
function nobodyPresent(
  invocation: InvocationContext,
  options: Parameters<StagedPreToolPolicyEvaluator>[2],
): boolean {
  if (options.interaction !== 'managed') return false;
  return (
    invocation.delegation?.denyApprovals === true ||
    !options.hasInteractiveApproval
  );
}

type GuardianOutcome =
  | { kind: 'decided'; decision: PreToolPolicyDecision }
  | { kind: 'undecided'; enforceDeferral?: string };

/**
 * The approval guardian's verdict. An enforce-mode deny blocks; an allow
 * allows. Anything else leaves the call undecided — and in enforce mode that
 * undecided verdict (a `defer`, including the guardian's own error and
 * parse-failure fallbacks) is carried forward so an unattended call can treat
 * it as a refusal (#2613).
 */
async function reviewWithGuardian(
  deps: StagedPreToolPolicyDeps,
  tool: ToolCallContext,
  invocation: InvocationContext,
): Promise<GuardianOutcome> {
  const guardian = deps.approvalGuardian;
  if (!guardian?.isEnabled()) return { kind: 'undecided' };
  const review = await guardian.reviewToolCall({
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
    return { kind: 'decided', decision: { behavior: 'allow' } };
  }
  if (guardian.getMode() !== 'enforce') return { kind: 'undecided' };
  if (review.decision === 'deny') {
    deps.logger.warn('Approval guardian denied tool execution', {
      toolName: tool.toolName,
      agentSlug: invocation.agentSlug,
      reason: review.reason,
    });
    // archive#3210: `review.reason` is LLM-authored, from a prompt that
    // embeds the tool's own MCP-server-supplied description and its
    // arguments. It is genuinely useful to the user, so it is preserved —
    // but bounded and attributed, never presented as Station's verdict.
    return {
      kind: 'decided',
      decision: deny(
        'guardian_denied',
        tool.toolName,
        'was denied by the approval guardian.',
        { source: 'approval guardian', text: review.reason ?? '' },
      ),
    };
  }
  return { kind: 'undecided', enforceDeferral: review.reason ?? '' };
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

    const guardian = await reviewWithGuardian(deps, tool, invocation);
    if (guardian.kind === 'decided') return guardian.decision;

    if (nobodyPresent(invocation, options)) {
      // #2613, owner decision "unattended stricter": with nobody present to
      // resolve it, an enforce-mode guardian that did not approve refuses the
      // call. This precedes BOTH unattended grants — the opt-in here and the
      // per-job standing grant below — so neither can override it. Review
      // mode, and attended chat (where a defer means ask the person), are
      // unchanged.
      if (guardian.enforceDeferral !== undefined) {
        deps.logger.warn('Approval guardian deferred an unattended tool call', {
          toolName: tool.toolName,
          agentSlug: invocation.agentSlug,
          conversationId: invocation.conversationId,
        });
        return deny(
          'guardian_deferred_unattended',
          tool.toolName,
          'was not run: the approval guardian did not approve it, and nobody is present to decide.',
          { source: 'approval guardian', text: guardian.enforceDeferral },
        );
      }
      if (deps.isUnattendedGranted?.(tool) === true) {
        deps.logger.info('Unattended auto-approval allowed tool execution', {
          toolName: tool.toolName,
          agentSlug: invocation.agentSlug,
          conversationId: invocation.conversationId,
        });
        return { behavior: 'allow' };
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
        childDenialPredicate(options.interaction),
      );
    }

    // The Claude SDK's canUseTool remains its interactive authority. Defer so
    // it asks exactly once rather than creating a second Station request here.
    // `defer` is Station declining to decide — see `PreToolPolicyDecision`: it
    // is never Claude's `permissionDecision: 'defer'`.
    //
    // KNOWN GAP (#1536 follow-up): this returns before the unattended stages
    // below, so an external session with nobody to ask waits on an approval
    // request instead of taking their fail-fast denial.
    //
    // What blocks a straight reorder is not that the signal is unavailable —
    // it exists and has three writers (`strands-adapter.ts`,
    // `voltagent-adapter.ts` via `currentScheduledPrincipal()`, and
    // `voice-session.ts`'s `kind: 'voice'`), and the scheduler establishes it
    // at the route boundary through `runWithScheduledPrincipal`'s
    // AsyncLocalStorage (`scheduled-principal-context.ts`;
    // `runtime-route-support.ts`). The blocker is WHERE the external hook
    // runs: the Claude `PreToolUse` hook fires from the SDK message loop, on a
    // long-lived stream task outside any request scope, so an ALS read there
    // finds nothing. The principal has to be CAPTURED into the session record
    // at `startSession`/`sendTurn` — while the request scope still exists —
    // and threaded into this `InvocationContext`.
    //
    // Until it is, reordering is unsafe rather than merely incomplete:
    // `resolveUnattendedGrant` returns `false` whenever
    // `invocation.unattendedPrincipal` is absent, so moving the stages up
    // would take every ATTENDED external call down the
    // `unattended_grant_denied` path.
    if (options.interaction === 'external') return { behavior: 'defer' };
    if (options.hasInteractiveApproval) return { behavior: 'ask' };

    if (deps.resolveUnattendedGrant) {
      const resolution = await deps.resolveUnattendedGrant(tool, invocation);
      if (resolution === true) return { behavior: 'allow' };
      deps.logger.warn('Unattended grant denied tool execution', {
        toolName: tool.toolName,
        agentSlug: invocation.agentSlug,
        conversationId: invocation.conversationId,
      });
      return deny(
        'unattended_grant_denied',
        tool.toolName,
        unattendedGrantDenialPredicate(invocation, resolution),
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
      `requires approval, but this run has no approval channel to ask (unattended runs — scheduled jobs, /invoke, CLI — have no one to consent). ${UNATTENDED_REMEDY}`,
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
        error: errorMessage(error),
      });
      return deny(
        'policy_evaluation_failed',
        tool.toolName,
        'was denied because the pre-tool policy could not be evaluated.',
      );
    }
  };
}
