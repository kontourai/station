import type {
  ApprovalMode,
  StationConfinement,
} from '@kontourai/station-contracts/provider';
import { readApprovalMode } from '@kontourai/station-contracts/provider';

/**
 * Codex's own vocabulary for `thread/start` (and `turn/start`)'s
 * `approvalPolicy` / `sandbox` fields, mirrored from the app-server
 * protocol's `AskForApproval` / `SandboxPolicy` enums. `on-failure` is a
 * valid Codex value but unused by Station's mapping (no `ApprovalMode`
 * maps to it), so it's intentionally omitted here rather than carried as
 * dead vocabulary.
 */
type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface CodexApprovalKnobs {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
}

// Historical Station spawn when no `approvalMode` was sent: unattended
// full-access. Kept only as a named pairing for tests that pin that
// *previous* behavior. Live adapters no longer apply it — an omitted
// `approvalMode` now inherits Codex's own config (station#1950).
export const CODEX_DEFAULT_APPROVAL_KNOBS: CodexApprovalKnobs = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
};

const CODEX_READ_ONLY_REVIEW_KNOBS: CodexApprovalKnobs = {
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

/**
 * #2493: `never` for a session confined to its workspace. Codex still asks
 * nothing, but its native sandbox keeps writes inside the workspace; only a
 * `host` session gets `danger-full-access`.
 */
const CODEX_CONFINED_NEVER_KNOBS: CodexApprovalKnobs = {
  approvalPolicy: 'never',
  sandbox: 'workspace-write',
};

/**
 * Pure mapping: a resolved `ApprovalMode` and the session's confinement to
 * Codex's native knobs. A `host` session gets exactly the historical table;
 * anything else (absent included) confines `never` to the workspace.
 */
export function mapApprovalModeToCodex(
  mode: ApprovalMode | undefined,
  confinement: StationConfinement | undefined,
): CodexApprovalKnobs | undefined {
  if (!mode || mode === 'connection-default') return undefined;
  if (mode === 'never' && confinement !== 'host')
    return CODEX_CONFINED_NEVER_KNOBS;
  return CODEX_APPROVAL_MODE_MAP[mode];
}

/** Reads `approvalMode` out of a `modelOptions` bag and maps it directly. */
export function resolveCodexApprovalKnobs(
  modelOptions: Record<string, unknown> | undefined,
  confinement: StationConfinement | undefined,
): CodexApprovalKnobs | undefined {
  return mapApprovalModeToCodex(readApprovalMode(modelOptions), confinement);
}

/**
 * Server review isolation outranks user/session approval preferences and
 * confinement. The no-escalation + native read-only pair is the structural
 * mutation boundary.
 */
export function resolveCodexExecutionKnobs(
  modelOptions: Record<string, unknown> | undefined,
  reviewIsolation: { workspaceAccess: 'read-only' } | undefined,
  confinement: StationConfinement | undefined,
): CodexApprovalKnobs | undefined {
  return reviewIsolation?.workspaceAccess === 'read-only'
    ? CODEX_READ_ONLY_REVIEW_KNOBS
    : resolveCodexApprovalKnobs(modelOptions, confinement);
}

/**
 * Reverse mapping used only to tell the client which Station-level
 * `ApprovalMode` a knob pair Station sent corresponds to, so durable events
 * (`session.configured`, `turn.started`) can carry the actually-applied
 * `approvalMode` alongside the raw Codex knobs (archive#727 review round 3,
 * item 1).
 *
 * Not an inverse of `mapApprovalModeToCodex`: that mapping also depends on
 * confinement, and two pairs (`never` + `danger-full-access` for a `host`
 * session, `never` + `workspace-write` for a confined one) both report
 * `never`. The pair therefore says nothing about confinement; the session's
 * confinement is reported beside it and restored from its start stamp, never
 * from this mapping. The review-isolation pair (`never` + `read-only`) and
 * any pair Station never sends report `connection-default`.
 */
export function mapCodexKnobsToApprovalMode(
  knobs: CodexApprovalKnobs,
): ApprovalMode {
  switch (`${knobs.approvalPolicy}:${knobs.sandbox}`) {
    case 'untrusted:workspace-write':
      return 'ask';
    case 'on-request:workspace-write':
      return 'auto';
    case 'never:danger-full-access':
    case 'never:workspace-write':
      return 'never';
    default:
      return 'connection-default';
  }
}
