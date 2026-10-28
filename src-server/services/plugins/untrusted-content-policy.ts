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
  UntrustedContentPermission,
} from '@kontourai/station-contracts/tool';
import type { InvocationContext } from '../../runtime/types.js';

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

/**
 * Insertion-ordered set that forgets its oldest member past a bound, except
 * members an active turn still depends on, which are never forgotten.
 */
class BoundedSet {
  private readonly members = new Set<string>();

  constructor(private readonly pinned: (value: string) => boolean) {}

  add(value: string | undefined): void {
    if (!value) return;
    this.members.delete(value);
    this.members.add(value);
    if (this.members.size <= CONVERSATION_MEMORY_LIMIT) return;
    for (const member of this.members) {
      if (this.pinned(member)) continue;
      this.members.delete(member);
      return;
    }
  }

  has(value: string | undefined): boolean {
    return value !== undefined && this.members.has(value);
  }
}

interface TurnState {
  marks: Promise<boolean>[];
  /** Conversations this turn depends on: its own, its parent and root. */
  references: Set<string>;
  /** Inherited from a delegation and fixed for the rest of the turn. */
  latched: boolean;
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
 * result is marked too. A child latches the inherited mark into its own turn
 * the first time the ledger sees it, and a record an active turn depends on
 * is never forgotten, so neither a later change nor the memory bound can
 * clear the question mid-turn. Both records are memory only and do not
 * survive a restart.
 */
export class UntrustedContentLedger {
  private readonly turns = new Map<string, TurnState>();
  private readonly pinned = (conversationId: string) => {
    for (const turn of this.turns.values())
      if (turn.references.has(conversationId)) return true;
    return false;
  };
  private readonly conversationsRead = new BoundedSet(this.pinned);
  private readonly descendantsRead = new BoundedSet(this.pinned);

  private turn(invocation: InvocationContext): TurnState {
    const key = turnKey(invocation);
    let state = this.turns.get(key);
    if (!state) {
      state = {
        marks: [],
        references: new Set(
          [
            invocation.conversationId,
            invocation.delegation?.parentConversationId,
            invocation.delegation?.rootConversationId,
          ].filter((id): id is string => !!id),
        ),
        latched: false,
      };
      this.turns.set(key, state);
    }
    return state;
  }

  /** Fixes a mark inherited through delegation into this turn. */
  private latchInherited(invocation: InvocationContext): void {
    const delegation = invocation.delegation;
    if (
      !delegation ||
      !(
        this.conversationsRead.has(delegation.parentConversationId) ||
        this.conversationsRead.has(delegation.rootConversationId)
      )
    )
      return;
    const state = this.turn(invocation);
    if (state.latched) return;
    state.latched = true;
    state.marks.push(Promise.resolve(true));
  }

  mark(invocation: InvocationContext, untrusted: Promise<boolean>): void {
    this.latchInherited(invocation);
    const state = this.turn(invocation);
    // A failed classification read counts as untrusted: fail toward asking.
    const settled = untrusted.catch(() => true);
    state.marks.push(settled);
    void settled.then((read) => {
      if (read) {
        this.conversationsRead.add(invocation.conversationId);
        this.descendantsRead.add(invocation.delegation?.parentConversationId);
        this.descendantsRead.add(invocation.delegation?.rootConversationId);
        return;
      }
      // Only untrusted reads are kept, so ordinary calls never grow the map
      // even when a framework does not end the turn.
      state.marks = state.marks.filter((mark) => mark !== settled);
      const key = turnKey(invocation);
      if (state.marks.length === 0 && this.turns.get(key) === state)
        this.turns.delete(key);
    });
  }

  async hasRead(invocation: InvocationContext): Promise<boolean> {
    this.latchInherited(invocation);
    const state = this.turns.get(turnKey(invocation));
    if (!state) return false;
    return (await Promise.all(state.marks)).some(Boolean);
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
  // Own properties only: a tool named `toString` or `constructor` must not
  // read an inherited member. A stored value that is not a permission asks.
  const tools = permissions?.tools;
  if (tools && Object.hasOwn(tools, toolName))
    return permissionOrAsk(tools[toolName]);
  if (permissions && Object.hasOwn(permissions, 'default'))
    return permissionOrAsk(permissions.default);
  // MCP annotations are the server's own claim; an untrusted server's claim
  // counts only when a catalog or the person said to trust it.
  const hintsTrusted =
    def !== undefined &&
    (def.contentTrust !== 'untrusted' || def.trustReadOnlyHints === true);
  const declared = def?.probe?.tools?.find((tool) => tool.name === toolName);
  if (hintsTrusted && declared?.readOnly === true) return undefined;
  return 'ask';
}

function permissionOrAsk(value: unknown): UntrustedContentPermission {
  return value === 'allow' || value === 'deny' ? value : 'ask';
}
