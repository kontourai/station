import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalMode } from '@kontourai/station-contracts/provider';
import { readApprovalMode } from '@kontourai/station-contracts/provider';

const CLAUDE_APPROVAL_MODE_MAP: Record<
  Exclude<ApprovalMode, 'connection-default'>,
  PermissionMode
> = {
  // Claude Code's own default mode. On its OWN that is not "ask before every
  // tool call" — it consults the engine's command classifier and every
  // settings file the CLI loaded (`~/.claude/settings.json`, a workspace's
  // checked-in `.claude/settings.json`, `.claude/settings.local.json`; the
  // session sets no `settingSources`, so all of them apply) and runs whatever
  // those already allow without asking anyone. Station's `ask` promise is made
  // true one layer up, by the `PreToolUse` hook answering
  // `permissionDecision: 'ask'` for any call Station's own policy did not
  // decide — see `preToolPolicyHookOutput` and
  // `claudePermissionModeForcesAsk` in claude-adapter.ts. Without that hook
  // (an agent-less/synthetic session, which gets no staged policy at all)
  // this mode means exactly what the engine says and nothing more.
  ask: 'default',
  // Auto-accept file edits within the workspace; still ask before
  // anything riskier (e.g. shell commands outside that boundary). The hook
  // states no opinion here, so this is the engine's own behavior.
  auto: 'acceptEdits',
  // Never ask; the agent runs fully autonomously. Requires
  // `allowDangerouslySkipPermissions: true` in Options — see
  // claude-adapter.ts's session-start/sendTurn wiring, which is the only
  // place that flag can be granted (the SDK forbids setting it mid-session).
  never: 'bypassPermissions',
};

/**
 * Pure mapping: a resolved `ApprovalMode` to Claude Code's native
 * `PermissionMode`. Returns `undefined` for `'connection-default'` (or an
 * absent/unrecognized mode) so callers can fall back to their own existing
 * default without this module asserting one.
 */
export function mapApprovalModeToPermissionMode(
  mode: ApprovalMode | undefined,
): PermissionMode | undefined {
  if (!mode || mode === 'connection-default') return undefined;
  return CLAUDE_APPROVAL_MODE_MAP[mode];
}

/** Reads `approvalMode` out of a `modelOptions` bag and maps it directly. */
export function resolveClaudePermissionMode(
  modelOptions?: Record<string, unknown>,
): PermissionMode | undefined {
  return mapApprovalModeToPermissionMode(readApprovalMode(modelOptions));
}

/**
 * Reverse mapping used only to tell the client what Station-level
 * `ApprovalMode` a live `PermissionMode` corresponds to, so a rejected
 * mid-session escalation (see claude-adapter.ts sendTurn) can report which
 * mode is *actually* still in effect. `'plan'` has no `ApprovalMode`
 * analog (it predates this feature and isn't reachable through the
 * composer chip), so it intentionally maps to `undefined`.
 */
export function mapPermissionModeToApprovalMode(
  mode: PermissionMode,
): ApprovalMode | undefined {
  switch (mode) {
    case 'default':
      return 'ask';
    case 'acceptEdits':
      return 'auto';
    case 'bypassPermissions':
      return 'never';
    default:
      return undefined;
  }
}
