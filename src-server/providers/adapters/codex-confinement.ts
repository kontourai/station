import { isAbsolute, relative, resolve } from 'node:path';
import type {
  ConfinementPlan,
  ConfinementPosture,
} from '@kontourai/station-contracts/execution-confinement';
import {
  PROVIDER_CODEX,
  type StationConfinement,
} from '@kontourai/station-contracts/provider';
import {
  type ConfinementProvider,
  requiredConfinementLevel,
} from '../../security/confinement/confinement-provider.js';
import type {
  CodexSandboxMode,
  CodexSandboxPolicy,
} from './codex-approval-mode.js';

/**
 * #2494: what Codex's sandbox posture is derived from. `reported` is the
 * `sandbox` of Codex's own `thread/start`, `thread/resume` or `thread/fork`
 * response; `requested` is the mode Station sent, which says only whether
 * Station engaged the sandbox at all. It is never evidence that it applies.
 */
export interface CodexSandboxEvidence {
  requested: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined;
  reported: CodexSandboxPolicy | undefined;
  /** The resolved workspace the session was started in. */
  workspace?: string | undefined;
  /** Station-owned roots a confined engine may also write (its TMPDIR). */
  permittedRoots?: readonly string[];
  /**
   * #3800: the permission profile Station started the process under, when
   * it relies on one, and the `activePermissionProfile.id` Codex reported.
   * A sandbox Station relies on a profile for is confined only when Codex
   * reports that profile active: the legacy `sandbox` shape cannot show its
   * deny rules, and a thread-level `sandbox` or turn-level `sandboxPolicy`
   * silently replaces it.
   */
  requestedProfile?: string | undefined;
  reportedProfile?: string | undefined;
}

/**
 * #3800: the Codex permission profile a session not started as `host` runs
 * under. Its id is Station's; its definition is in
 * `codexConfinementConfigArgs`.
 */
export const STATION_CODEX_PERMISSION_PROFILE = 'station-workspace';

/**
 * Codex's `:workspace` (what `workspace-write` means: the workspace roots and
 * temp writable, the `.codex` at a root kept read-only) plus engine
 * configuration denied at any depth under every workspace root.
 *
 * Codex merges each `.codex/config.toml` from the project root down to the
 * cwd, and Station starts sessions in subdirectories, so a nested
 * `sub/.codex/config.toml` the agent writes configures every later session
 * started in `sub` (an `mcp_servers` command there runs outside the sandbox
 * at `thread/start`). `:workspace` protects only the `.codex` at a root.
 * `.claude` is the same class for a Claude session in that directory.
 *
 * Codex accepts only `deny` for a glob (a `read` glob is refused at
 * startup), so the agent cannot read these directories either; Codex's own
 * configuration loading runs outside the sandbox and is unaffected. The
 * subtree patterns cover a directory that already exists: the bare
 * directory pattern alone refuses creating one, but not writing inside a
 * checked-in one (EXECUTED, codex-cli 0.162.1, macOS).
 */
const STATION_CODEX_PERMISSION_PROFILE_DEFINITION = `permissions.${STATION_CODEX_PERMISSION_PROFILE}={extends=":workspace",filesystem={":workspace_roots"={"**/.codex"="deny","**/.codex/**"="deny","**/.claude"="deny","**/.claude/**"="deny"}}}`;

/** Whether the profile Station relies on, if any, is the one Codex reports. */
function profileApplied(evidence: CodexSandboxEvidence): boolean {
  return (
    evidence.requestedProfile === undefined ||
    evidence.reportedProfile === evidence.requestedProfile
  );
}

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Whether every extra writable root Codex reports lies inside the workspace
 * or a Station-owned root. Codex's own implicit roots (the cwd, `TMPDIR` and
 * `/tmp`, governed by the exclude flags) are not listed in `writableRoots`
 * and are part of what `workspaceWrite` means; a listed root such as `/` or
 * the home directory widens it past the workspace. Lexical: symlinks are not
 * resolved.
 */
