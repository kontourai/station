import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import { SendTurnRefusedError } from '../../providers/adapter-shape.js';

class DelegationToolPolicyUnavailableError extends SendTurnRefusedError {
  readonly code = 'delegation_lineage_unavailable' as const;
  constructor(
    message = 'Inherited delegation tool restrictions are unavailable for execution.',
  ) {
    super(message, 'permission_denied');
    this.name = 'DelegationToolPolicyUnavailableError';
  }
}

/** Qualify execution only after policy custody and effect-time delivery are proven. */
export function assertInheritedDelegationToolPolicy(delegation: unknown): void {
  if (
    !delegation ||
    typeof delegation !== 'object' ||
    !('toolAllowlistConstraints' in delegation)
  )
    return;
  const groups = delegation.toolAllowlistConstraints;
  if (groups === undefined || (Array.isArray(groups) && groups.length === 0))
    return;
  throw new DelegationToolPolicyUnavailableError();
}

function patterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new DelegationToolPolicyUnavailableError();
  return value.map((pattern) => {
    if (typeof pattern !== 'string' || !pattern.length || pattern.length > 256)
      throw new DelegationToolPolicyUnavailableError();
    return pattern;
  });
}

function inheritedGroups(delegation: unknown): string[][] {
  if (
    !delegation ||
    typeof delegation !== 'object' ||
    Array.isArray(delegation)
  )
    return [];
  if (
    !('toolAllowlistConstraints' in delegation) ||
    delegation.toolAllowlistConstraints === undefined
  )
    return [];
  const groups = delegation.toolAllowlistConstraints;
  if (!Array.isArray(groups) || groups.length > 64)
    throw new DelegationToolPolicyUnavailableError();
  return groups.map(patterns);
}

function effectiveGroups(delegation: unknown): string[][] {
  const groups = inheritedGroups(delegation);
  if (
    delegation &&
    typeof delegation === 'object' &&
    'allowedTools' in delegation &&
    delegation.allowedTools !== undefined
  ) {
    const local = patterns(delegation.allowedTools);
    if (local.length) groups.push(local);
  }
  return groups;
}

function deniedTools(delegation: unknown): string[] {
  if (
    !delegation ||
    typeof delegation !== 'object' ||
    Array.isArray(delegation) ||
    !('blockedTools' in delegation) ||
    delegation.blockedTools === undefined
  )
    return [];
  return patterns(delegation.blockedTools);
}

function forbidsApprovals(delegation: unknown): boolean {
  if (
    !delegation ||
    typeof delegation !== 'object' ||
    Array.isArray(delegation) ||
    !('denyApprovals' in delegation) ||
    delegation.denyApprovals === undefined
  )
    return false;
  if (typeof delegation.denyApprovals !== 'boolean')
    throw new DelegationToolPolicyUnavailableError();
  return delegation.denyApprovals;
}

/** Reuse never installs a new policy into a live Session. Its recorded clauses must already retain each requirement. */
export function assertInheritedDelegationToolBinding(
  required: unknown,
  recorded: unknown,
): void {
  const requiredGroups = effectiveGroups(required);
  const requiredDeniedTools = deniedTools(required);
  const requiredApprovalDenial = forbidsApprovals(required);
  if (
    !requiredGroups.length &&
    !requiredDeniedTools.length &&
    !requiredApprovalDenial
  )
    return;
  const actual = effectiveGroups(recorded);
  const actualDeniedTools = new Set(deniedTools(recorded));
  const deniesAllTools =
    actualDeniedTools.has('*') || actual.some((group) => group.length === 0);
  if (
    (requiredApprovalDenial && !forbidsApprovals(recorded)) ||
    (!deniesAllTools &&
      requiredDeniedTools.some((pattern) => !actualDeniedTools.has(pattern)))
  )
    throw new DelegationToolPolicyUnavailableError(
      'The existing Session does not retain the required inherited tool restrictions.',
    );
  if (deniesAllTools) return;
  for (const group of requiredGroups) {
    const permitted = new Set(group);
    if (
      !actual.some((clause) =>
        clause.every((pattern) => permitted.has(pattern)),
      )
    )
      throw new DelegationToolPolicyUnavailableError(
        'The existing Session does not retain the required inherited tool restrictions.',
      );
  }
}

/** Capture policy data without cloning server authority objects carried beside it. */
export function captureInheritedDelegationToolContext(
  delegation: AgentDelegationContext | undefined,
): AgentDelegationContext | undefined {
  const groups = inheritedGroups(delegation);
  if (!delegation) return delegation;
  forbidsApprovals(delegation);
  return {
    ...delegation,
    ...(delegation.toolAllowlistConstraints !== undefined
      ? { toolAllowlistConstraints: groups }
      : {}),
    ...(delegation.allowedTools !== undefined
      ? { allowedTools: patterns(delegation.allowedTools) }
      : {}),
    ...(delegation.blockedTools !== undefined
      ? { blockedTools: patterns(delegation.blockedTools) }
      : {}),
  };
}

function delegationToolPolicyIdentity(
  delegation: AgentDelegationContext | undefined,
) {
  const captured = captureInheritedDelegationToolContext(delegation);
  if (
    !captured ||
    (!effectiveGroups(captured).length &&
      !deniedTools(captured).length &&
      !forbidsApprovals(captured))
  )
    return undefined;
  return {
    mode: captured.mode,
    depth: captured.depth,
    maxDepth: captured.maxDepth,
    parentAgentSlug: captured.parentAgentSlug,
    parentSessionId: captured.parentSessionId ?? null,
    parentConversationId: captured.parentConversationId ?? null,
    rootAgentSlug: captured.rootAgentSlug,
    rootConversationId: captured.rootConversationId ?? null,
    allowedTools: captured.allowedTools ?? null,
    blockedTools: captured.blockedTools ?? null,
    denyApprovals: captured.denyApprovals ?? null,
    toolAllowlistConstraints: captured.toolAllowlistConstraints ?? null,
  };
}

/** Identity only: this never authenticates or grants the policy it records. */
export function bindDelegationToolIntent(
  intent: unknown,
  delegation: AgentDelegationContext | undefined,
): unknown {
  const requiredDelegation = delegationToolPolicyIdentity(delegation);
  return requiredDelegation ? { intent, requiredDelegation } : intent;
}
