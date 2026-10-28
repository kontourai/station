/**
 * #3483: the outbound-after-untrusted-content permission.
 *
 * An integration can be classified as returning content written by others
 * (`ToolDef.contentTrust: 'untrusted'`, such as email). Once a turn has read
 * such content, each later tool call takes the person's untrusted-content
 * permission for that tool: their per-tool entry, then their integration
 * default, otherwise `ask`. A server's read-only hint can exempt a tool only
 * when nobody set an entry and the server's hints are trusted. This module
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
} from '@kontourai/station-contracts/tool';
import type { InvocationContext } from '../../runtime/types.js';

const UNTRUSTED_CONTENT_CHANGE_LIMIT = 50;

/** Conversations remembered per lineage set; the oldest is forgotten first. */
const CONVERSATION_MEMORY_LIMIT = 10_000;

function turnKey(invocation: InvocationContext): string {
  // A turn without a conversation shares its Agent's key, so concurrent
  // unscoped runs can only make each other ask, never skip a question.
  return JSON.stringify([
    invocation.agentSlug,
    invocation.conversationId ?? null,
    invocation.turnId ?? null,
  ]);
}

/** Insertion-ordered set that forgets its oldest member past a bound. */
class BoundedSet {
  private readonly members = new Set<string>();

  add(value: string | undefined): void {
    if (!value) return;
    this.members.delete(value);
    this.members.add(value);
    if (this.members.size > CONVERSATION_MEMORY_LIMIT)
      this.members.delete(this.members.values().next().value!);
  }

  has(value: string | undefined): boolean {
    return value !== undefined && this.members.has(value);
  }
}

/**
 * Which turns have read untrusted content, shared by every Agent's hooks so
 * delegation carries it both ways.
 *
 * A mark may still be resolving (the classification is read from the
 * integration's stored definition), so a reader awaits every pending mark
 * for its turn before answering. Beyond the turn, two in-process records
 * follow a delegation: a conversation that has read untrusted content makes
 * every child it delegates to start marked, and a child that reads it marks
 * its parent and root conversations, so a parent turn that reads a delegated
 * result is marked too. Both are memory only and do not survive a restart.
 */
export class UntrustedContentLedger {
  private readonly turns = new Map<string, Promise<boolean>[]>();
  private readonly conversationsRead = new BoundedSet();
  private readonly descendantsRead = new BoundedSet();

  mark(invocation: InvocationContext, untrusted: Promise<boolean>): void {
    const key = turnKey(invocation);
    // A failed classification read counts as untrusted: fail toward asking.
    const settled = untrusted.catch(() => true);
    this.turns.set(key, [...(this.turns.get(key) ?? []), settled]);
    void settled.then((read) => {
      if (read) {
        this.conversationsRead.add(invocation.conversationId);
        this.descendantsRead.add(invocation.delegation?.parentConversationId);
        this.descendantsRead.add(invocation.delegation?.rootConversationId);
        return;
      }
      // Only untrusted reads are kept, so ordinary calls never grow the map
      // even when a framework does not end the turn.
      const remaining = this.turns.get(key)?.filter((mark) => mark !== settled);
      if (remaining?.length) this.turns.set(key, remaining);
      else this.turns.delete(key);
    });
  }

  async hasRead(invocation: InvocationContext): Promise<boolean> {
    const delegation = invocation.delegation;
    if (
      delegation &&
      (this.conversationsRead.has(delegation.parentConversationId) ||
        this.conversationsRead.has(delegation.rootConversationId))
    )
      return true;
    const pending = this.turns.get(turnKey(invocation));
    if (!pending) return false;
    return (await Promise.all(pending)).some(Boolean);
  }

  /** Whether a child this conversation delegated to has read it. */
  hasDescendantRead(conversationId: string | undefined): boolean {
    return this.descendantsRead.has(conversationId);
  }

  /** The turn ended; its content no longer counts for the next one. */
  clear(invocation: InvocationContext): void {
    this.turns.delete(turnKey(invocation));
  }
}

/** The ledger every Agent's hooks share unless a caller supplies its own. */
export const sharedUntrustedContentLedger = new UntrustedContentLedger();

/**
 * The permission for one tool in a turn that has read untrusted content.
 * `undefined` means the rule does not apply: nobody set an entry, and the
 * server, whose hints are trusted, declares the tool read-only.
 *
 * An unreadable definition (`undefined`) has no entries and no trusted
 * hints, so it asks.
 */
export function untrustedContentDecision(
  def:
    | Pick<
        ToolDef,
        | 'probe'
        | 'untrustedContentPermissions'
        | 'contentTrust'
        | 'trustReadOnlyHints'
      >
    | undefined,
  toolName: string,
): UntrustedContentPermission | undefined {
  const permissions = def?.untrustedContentPermissions;
  const chosen = permissions?.tools?.[toolName] ?? permissions?.default;
  if (chosen) return chosen;
  // MCP annotations are the server's own claim; an untrusted server's claim
  // counts only when a catalog or the person said to trust it.
  const hintsTrusted =
    def !== undefined &&
    (def.contentTrust !== 'untrusted' || def.trustReadOnlyHints === true);
  const declared = def?.probe?.tools?.find((tool) => tool.name === toolName);
  if (hintsTrusted && declared?.readOnly === true) return undefined;
  return 'ask';
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The definition to store, with receipts taken from the stored copy (never
 * from the caller) and one appended when the classification, a permission or
 * the hint setting changed. Receipts are bounded to the most recent 50.
 */
export function withUntrustedContentChange(
  existing: ToolDef | undefined,
  next: ToolDef,
  by: string | undefined,
  now: Date,
): ToolDef {
  const result: ToolDef = { ...next };
  delete result.untrustedContentChanges;
  if (existing?.untrustedContentChanges?.length)
    result.untrustedContentChanges = existing.untrustedContentChanges;
  const trustChanged =
    (existing?.contentTrust ?? 'trusted') !== (next.contentTrust ?? 'trusted');
  const permissionsChanged = !same(
    existing?.untrustedContentPermissions,
    next.untrustedContentPermissions,
  );
  const hintsChanged =
    (existing?.trustReadOnlyHints ?? false) !==
    (next.trustReadOnlyHints ?? false);
  if (!trustChanged && !permissionsChanged && !hintsChanged) return result;
  const change: UntrustedContentChange = {
    at: now.toISOString(),
    ...(by ? { by } : {}),
    // Absent classification means trusted, so a removal records `trusted`.
    ...(trustChanged ? { contentTrust: next.contentTrust ?? 'trusted' } : {}),
    ...(permissionsChanged
      ? { permissions: next.untrustedContentPermissions ?? {} }
      : {}),
    ...(hintsChanged
      ? { trustReadOnlyHints: next.trustReadOnlyHints ?? false }
      : {}),
  };
  result.untrustedContentChanges = [
    ...(result.untrustedContentChanges ?? []),
    change,
  ].slice(-UNTRUSTED_CONTENT_CHANGE_LIMIT);
  return result;
}
