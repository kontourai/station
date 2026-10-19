import { isAbsolute, relative, resolve } from 'node:path';
import type {
  ConfinementPlan,
  ConfinementPosture,
} from '@kontourai/station-contracts/execution-confinement';
import { PROVIDER_CODEX } from '@kontourai/station-contracts/provider';
import {
  type ConfinementProvider,
  requiredConfinementLevel,
} from '../../security/confinement/confinement-provider.js';
import type { CodexSandboxPolicy } from './codex-approval-mode.js';

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
 * #2494 D3: why Codex's report is not a confinement, for a refusal the
 * operator can act on, or `undefined` when it is one.
 */
export function describeCodexSandboxGap(
  evidence: CodexSandboxEvidence,
): string | undefined {
  const reported = evidence.reported;
  if (reported?.type === 'readOnly') return undefined;
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
 *   the workspace or a Station-owned root: `confined`.
 * - `workspaceWrite` with a root outside those (`/`, the home directory,
 *   another checkout): `configured-but-failed`.
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
    return rootsConfined(reported.writableRoots, evidence!)
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
