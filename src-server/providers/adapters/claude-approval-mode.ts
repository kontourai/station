import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalMode } from '@kontourai/station-contracts/provider';
import { readApprovalMode } from '@kontourai/station-contracts/provider';

const CLAUDE_APPROVAL_MODE_MAP: Record<
  Exclude<ApprovalMode, 'connection-default'>,
  PermissionMode
> = {
  // Claude Code's own default mode: the engine asks before tool calls its own
  // rules and classifier do not already allow. Not "ask before every tool
  // call" — its read-only-command classifier allows some calls outright, and
  // the user's and the workspace's Claude settings files apply (no
  // `settingSources` is set, so the CLI loads them all), so a rule in one of
  // those allows a call without a Station request. Station adds no floor over
  // that: `preToolPolicyHookOutput` (claude-adapter.ts) states no permission
  // opinion for a call Station's own policy did not decide, and the engine's
  // consent path reaches Station through `canUseTool`.
  //
  // Accepted gap (#1545), not an oversight: narrowing the cascade would cost
  // that repository's own `CLAUDE.md` and `.mcp.json` servers, and the
  // project/local tiers only apply to a workspace the operator has trusted in
  // Claude Code — a same-user threat model. What Station guarantees instead is
  // that a call which IS prompted arrives naming its command or file
  // (`toolRequestPreview`), never a bare tool name. See the `settingSources`
  // comment in claude-adapter.ts and docs/conformance/tool-policy-delivery.md.
  ask: 'default',
  // Auto-accept file edits within the workspace; still ask before
  // anything riskier (e.g. shell commands outside that boundary). The hook
  // states no opinion here either, so this is the engine's own behavior.
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
