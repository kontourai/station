import type { ConfinementPosture } from '@kontourai/station-contracts/execution-confinement';
import { PROVIDER_CODEX } from '@kontourai/station-contracts/provider';
import type { ConfinementProvider } from '../../security/confinement/confinement-provider.js';
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
}

/**
 * Codex's sandbox posture, from Codex's response:
 *
 * - Codex reports `workspaceWrite` or `readOnly`: `confined`.
 * - Otherwise (it reports `dangerFullAccess`, an `externalSandbox` Station
 *   cannot see, or nothing), the sandbox is not shown in force:
 *   `configured-but-failed` when Station asked for one, else
 *   `no-mechanism`.
 */
export function observeCodexSandboxPosture(
  evidence: CodexSandboxEvidence | undefined,
): ConfinementPosture {
  const reported = evidence?.reported?.type;
  if (reported === 'workspaceWrite' || reported === 'readOnly')
    return 'confined';
  return evidence?.requested === 'workspace-write' ||
    evidence?.requested === 'read-only'
    ? 'configured-but-failed'
    : 'no-mechanism';
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
