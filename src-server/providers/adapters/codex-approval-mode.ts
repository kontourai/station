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

/**
 * #2559: Codex's `SandboxPolicy`, the shape `thread/start`, `thread/resume`
 * and `thread/fork` report as the thread's `sandbox`, and the only per-turn
 * sandbox override `turn/start` accepts (`sandboxPolicy`; its `sandbox` mode
 * string is ignored there). Mirrored from Codex 0.155.1's generated
 * `v2/SandboxPolicy.ts`.
 */
export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'externalSandbox'; networkAccess: 'restricted' | 'enabled' }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

/** The thread's reported sandbox, or `undefined` when it is not one Codex defines. */
export function readCodexSandboxPolicy(
  value: unknown,
): CodexSandboxPolicy | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const policy = value as Record<string, unknown>;
  switch (policy.type) {
    case 'dangerFullAccess':
      return { type: 'dangerFullAccess' };
    case 'readOnly':
      return typeof policy.networkAccess === 'boolean'
        ? { type: 'readOnly', networkAccess: policy.networkAccess }
        : undefined;
    case 'externalSandbox':
      return policy.networkAccess === 'restricted' ||
        policy.networkAccess === 'enabled'
        ? { type: 'externalSandbox', networkAccess: policy.networkAccess }
        : undefined;
    case 'workspaceWrite':
      return Array.isArray(policy.writableRoots) &&
        policy.writableRoots.every((root) => typeof root === 'string') &&
        typeof policy.networkAccess === 'boolean' &&
        typeof policy.excludeTmpdirEnvVar === 'boolean' &&
        typeof policy.excludeSlashTmp === 'boolean'
        ? {
            type: 'workspaceWrite',
            writableRoots: [...(policy.writableRoots as string[])],
            networkAccess: policy.networkAccess,
            excludeTmpdirEnvVar: policy.excludeTmpdirEnvVar,
            excludeSlashTmp: policy.excludeSlashTmp,
          }
        : undefined;
    default:
      return undefined;
  }
}

/** The Station sandbox mode a policy is; `externalSandbox` has none. */
export function codexSandboxModeOfPolicy(
  policy: CodexSandboxPolicy | undefined,
): CodexSandboxMode | undefined {
  switch (policy?.type) {
    case 'dangerFullAccess':
      return 'danger-full-access';
    case 'workspaceWrite':
      return 'workspace-write';
    case 'readOnly':
      return 'read-only';
    default:
      return undefined;
  }
}

/** What a thread is known to be sandboxed to right now. */
export interface CodexThreadSandbox {
  /** Codex's own report (thread response), or the policy Station last sent. */
  policy?: CodexSandboxPolicy;
  /** The mode Station asked for at thread start when Codex reported none. */
  requestedMode?: CodexSandboxMode;
  /**
   * The first `workspaceWrite` policy Codex itself reported for the thread:
   * its own configuration's writable roots, network and exclude flags. A
   * tightening back to workspace-write restores exactly this, so it never
   * gains network or roots the user's config did not give.
   */
  workspaceBaseline?: Extract<CodexSandboxPolicy, { type: 'workspaceWrite' }>;
}

/** A thread's sandbox as Codex reported it at start, resume or fork. */
export function reportedCodexThreadSandbox(
  reported: CodexSandboxPolicy | undefined,
  requestedMode: CodexSandboxMode | undefined,
): CodexThreadSandbox {
  if (!reported) return requestedMode ? { requestedMode } : {};
  return {
    policy: reported,
    ...(reported.type === 'workspaceWrite'
      ? { workspaceBaseline: reported }
      : {}),
  };
}

type CodexTurnSandboxPlan = {
  /** The per-turn override to send; absent when the thread stays as it is. */
  sandboxPolicy?: CodexSandboxPolicy;
  /** The mode the turn runs in; absent only when neither is known. */
  applied?: CodexSandboxMode;
};

/**
 * #2559: the per-turn `sandboxPolicy` a turn must send, and the sandbox mode
 * the turn then actually runs in.
 *
 * - A thread whose sandbox is `readOnly` is a floor nothing Station sends
 *   may loosen. That covers both a read-only Codex reported against what
 *   Station asked (its configuration or a managed requirement won) and a
 *   read-only Station itself chose (review isolation's knobs, or a
 *   `readOnly` policy Station sent), since the recorded policy is whichever
 *   the thread last had.
 * - Outside a `host` session a thread at full access is pulled to
 *   workspace-write on EVERY turn, with or without a posture on it: a thread
 *   the user's own Codex config started unconfined, or an adopted session
 *   whose fork inherited its source's sandbox, is still confined.
 * - Otherwise the turn's posture decides; no posture keeps the thread as it
 *   is, and a posture the thread already satisfies sends nothing, so the
 *   thread's own configuration keeps governing.
 * - `danger-full-access` is only ever sent to a `host` session.
 * - A workspace-write policy is the thread's `workspaceBaseline` when Codex
 *   reported one, else no network, no extra roots and no excludes: a
 *   tightening never gains what the thread's own configuration did not
 *   give.
 */
export function planCodexTurnSandbox(
  desired: CodexApprovalKnobs,
  thread: CodexThreadSandbox,
  confinement: StationConfinement | undefined,
): CodexTurnSandboxPlan & { applied: CodexSandboxMode };
export function planCodexTurnSandbox(
  desired: CodexApprovalKnobs | undefined,
  thread: CodexThreadSandbox,
  confinement: StationConfinement | undefined,
): CodexTurnSandboxPlan;
export function planCodexTurnSandbox(
  desired: CodexApprovalKnobs | undefined,
  thread: CodexThreadSandbox,
  confinement: StationConfinement | undefined,
): CodexTurnSandboxPlan {
  const current = thread.policy
    ? codexSandboxModeOfPolicy(thread.policy)
    : thread.requestedMode;
  if (thread.policy?.type === 'readOnly') return { applied: 'read-only' };
  const asked = desired?.sandbox ?? current;
  const wanted: CodexSandboxMode | undefined =
    asked === 'danger-full-access' && confinement !== 'host'
      ? 'workspace-write'
      : asked;
  if (!wanted) return {};
  if (wanted === current) return { applied: current };
  switch (wanted) {
    case 'danger-full-access':
      return {
        sandboxPolicy: { type: 'dangerFullAccess' },
        applied: wanted,
      };
    case 'read-only':
      return {
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        applied: wanted,
      };
    case 'workspace-write':
      return {
        sandboxPolicy: thread.workspaceBaseline
          ? {
              ...thread.workspaceBaseline,
              writableRoots: [...thread.workspaceBaseline.writableRoots],
            }
          : {
              type: 'workspaceWrite',
              writableRoots: [],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
        applied: wanted,
      };
  }
}
