import type { ApprovalMode } from '@kontourai/station-contracts/provider';
import { readApprovalMode } from '@kontourai/station-contracts/provider';

/**
 * Codex's own vocabulary for `thread/start` (and `turn/start`)'s
 * `approvalPolicy` / `sandbox` fields, mirrored from the app-server
 * protocol's `AskForApproval` / `SandboxPolicy` enums. `on-failure` is a
 * valid Codex value but unused by Station's mapping (no `ApprovalMode`
 * maps to it), so it's intentionally omitted here rather than carried as
 * dead vocabulary.
 */
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type CodexSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

export interface CodexApprovalKnobs {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
}

// Station's prior behavior before this session-level control existed —
// unattended, full-access. Kept as the fallback for `'connection-default'`
// (or an absent/unrecognized value) so omitting `approvalMode` never
// changes an existing session's behavior.
export const CODEX_DEFAULT_APPROVAL_KNOBS: CodexApprovalKnobs = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
};

export const CODEX_READ_ONLY_REVIEW_KNOBS: CodexApprovalKnobs = {
  approvalPolicy: 'never',
  sandbox: 'read-only',
};

const CODEX_APPROVAL_MODE_MAP: Record<
  Exclude<ApprovalMode, 'connection-default'>,
  CodexApprovalKnobs
> = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  never: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

/** Pure mapping: a resolved `ApprovalMode` to Codex's native knobs. */
export function mapApprovalModeToCodex(
  mode: ApprovalMode | undefined,
): CodexApprovalKnobs {
  if (!mode || mode === 'connection-default') {
    return CODEX_DEFAULT_APPROVAL_KNOBS;
  }
  return CODEX_APPROVAL_MODE_MAP[mode];
}

/** Reads `approvalMode` out of a `modelOptions` bag and maps it directly. */
export function resolveCodexApprovalKnobs(
  modelOptions?: Record<string, unknown>,
): CodexApprovalKnobs {
  return mapApprovalModeToCodex(readApprovalMode(modelOptions));
}

/**
 * Server review isolation outranks user/session approval preferences. The
 * no-escalation + native read-only pair is the structural mutation boundary.
 */
export function resolveCodexExecutionKnobs(
  modelOptions?: Record<string, unknown>,
  reviewIsolation?: { workspaceAccess: 'read-only' },
): CodexApprovalKnobs {
  return reviewIsolation?.workspaceAccess === 'read-only'
    ? CODEX_READ_ONLY_REVIEW_KNOBS
    : resolveCodexApprovalKnobs(modelOptions);
}

/**
 * Reverse mapping used only to tell the client which Station-level
 * `ApprovalMode` a resolved knob pair corresponds to, so durable events
 * (`session.configured`, `turn.started`) can carry the actually-applied
 * `approvalMode` alongside the raw Codex knobs (#727 review round 3, item
 * 1). Every pair `CODEX_APPROVAL_MODE_MAP` and `CODEX_DEFAULT_APPROVAL_KNOBS`
 * produce is unique, so this is a total, lossless inverse of
 * `mapApprovalModeToCodex` for every knob pair Station itself ever sends.
 */
export function mapCodexKnobsToApprovalMode(
  knobs: CodexApprovalKnobs,
): ApprovalMode {
  for (const [mode, mapped] of Object.entries(CODEX_APPROVAL_MODE_MAP)) {
    if (
      mapped.approvalPolicy === knobs.approvalPolicy &&
      mapped.sandbox === knobs.sandbox
    ) {
      return mode as ApprovalMode;
    }
  }
  // Unrecognized pair (e.g. a knob combination Station never sends) — no
  // ApprovalMode analog, so report the sentinel rather than guessing.
  return 'connection-default';
}