function rootsConfined(
  roots: readonly string[],
  evidence: CodexSandboxEvidence,
): boolean {
  const allowed = [
    ...(evidence.workspace ? [evidence.workspace] : []),
    ...(evidence.permittedRoots ?? []),
  ];
  return roots.every((root) => allowed.some((base) => within(base, root)));
}

/**
 * #3800: the `codex app-server` arguments that keep a session not started
 * as `host` from being widened by configuration inside its own workspace.
 *
 * The session runs under Station's permission profile
 * (`STATION_CODEX_PERMISSION_PROFILE`), selected as `default_permissions`.
 * A `-c` override outranks every file layer (EXECUTED against codex-cli
 * 0.162.1: a user or project `sandbox_mode = "danger-full-access"` or
 * `default_permissions = ":danger-full-access"` still reports this profile),
 * and as a spawn argument it applies to every configuration load the process
 * makes (start, resume, fork, `config/read`). Station then sends no
 * `workspace-write` sandbox on the thread or turn: either replaces the
 * profile (`codexThreadSandboxRequest`, `planCodexTurnSandbox`).
 *
 * Tables merge across layers, so other layers can add entries to the
 * profile. The operator's own configuration can (`[permissions.
 * station-workspace.network] enabled = true` is how network is given to a
 * confined session); a repository's checked-in configuration can too, with
 * the trust its `.codex` already has. A writable root outside the workspace
 * still shows in the reported `writableRoots` and is refused there. The
 * agent cannot write a `.codex` under the workspace roots; one it stages in
 * temp and moves in is refused before the next start
 * (`findUnaccountedCodexConfig`).
 *
 * `sandbox_workspace_write.writable_roots` is pinned to none for a thread
 * that is not under the profile (a `read-only` review start, or a Codex
 * that does not apply it): a tightening restores the reported workspace
 * baseline, which must not carry a planted root. It does not mark the
 * project untrusted: Codex's untrusted mode would also drop the workspace's
 * `AGENTS.md` and change its default approval policy.
 *
 * The approval reviewer is pinned to a person for the same reason: with
 * `approvals_reviewer = "auto_review"` (from any layer) a model approves a
 * sandbox escalation, and a confined session would leave its sandbox with
 * no Station approval card. Appended last, so all of these also outrank a
 * connection's own arguments.
 */
export function codexConfinementConfigArgs(
  confinement: StationConfinement | undefined,
): string[] {
  return confinement === 'host'
    ? []
    : [
        '-c',
        `default_permissions="${STATION_CODEX_PERMISSION_PROFILE}"`,
        '-c',
        STATION_CODEX_PERMISSION_PROFILE_DEFINITION,
        '-c',
        'sandbox_workspace_write.writable_roots=[]',
        '-c',
        'approvals_reviewer="user"',
      ];
}

/**
 * #3800: the thread-level `sandbox` mode to send. Outside a `host` session
 * `workspace-write` is Station's permission profile, which the spawn already
 * selects; sending the mode would replace the profile with Codex's legacy
 * workspace-write (EXECUTED: `activePermissionProfile` then reads `null`).
 * `read-only` is still sent: it is narrower than the profile.
 */
export function codexThreadSandboxRequest(
  sandbox: CodexSandboxMode | undefined,
  confinement: StationConfinement | undefined,
): CodexSandboxMode | undefined {
  return sandbox === 'workspace-write' && confinement !== 'host'
    ? undefined
    : sandbox;
}

/**
 * #2494 D3: why Codex's report is not a confinement, for a refusal the
 * operator can act on, or `undefined` when it is one.
 */
