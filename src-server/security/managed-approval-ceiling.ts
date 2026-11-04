/**
 * #4518: the managed approval ceiling this process enforces.
 *
 * The machine administrator's policy (`limits.maxApprovalMode`, #4515) caps
 * the broadest approval posture any run may use, whoever starts it. The
 * entrypoint loads the policy once, before the runtime is built, and installs
 * it here; it is fixed for the process lifetime. Process state, not an
 * injected dependency, on purpose: the policy covers the machine, and the
 * gates that read it (`mayGrantFullAccess`, `ApprovalPosture`, the
 * orchestration decision writer and the routes) are reached from many
 * compositions. One holder means none of them can be built without it.
 *
 * Two rules, applied at every gate (docs/decisions/managed-policy.md):
 * - a choice someone makes (a pick, a raise of the Station default) above the
 *   ceiling is refused with the managed message;
 * - a default (Agent, Project, Station, a person's saved default, an
 *   automation's or a webhook's posture) above it is lowered to it.
 * A thread whose recorded pick is above the ceiling starts no turn until its
 * mode is lowered.
 */
import {
  approvalModeExceedsCeiling,
  clampApprovalModeToCeiling,
  MANAGED_POLICY_APPROVAL_CEILING_CODE,
  type ManagedPolicySummary,
  managedApprovalCeiling,
  managedApprovalCeilingDenial,
} from '@kontourai/station-contracts/managed-policy';
import {
  type ApprovalMode,
  type ConcreteApprovalMode,
  isConcreteApprovalMode,
} from '@kontourai/station-contracts/provider';
import {
  SendTurnRefusedError,
  SessionStartRefusedError,
} from '../providers/adapter-shape.js';

interface InstalledCeiling {
  readonly summary: ManagedPolicySummary;
  readonly ceiling: ConcreteApprovalMode;
}

let installed: InstalledCeiling | null = null;

/**
 * Install the ceiling of the policy the entrypoint loaded; `null` (no
 * policy) or a policy without a restricting `maxApprovalMode` clears it.
 */
export function installManagedApprovalCeiling(
  policy: { summary: ManagedPolicySummary } | null,
): void {
  const ceiling = managedApprovalCeiling(policy?.summary);
  installed = policy && ceiling ? { summary: policy.summary, ceiling } : null;
}

/** The ceiling in force, or `undefined` when nothing is capped. */
export function managedApprovalCeilingInForce():
  | ConcreteApprovalMode
  | undefined {
  return installed?.ceiling;
}

/** Whether `mode` is a posture broader than the ceiling in force. */
export function managedCeilingRefuses(mode: unknown): boolean {
  return (
    isConcreteApprovalMode(mode) &&
    approvalModeExceedsCeiling(mode, installed?.ceiling)
  );
}

/** `mode` lowered to the ceiling in force; `connection-default` unchanged. */
export function clampToManagedCeiling<M extends ApprovalMode>(
  mode: M,
): M | ConcreteApprovalMode {
  return clampApprovalModeToCeiling(mode, installed?.ceiling);
}

/** The managed refusal sentence; only meaningful while a ceiling is in force. */
function managedApprovalCeilingMessage(): string {
  return installed
    ? managedApprovalCeilingDenial(installed.summary, installed.ceiling)
    : 'The managed policy limits approval modes.';
}

/**
 * A posture above the ceiling was refused before it had any effect: a pick
 * recorded on a thread, or a turn or (re)start of a thread whose recorded
 * pick is above it. A `SendTurnRefusedError`, so a turn path reports it as a
 * definitive refusal carrying {@link MANAGED_POLICY_APPROVAL_CEILING_CODE},
 * never as a retryable failure.
 */
export class ManagedApprovalCeilingRefusedError extends SendTurnRefusedError {
  readonly code = MANAGED_POLICY_APPROVAL_CEILING_CODE;

  /**
   * `reason` leads the managed sentence when the refused posture is not the
   * one the caller asked for (an engine that can only run broader), so the
   * message says why an allowed pick was still refused.
   */
  constructor(reason?: string) {
    super(
      reason
        ? `${reason} ${managedApprovalCeilingMessage()}`
        : managedApprovalCeilingMessage(),
      'permission_denied',
    );
    this.name = 'ManagedApprovalCeilingRefusedError';
  }
}

/**
 * The same refusal raised while a session STARTS (an engine whose only
 * available runtime would run above the ceiling). A
 * `SessionStartRefusedError`, so the start boundary settles it as a
 * definitive refusal with nothing to inspect, never an indeterminate start,
 * and routes answer the managed 403 by its code.
 */
export class ManagedApprovalCeilingStartRefusedError extends SessionStartRefusedError {
  constructor(reason?: string) {
    super(
      reason
        ? `${reason} ${managedApprovalCeilingMessage()}`
        : managedApprovalCeilingMessage(),
      MANAGED_POLICY_APPROVAL_CEILING_CODE,
    );
    this.name = 'ManagedApprovalCeilingStartRefusedError';
  }
}

/** The JSON body of a 403 for a posture above the ceiling. */
export function managedApprovalCeilingRefusalBody(): {
  success: false;
  error: string;
  code: typeof MANAGED_POLICY_APPROVAL_CEILING_CODE;
} {
  return {
    success: false,
    error: managedApprovalCeilingMessage(),
    code: MANAGED_POLICY_APPROVAL_CEILING_CODE,
  };
}
