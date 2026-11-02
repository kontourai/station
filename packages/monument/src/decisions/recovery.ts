/** The durable result of a recovery transition. */
export type RecoveryTransition =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

/** A claimant pins one terminal action, including its original arguments. */
export type RecoveryTransitionIntent =
  | { kind: 'release'; outcome: 'armed' | 'manual'; now: string }
  | { kind: 'accept'; turnId: string; now: string }
  | { kind: 'indeterminate'; now: string };

export function decideRecoveryTransition(
  previous: RecoveryTransitionIntent | undefined,
  next: RecoveryTransitionIntent,
  settled: RecoveryTransition | undefined,
): { kind: 'execute' } | { kind: 'return'; result: RecoveryTransition } {
  if (previous && JSON.stringify(previous) !== JSON.stringify(next))
    return { kind: 'return', result: { kind: 'invalid' } };
  return settled ? { kind: 'return', result: settled } : { kind: 'execute' };
}
