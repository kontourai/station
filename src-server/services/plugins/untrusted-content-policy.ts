/**
 * #3483: the outbound-after-untrusted-content permission.
 *
 * An integration can be classified as returning content written by others
 * (`ToolDef.contentTrust: 'untrusted'`, such as email). Once a turn has read
 * such content, a tool that its server does not declare read-only takes the
 * person's untrusted-content permission for that tool: `ask` by default,
 * changeable per integration and per tool to `allow` or `deny`. This module
 * holds the turn state and the pure decision; the staged pre-tool evaluator
 * applies it, so the existing approval request, guardian and delegation
 * rules answer an `ask` exactly as they answer any other.
 *
 * Coverage: Station enforces this where it dispatches tools itself (the
 * Station engine's hooks). External engines (Claude Code, Codex) reach MCP
 * servers through their own clients or Station's passthrough and do not
 * report tool results to these hooks; see
 * docs/design/mcp-subregistry-curation.md for the exact gap.
 */

import type {
  ToolDef,
  UntrustedContentChange,
  UntrustedContentPermission,
  UntrustedContentPermissions,
} from '@kontourai/station-contracts/tool';
import type { InvocationContext } from '../../runtime/types.js';

export const UNTRUSTED_CONTENT_CHANGE_LIMIT = 50;

/** Absent configuration means ask. */
export const DEFAULT_UNTRUSTED_CONTENT_PERMISSION: UntrustedContentPermission =
  'ask';

function turnKey(invocation: InvocationContext): string {
  // A turn without a conversation shares its Agent's key, so concurrent
  // unscoped runs can only make each other ask, never skip a question.
  return JSON.stringify([
    invocation.agentSlug,
    invocation.conversationId ?? null,
    invocation.turnId ?? null,
  ]);
}

/**
 * Which turns have read untrusted content. A mark may still be resolving
 * (the classification is read from the integration's stored definition), so
 * a reader awaits every pending mark for its turn before answering.
 */
export class UntrustedContentLedger {
  private readonly turns = new Map<string, Promise<boolean>[]>();

  mark(invocation: InvocationContext, untrusted: Promise<boolean>): void {
    const key = turnKey(invocation);
    // A failed classification read counts as untrusted: fail toward asking.
    const settled = untrusted.catch(() => true);
    this.turns.set(key, [...(this.turns.get(key) ?? []), settled]);
  }

  async hasRead(invocation: InvocationContext): Promise<boolean> {
    const pending = this.turns.get(turnKey(invocation));
    if (!pending) return false;
    return (await Promise.all(pending)).some(Boolean);
  }

  /** The turn ended; its content no longer counts for the next one. */
  clear(invocation: InvocationContext): void {
    this.turns.delete(turnKey(invocation));
  }
}

/**
 * The permission for one tool in a turn that has read untrusted content.
 * `undefined` means the rule does not apply: the server declares the tool
 * read-only.
 */
export function untrustedContentDecision(
  def: Pick<ToolDef, 'probe' | 'untrustedContentPermissions'> | undefined,
  toolName: string,
): UntrustedContentPermission | undefined {
  const declared = def?.probe?.tools?.find((tool) => tool.name === toolName);
  if (declared?.readOnly === true) return undefined;
  const permissions = def?.untrustedContentPermissions;
  return (
    permissions?.tools?.[toolName] ??
    permissions?.default ??
    DEFAULT_UNTRUSTED_CONTENT_PERMISSION
  );
}

export interface UntrustedContentUpdate {
  contentTrust?: 'untrusted' | 'trusted';
  untrustedContentPermissions?: UntrustedContentPermissions;
}

function samePermissions(
  a: UntrustedContentPermissions | undefined,
  b: UntrustedContentPermissions | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The definition after a person's change, with a receipt appended when the
 * classification or a permission actually changed. Receipts are bounded to
 * the most recent {@link UNTRUSTED_CONTENT_CHANGE_LIMIT}. A submitted
 * receipt list is never taken from the caller.
 */
export function withUntrustedContentChange(
  existing: ToolDef,
  next: ToolDef,
  by: string | undefined,
  now: Date,
): ToolDef {
  const result: ToolDef = {
    ...next,
    untrustedContentChanges: existing.untrustedContentChanges,
  };
  if (!result.untrustedContentChanges) delete result.untrustedContentChanges;
  const trustChanged = existing.contentTrust !== next.contentTrust;
  const permissionsChanged = !samePermissions(
    existing.untrustedContentPermissions,
    next.untrustedContentPermissions,
  );
  if (!trustChanged && !permissionsChanged) return result;
  const change: UntrustedContentChange = {
    at: now.toISOString(),
    ...(by ? { by } : {}),
    // Absent classification means trusted, so a removal records `trusted`.
    ...(trustChanged ? { contentTrust: next.contentTrust ?? 'trusted' } : {}),
    ...(permissionsChanged
      ? { permissions: next.untrustedContentPermissions ?? {} }
      : {}),
  };
  result.untrustedContentChanges = [
    ...(existing.untrustedContentChanges ?? []),
    change,
  ].slice(-UNTRUSTED_CONTENT_CHANGE_LIMIT);
  return result;
}
