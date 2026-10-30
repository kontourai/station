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
 * Station engine's hooks) and at the seams that carry external engines'
 * MCP calls (mediated-untrusted-content-gate.ts). Servers an engine
 * connects to itself are not covered; see
 * docs/design/mcp-subregistry-curation.md#coverage-and-gaps.
 */

import type {
  ToolDef,
  UntrustedContentPermission,
} from '@kontourai/station-contracts/tool';
import type { InvocationContext } from '../../runtime/types.js';
import type { UntrustedConversationMarks } from './untrusted-conversation-marks.js';

/** Conversations remembered per lineage set; the oldest is forgotten first. */
const CONVERSATION_MEMORY_LIMIT = 10_000;

/** Maximum tracked turns; saturation fails toward treating all turns as marked. */
const TURN_LIMIT = 10_000;

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

  /** `*` forgets every member. */
  delete(value: string): void {
    if (value === '*') this.members.clear();
    else this.members.delete(value);
  }
}

interface TurnState {
  agentSlug: string;
  conversationId?: string;
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
 * clear the question mid-turn.
 *
 * With durable marks (`attachDurableMarks`, wired at runtime start) a
 * conversation that read untrusted content stays marked for every later
 * turn and across restarts until a person clears it, and delegation reads
 * the durable record too. Without them both records are memory only and a
 * mark ends with its turn.
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

  private saturated = false;
  private durable: UntrustedConversationMarks | undefined;
  private warn:
    | ((message: string, meta?: Record<string, unknown>) => void)
    | undefined;

  /** The durable marks in use, if any. */
  get durableMarks(): UntrustedConversationMarks | undefined {
    return this.durable;
  }

  /** Conversation-level marks that outlive the turn and the process. */
  attachDurableMarks(
    marks: UntrustedConversationMarks | undefined,
    warn?: (message: string, meta?: Record<string, unknown>) => void,
  ): void {
    this.durable = marks;
    this.warn = warn;
  }

  /** Whether a conversation, or the one that delegated to it, is marked beyond the turn. */
  private async conversationMarked(
    invocation: InvocationContext,
  ): Promise<boolean> {
    if (!this.durable) return false;
    const ids = [
      invocation.conversationId,
      invocation.delegation?.parentConversationId,
      invocation.delegation?.rootConversationId,
    ];
    await Promise.all(
      ids.flatMap((id) => [
        ...((id && this.pendingConversationMarks.get(id)) || []),
      ]),
    );
    // The in-memory record also answers until restart, so a failed durable
    // write never clears a mark this process recorded.
    return (
      ids.some((id) => this.conversationsRead.has(id)) ||
      this.durable.isMarked(...ids)
    );
  }

  /** Number of turns held; for bounds checks. */
  get turnCount(): number {
    return this.turns.size;
  }

