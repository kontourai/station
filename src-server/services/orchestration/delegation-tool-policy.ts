import { SendTurnRefusedError } from '../../providers/adapter-shape.js';

class DelegationToolPolicyUnavailableError extends SendTurnRefusedError {
  readonly code = 'delegation_lineage_unavailable' as const;
  constructor() {
    super(
      'Inherited delegation tool restrictions are unavailable for execution.',
      'permission_denied',
    );
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