export function describeCodexSandboxGap(
  evidence: CodexSandboxEvidence,
): string | undefined {
  const reported = evidence.reported;
  if (reported?.type === 'readOnly') return undefined;
  if (reported?.type === 'workspaceWrite' && !profileApplied(evidence))
    return `Codex did not report Station's permission profile \`${evidence.requestedProfile}\` active${evidence.reportedProfile ? ` (it reported \`${evidence.reportedProfile}\`)` : ''}, so its deny rules for engine configuration are not in force. Update Codex to a version with permission profiles, or run the session as the operator (a host session).`;
  if (reported?.type === 'workspaceWrite') {
    const allowed = [
      ...(evidence.workspace ? [evidence.workspace] : []),
      ...(evidence.permittedRoots ?? []),
    ];
    const outside = reported.writableRoots.filter(
      (root) => !allowed.some((base) => within(base, root)),
    );
    return outside.length > 0
      ? `Codex reported writable roots outside the workspace: ${outside.join(', ')}. Remove them from Codex's \`sandbox_workspace_write.writable_roots\` configuration, or run the session as the operator (a host session).`
      : undefined;
  }
  return reported
    ? `Codex reported its sandbox as ${reported.type} instead of the workspace-write Station asked for. Change Codex's sandbox configuration, or run the session as the operator (a host session).`
    : 'Codex did not report the sandbox it applied.';
}

/**
 * Codex's sandbox posture, from the policy Codex reports it applied (its
 * response, not a kernel observation):
 *
 * - `readOnly`, or `workspaceWrite` whose extra writable roots all lie in
 *   the workspace or a Station-owned root and, when Station relies on its
 *   permission profile, under that profile: `confined`.
 * - `workspaceWrite` with a root outside those (`/`, the home directory,
 *   another checkout), or without the profile Station relies on:
 *   `configured-but-failed`.
 * - Otherwise (`dangerFullAccess`, an `externalSandbox` Station cannot see,
 *   or nothing), the sandbox is not reported applied:
 *   `configured-but-failed` when Station asked for one, else
 *   `no-mechanism`.
 */
export function observeCodexSandboxPosture(
  evidence: CodexSandboxEvidence | undefined,
): ConfinementPosture {
  const reported = evidence?.reported;
  if (reported?.type === 'readOnly') return 'confined';
  if (reported?.type === 'workspaceWrite')
    return profileApplied(evidence!) &&
      rootsConfined(reported.writableRoots, evidence!)
      ? 'confined'
      : 'configured-but-failed';
  return evidence?.requested === 'workspace-write' ||
    evidence?.requested === 'read-only'
    ? 'configured-but-failed'
    : 'no-mechanism';
}

/**
 * #2494 F5: the plan a start is held to once Codex has answered. The policy
 * requires confinement for a workspace session whose engine runs at `never`;
 * Station's own knobs are one source of that, the approval policy Codex
 * reports in the same response is the other (its configuration can put a
 * session Station sent no knobs to at `never`). Either one makes it
 * required.
 */
export function requiredByReportedPolicy(
  plan: ConfinementPlan | undefined,
  reportedApprovalPolicy: unknown,
): ConfinementPlan | undefined {
  if (plan?.requiredLevel !== 'host') return plan;
  const requiredLevel = requiredConfinementLevel(
    plan.policyBasis === 'workspace-floor' ? 'workspace' : 'host',
    reportedApprovalPolicy === 'never' ? 'never' : undefined,
  );
  return requiredLevel === 'host' ? plan : { ...plan, requiredLevel };
}

/**
 * Codex's own sandbox as an engine-native `os-profile` provider (Seatbelt on
 * macOS, Landlock/seccomp on Linux, applied by Codex itself). It wraps no
 * spawn: Station sends the sandbox on the thread request and reads back what
 * Codex says it applied.
 */
export const codexSandboxConfinementProvider: ConfinementProvider<CodexSandboxEvidence> =
  {
    level: 'os-profile',
    mechanism: 'codex-sandbox',
    workspaceAccess: 'mounted',
    supportedIsolationModes: ['shared', 'worktree'],
    engagement: 'engine-native',
    engines: [PROVIDER_CODEX],
    availability: () => ({
      available: true,
      reason:
        "Codex applies its own sandbox; Station reads it back from Codex's thread response",
    }),
    confine: (spec) => ({
      spec,
      pending: { observe: observeCodexSandboxPosture },
    }),
  };
