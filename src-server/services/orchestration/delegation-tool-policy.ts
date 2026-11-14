import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import { SendTurnRefusedError } from '../../providers/adapter-shape.js';

class DelegationToolPolicyUnavailableError extends SendTurnRefusedError {
  readonly code = 'delegation_lineage_unavailable' as const;
  constructor(
    message = 'The selected engine cannot enforce inherited tool restrictions.',
  ) {
    super(message, 'permission_denied');
    this.name = 'DelegationToolPolicyUnavailableError';
  }
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

/** A required policy must have a complete effect-time owner, not merely metadata delivery. */
export function assertInheritedDelegationToolPolicy(
  provider: string | undefined,
  delegation: unknown,
): void {
  const groups = inheritedGroups(delegation);
  if (!groups.length || provider === 'station-agent') return;
  throw new DelegationToolPolicyUnavailableError();
}

/** Reuse never installs a new policy into a live Session. Its recorded clauses must already retain each requirement. */
export function assertInheritedDelegationToolBinding(
  required: unknown,
  recorded: unknown,
): void {
  if (!inheritedGroups(required).length) return;
  const actual = effectiveGroups(recorded);
  for (const group of effectiveGroups(required)) {
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
  if (!delegation || !groups.length) return delegation;
  return {
    ...delegation,
    toolAllowlistConstraints: groups,
    ...(delegation.allowedTools !== undefined
      ? { allowedTools: patterns(delegation.allowedTools) }
      : {}),
    ...(delegation.blockedTools !== undefined
      ? { blockedTools: patterns(delegation.blockedTools) }
      : {}),
  };
}

export function inheritedDelegationToolPolicyIdentity(
  delegation: AgentDelegationContext | undefined,
) {
  const captured = captureInheritedDelegationToolContext(delegation);
  if (!captured?.toolAllowlistConstraints?.length) return undefined;
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
    toolAllowlistConstraints: captured.toolAllowlistConstraints,
  };
}

/** Identity only: this never authenticates or grants the policy it records. */
export function bindInheritedDelegationToolIntent(
  intent: unknown,
  delegation: AgentDelegationContext | undefined,
): unknown {
  const requiredDelegation = inheritedDelegationToolPolicyIdentity(delegation);
  return requiredDelegation ? { intent, requiredDelegation } : intent;
}
