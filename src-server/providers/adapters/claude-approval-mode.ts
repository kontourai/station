import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalMode } from '@kontourai/station-contracts/provider';
import { readApprovalMode } from '@kontourai/station-contracts/provider';

const CLAUDE_APPROVAL_MODE_MAP: Record<
  Exclude<ApprovalMode, 'connection-default'>,
  PermissionMode
> = {
  // Claude Code's own default mode — NOT "ask before every tool call". The
  // engine asks before calls its own rules and read-only classifier do not
  // already allow, and Station adds no floor over that.
  //
  // Accepted gap (#1545): Station sets no `settingSources`, so those rules
  // include a trusted workspace's checked-in `.claude/settings.json`. A
  // repository the operator has trusted in Claude Code can allow a tool call
  // with no Station approval request — a same-user threat model, and narrowing
  // the cascade would cost that repository's own `CLAUDE.md` and `.mcp.json`
  // servers. What Station guarantees instead is that a call which IS prompted
  // arrives with its command shown (`toolRequestPreview`), never a bare tool
  // name. See the `settingSources` comment in claude-adapter.ts and
  // docs/conformance/tool-policy-delivery.md.
  ask: 'default',
  // Auto-accept file edits within the workspace; still ask before
  // anything riskier (e.g. shell commands outside that boundary).
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
