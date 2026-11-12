import { SendTurnRefusedError } from '../../providers/adapter-shape.js';

class DelegationToolPolicyUnavailableError extends SendTurnRefusedError {
  readonly code = 'delegation_lineage_unavailable' as const;
  constructor() {
    super(
      'The selected engine cannot enforce inherited tool restrictions.',
      'permission_denied',
    );
    this.name = 'DelegationToolPolicyUnavailableError';
  }
}

/** A required policy must have a complete effect-time owner, not merely metadata delivery. */
export function assertInheritedDelegationToolPolicy(
  provider: string | undefined,
  delegation: unknown,
): void {
  if (
    !delegation ||
    typeof delegation !== 'object' ||
    Array.isArray(delegation)
  )
    return;
  if (!('toolAllowlistConstraints' in delegation)) return;
  const groups = delegation.toolAllowlistConstraints;
  if (groups === undefined) return;
  const valid =
    Array.isArray(groups) &&
    groups.length <= 64 &&
    groups.every(
      (group) =>
        Array.isArray(group) &&
        group.length <= 256 &&
        group.every(
          (pattern) =>
            typeof pattern === 'string' &&
            pattern.length > 0 &&
            pattern.length <= 256,
        ),
    );
  if (valid && (groups.length === 0 || provider === 'station-agent')) return;
  throw new DelegationToolPolicyUnavailableError();
}
