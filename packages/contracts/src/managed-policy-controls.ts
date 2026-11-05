/** Lightweight explanations and predicates for mounted managed controls (#4601). */
import type { ManagedPolicySummary } from './managed-policy-status.js';
import {
  type ApprovalMode,
  approvalModeBreadth,
  type ConcreteApprovalMode,
  isConcreteApprovalMode,
} from './provider.js';

export * from './managed-policy-codes.js';

/** "Managed by <organization>", the label beside a managed control. */
export function managedByLabel(summary: ManagedPolicySummary): string {
  return `Managed by ${summary.organization}`;
}

/**
 * The one sentence every surface uses to refuse a change the policy forbids,
 * e.g. `managedPolicyDenial(summary, 'this setting')` gives "Acme's policy
 * manages this setting. For help, visit https://…".
 */
export function managedPolicyDenial(
  summary: ManagedPolicySummary,
  subject: string,
): string {
  const help = summary.supportUrl
    ? ` For help, visit ${summary.supportUrl}`
    : ' Contact your administrator for help.';
  return `${managedPolicyStatement(summary, subject)}${help}`;
}

/**
 * The first sentence of {@link managedPolicyDenial}, without the help
 * sentence, for a surface that offers the support link as a link.
 */
export function managedPolicyStatement(
  summary: Pick<ManagedPolicySummary, 'organization'>,
  subject: string,
): string {
  return `${summary.organization}'s policy manages ${subject}.`;
}

// ---------------------------------------------------------------------------
// #4518: the approval-mode ceiling (`limits.maxApprovalMode`).
// ---------------------------------------------------------------------------

/** The approval picker's words for each posture (`APPROVAL_MODE_OPTIONS`). */
const APPROVAL_MODE_NAMES: Readonly<Record<ConcreteApprovalMode, string>> = {
  ask: 'Ask first',
  auto: 'Auto',
  never: 'Full access',
};

/** The approval picker's name for `mode`, e.g. "Ask first" for `ask`. */
export function managedApprovalModeName(mode: ConcreteApprovalMode): string {
  return APPROVAL_MODE_NAMES[mode];
}

/**
 * The ceiling a summary enforces, or `undefined` when it restricts nothing:
 * no `maxApprovalMode`, or `never`, the broadest posture there is.
 */
export function managedApprovalCeiling(
  summary: Pick<ManagedPolicySummary, 'limits'> | null | undefined,
): ConcreteApprovalMode | undefined {
  const ceiling = summary?.limits.maxApprovalMode;
  return ceiling && ceiling !== 'never' ? ceiling : undefined;
}

/** Whether `mode` is broader than `ceiling`; nothing exceeds an absent ceiling. */
export function approvalModeExceedsCeiling(
  mode: ConcreteApprovalMode,
  ceiling: ConcreteApprovalMode | undefined,
): boolean {
  return (
    ceiling !== undefined &&
    approvalModeBreadth(mode) > approvalModeBreadth(ceiling)
  );
}

/**
 * `mode`, lowered to `ceiling` when it is broader. `connection-default` is
 * returned unchanged: it is not a posture, so the caller resolves it to the
 * posture it stands for and clamps that.
 */
export function clampApprovalModeToCeiling<M extends ApprovalMode>(
  mode: M,
  ceiling: ConcreteApprovalMode | undefined,
): M | ConcreteApprovalMode {
  if (!isConcreteApprovalMode(mode) || ceiling === undefined) return mode;
  return approvalModeExceedsCeiling(mode, ceiling) ? ceiling : mode;
}

/**
 * The one sentence every surface uses to refuse a posture above the
 * ceiling, e.g. "Acme's policy manages approval modes: the broadest allowed
 * is Auto. For help, visit https://…".
 */
export function managedApprovalCeilingDenial(
  summary: ManagedPolicySummary,
  ceiling: ConcreteApprovalMode,
): string {
  return managedPolicyDenial(summary, approvalCeilingSubject(ceiling));
}

/** {@link managedApprovalCeilingDenial} without its help sentence. */
export function managedApprovalCeilingStatement(
  summary: Pick<ManagedPolicySummary, 'organization'>,
  ceiling: ConcreteApprovalMode,
): string {
  return managedPolicyStatement(summary, approvalCeilingSubject(ceiling));
}

function approvalCeilingSubject(ceiling: ConcreteApprovalMode): string {
  return `approval modes: the broadest allowed is ${APPROVAL_MODE_NAMES[ceiling]}`;
}

/**
 * #4519: whether clients off this machine may reach the server. True without
 * a policy, without `limits.clients`, or when it lists `remote`.
 */
export function managedPolicyAllowsRemoteClients(
  summary: Pick<ManagedPolicySummary, 'limits'> | null | undefined,
): boolean {
  const clients = summary?.limits.clients;
  return clients === undefined || clients.includes('remote');
}

/**
 * #4519: the refusal without its help tail, for a surface that renders the
 * policy's support link itself ("Get help").
 */
export function managedRemoteClientsStatement(
  summary: ManagedPolicySummary,
): string {
  return `${summary.organization}'s policy manages remote access: only this computer can connect to Station.`;
}

/** The sentence every surface uses to refuse remote access under the limit. */
export function managedRemoteClientsDenial(
  summary: ManagedPolicySummary,
): string {
  return managedPolicyDenial(
    summary,
    'remote access: only this computer can connect to Station',
  );
}