  private turn(invocation: InvocationContext): TurnState | undefined {
    const key = turnKey(invocation);
    let state = this.turns.get(key);
    if (state) {
      return state;
    }
    if (this.turns.size >= TURN_LIMIT) {
      // Unknown overflow turns cannot be tracked individually. Keep the
      // conservative state until restart, including after tracked turns end.
      this.saturated = true;
      return undefined;
    }
    state = {
      agentSlug: invocation.agentSlug,
      ...(invocation.conversationId
        ? { conversationId: invocation.conversationId }
        : {}),
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
    if (!state) return;
    if (state.latched) return;
    state.latched = true;
    state.marks.push(Promise.resolve(true));
  }

  /** Records an untrusted read beyond its turn: in memory and, when wired, durably. */
  private recordConversationRead(invocation: InvocationContext): void {
    this.conversationsRead.add(invocation.conversationId);
    this.descendantsRead.add(invocation.delegation?.parentConversationId);
    this.descendantsRead.add(invocation.delegation?.rootConversationId);
    if (!this.durable || !invocation.conversationId) return;
    try {
      this.durable.mark(invocation.conversationId);
    } catch (error) {
      this.warn?.('Untrusted-content mark was not saved', {
        conversationId: invocation.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Conversation marks whose classification read has not settled. A later
   * turn waits for them, so a turn that ends first cannot let the next one
   * start unmarked.
   */
  private readonly pendingConversationMarks = new Map<
    string,
    Set<Promise<unknown>>
  >();

  private trackPending(
    conversationId: string | undefined,
    mark: Promise<unknown>,
  ) {
    if (!conversationId) return;
    const pending =
      this.pendingConversationMarks.get(conversationId) ??
      new Set<Promise<unknown>>();
    this.pendingConversationMarks.set(conversationId, pending);
    pending.add(mark);
    void mark.finally(() => {
      pending.delete(mark);
      if (
        pending.size === 0 &&
        this.pendingConversationMarks.get(conversationId) === pending
      )
        this.pendingConversationMarks.delete(conversationId);
    });
  }

  mark(invocation: InvocationContext, untrusted: Promise<boolean>): void {
    this.latchInherited(invocation);
    // A failed classification read counts as untrusted: fail toward asking.
    const settled = untrusted.catch(() => true);
    const state = this.turn(invocation);
    if (!state) {
      this.trackPending(
        invocation.conversationId,
        settled.then((read) => {
          if (read) this.recordConversationRead(invocation);
        }),
      );
      return;
    }
    state.marks.push(settled);
    const recorded = settled.then((read) => {
      if (read) {
        this.recordConversationRead(invocation);
        return;
      }
      // Only untrusted reads are kept, so ordinary calls never grow the map
      // even when a framework does not end the turn.
      state.marks = state.marks.filter((mark) => mark !== settled);
      const key = turnKey(invocation);
      if (state.marks.length === 0 && this.turns.get(key) === state)
        this.turns.delete(key);
    });
    this.trackPending(invocation.conversationId, recorded);
  }

  async hasRead(invocation: InvocationContext): Promise<boolean> {
    if (this.saturated) return true;
    this.latchInherited(invocation);
    if (this.saturated) return true;
    if (await this.conversationMarked(invocation)) return true;
    const state = this.turns.get(turnKey(invocation));
    if (!state) return false;
    return (await Promise.all(state.marks)).some(Boolean);
  }

  /** Whether a child this conversation delegated to has read it. */
  hasDescendantRead(conversationId: string | undefined): boolean {
    return this.saturated || this.descendantsRead.has(conversationId);
  }

  /**
   * #3483: a Station seam saw an untrusted read for an external engine's
   * conversation (no Station turn is involved).
   */
  markConversation(conversationId: string, untrusted: Promise<boolean>): void {
    const recorded = untrusted
      .catch(() => true)
      .then((read) => {
        if (read)
          this.recordConversationRead({
            agentSlug: '',
            conversationId,
          } as InvocationContext);
      });
    this.trackPending(conversationId, recorded);
  }

  /**
   * Whether any of these conversations has read untrusted content beyond a
   * turn: this process's record, or the durable mark when wired.
   */
  async conversationHasRead(
    ...conversationIds: (string | undefined)[]
  ): Promise<boolean> {
    const ids = conversationIds.filter((id): id is string => !!id);
    if (ids.length === 0) return false;
    if (this.saturated) return true;
    await Promise.all(
      ids.flatMap((id) => [...(this.pendingConversationMarks.get(id) ?? [])]),
    );
    if (ids.some((id) => this.conversationsRead.has(id))) return true;
    return this.durable?.isMarked(...ids) ?? false;
  }

  /**
   * A person cleared a conversation's durable mark; this process forgets
   * it too. Turns in progress keep their own marks.
   */
  forgetConversation(conversationId: string): void {
    this.conversationsRead.delete(conversationId);
    this.descendantsRead.delete(conversationId);
  }

  /**
   * The turn ended; its content no longer counts for the next one. An end
   * reported without a turn id (a framework's end callback can run outside
   * the request that knew it) ends every turn of that Agent's conversation.
   */
  clear(invocation: InvocationContext): void {
    this.turns.delete(turnKey(invocation));
    if (invocation.turnId) return;
    for (const [key, state] of this.turns)
      if (
        state.agentSlug === invocation.agentSlug &&
        state.conversationId === invocation.conversationId
      )
        this.turns.delete(key);
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
