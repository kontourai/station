/**
 * The client-facing half of the managed policy contract (#4515): the value-free
 * summary a server publishes, its status envelope and boundary parser, and the
 * approval-ceiling helpers (#4518). Kept free of the settings registries the
 * document parser needs, so the UI's first-load bundle does not carry them.
 * `@kontourai/station-contracts/managed-policy` re-exports all of it.
 */
import {
  type ApprovalMode,
  approvalModeBreadth,
  type ConcreteApprovalMode,
  isConcreteApprovalMode,
} from './provider.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Limits sit outside settings. Each enforcement slice adds its key here and
 * to {@link MANAGED_POLICY_ENFORCED_LIMIT_KEYS} together.
 */
export interface ManagedPolicyLimits {
  /**
   * #4518: the broadest approval posture any run may use, whoever starts it.
   * A concrete mode only: `connection-default` is not a posture.
   */
  maxApprovalMode?: ConcreteApprovalMode;
}

/**
 * What clients learn about the policy: who manages the machine, where to get
 * help, which setting paths are locked, and the effective limits. It never
 * carries a setting value, because a value may be sensitive to someone, and
 * clients need only to explain why a control is locked.
 */
export interface ManagedPolicySummary {
  organization: string;
  supportUrl: string | null;
  lockedSettings: string[];
  limits: ManagedPolicyLimits;
}

/** Where a loaded policy came from. More kinds arrive with later sources. */
export type ManagedPolicySourceKind = 'file' | 'test-override';

export interface ManagedPolicySourceDescriptor {
  kind: ManagedPolicySourceKind;
  /** A path, or a later source's identifier (a profile domain, a key). */
  location: string;
}

/** A `sha256:<64 hex>` fingerprint of {@link canonicalManagedPolicyJson}. */
export type ManagedPolicyDigest = `sha256:${string}`;

/**
 * `GET /api/settings/managed-policy`: what the running server loaded at
 * startup. A server never runs with a policy it could not load, so there is
 * no error state here.
 */
export type ManagedPolicyStatus =
  | { state: 'none' }
  | {
      state: 'loaded';
      source: ManagedPolicySourceDescriptor;
      digest: ManagedPolicyDigest;
      summary: ManagedPolicySummary;
    };

export function isManagedPolicyDigest(
  value: unknown,
): value is ManagedPolicyDigest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/** Boundary parser for a {@link ManagedPolicyStatus} read from a server. */
export function parseManagedPolicyStatus(
  value: unknown,
): ManagedPolicyStatus | null {
  if (!isRecord(value)) return null;
  if (value.state === 'none') return { state: 'none' };
  if (value.state !== 'loaded') return null;
  const { source, digest, summary } = value;
  if (
    !isRecord(source) ||
    (source.kind !== 'file' && source.kind !== 'test-override') ||
    typeof source.location !== 'string' ||
    !isManagedPolicyDigest(digest) ||
    !isRecord(summary) ||
    typeof summary.organization !== 'string' ||
    (summary.supportUrl !== null && typeof summary.supportUrl !== 'string') ||
    !Array.isArray(summary.lockedSettings) ||
    !summary.lockedSettings.every((path) => typeof path === 'string') ||
    !isRecord(summary.limits) ||
    (summary.limits.maxApprovalMode !== undefined &&
      !isConcreteApprovalMode(summary.limits.maxApprovalMode))
  ) {
    return null;
  }
  return {
    state: 'loaded',
    source: { kind: source.kind, location: source.location },
    digest,
    summary: {
      organization: summary.organization,
      supportUrl: summary.supportUrl,
      lockedSettings: [...summary.lockedSettings],
      limits: isConcreteApprovalMode(summary.limits.maxApprovalMode)
        ? { maxApprovalMode: summary.limits.maxApprovalMode }
        : {},
    },
  };
}

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

/**
 * #4518: the refusal code for an approval posture broader than the managed
 * ceiling: a pick, a turn on a thread recorded above it, or a raised
 * default. Clients key on it to show the managed message instead of
 * offering a retry.
 */
export const MANAGED_POLICY_APPROVAL_CEILING_CODE =
  'managed-policy-approval-ceiling' as const;

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
