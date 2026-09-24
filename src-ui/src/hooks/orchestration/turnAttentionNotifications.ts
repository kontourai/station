import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { navigationStore } from '../../contexts/NavigationContext';
import { stripAnsi, toastStore } from '../../contexts/ToastContext';
import { isChatInForeground } from './chatForeground';
import { isReplayThread } from './replay/replay-registry';

/**
 * End-of-turn toasts for chats the user is not looking at.
 *
 * A turn ending is the moment a chat needs its user again, so a chat in the
 * background says so once per turn: it finished, it failed, it stopped for a
 * reason other than this user's Stop, or the engine replied on its own
 * (#2324). The foreground chat never toasts; the transcript already shows it.
 *
 * The server sends the same news as a push only when the user has NO live
 * event stream (`turn-completion-notifications.ts`), so a connected client
 * is the only place this is surfaced, and the two never meet.
 *
 * Needs-input is not handled here: `request.opened` already raises an
 * approval card for every request, foreground or not.
 */

/**
 * How long a stop-like terminal waits for the `session.stop-settled` fact
 * that says a user asked for it. An engine's cooperative cancel publishes its
 * own `turn.aborted` BEFORE Station publishes the settled stop, so a Stop
 * made on another device reaches this client abort-first.
 */
export const STOP_FACT_GRACE_MS = 1500;

const SNIPPET_MAX = 100;
const REASON_MAX = 80;
const HANDLED_LIMIT = 500;

type TerminalKind = 'completed' | 'aborted' | 'error';

export type TurnAttentionOutcome =
  | 'finished'
  | 'replied'
  | 'failed'
  | 'reply-failed'
  | 'stopped';

const handledTurns = new Set<string>();
const userStoppedTurns = new Set<string>();
const stallStoppedTurns = new Set<string>();
const pendingTurns = new Map<string, ReturnType<typeof setTimeout>>();

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function remember(set: Set<string>, key: string): void {
  set.add(key);
  if (set.size > HANDLED_LIMIT) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

function settle(key: string): void {
  remember(handledTurns, key);
  const pending = pendingTurns.get(key);
  if (pending) {
    clearTimeout(pending);
    pendingTurns.delete(key);
  }
}

/** Test seam: forget every turn this module has seen. */
export function resetTurnAttentionNotifications(): void {
  for (const timer of pendingTurns.values()) clearTimeout(timer);
  pendingTurns.clear();
  handledTurns.clear();
  userStoppedTurns.clear();
  stallStoppedTurns.clear();
}

/**
 * First ~100 characters of an answer as plain text: markdown syntax,
 * code fences and ANSI escapes removed, whitespace collapsed.
 */
function plainTextSnippet(
  text: string | undefined,
  max = SNIPPET_MAX,
): string | undefined {
  if (!text) return undefined;
  const plain = stripAnsi(text)
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return undefined;
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

function agentLabel(
  chat: { agentName?: string; agentSlug?: string } | undefined,
  provider: EngineId,
): string {
  const engine = engineDisplayLabel(provider) ?? provider;
  const agent = chat?.agentName || chat?.agentSlug;
  if (!agent || agent.toLowerCase() === engine.toLowerCase()) return engine;
  return `${agent} (${engine})`;
}

/** The toast's one-line outcome, in plain words. */
function describeTurnOutcome(
  who: string,
  outcome: TurnAttentionOutcome,
  reason?: string,
): string {
  const why = plainTextSnippet(reason, REASON_MAX);
  switch (outcome) {
    case 'finished':
      return `${who} finished`;
    case 'replied':
      return `${who} replied on its own`;
    case 'failed':
      return why ? `${who} failed: ${why}` : `${who} failed`;
    case 'reply-failed':
      return why ? `${who}'s reply failed: ${why}` : `${who}'s reply failed`;
    case 'stopped':
      return why ? `${who} stopped: ${why}` : `${who} stopped`;
  }
}

export type TurnTerminal = {
  threadId: string;
  turnId: string | undefined;
  provider: EngineId;
  kind: TerminalKind;
  /** `turn.completed` with `finishReason: 'cancelled'` — a stop, if one was asked for. */
  cancelled?: boolean;
  providerTurn: boolean;
  /** A provider turn the engine closed without a result of its own. */
  closedWithoutResult?: boolean;
  /** The answer text, for a completed turn. */
  text?: string;
  /** Why it failed or stopped. */
  reason?: string;
};

function outcomeFor(
  terminal: TurnTerminal,
  key: string,
): TurnAttentionOutcome | undefined {
  if (terminal.kind === 'completed') {
    if (terminal.providerTurn) {
      return terminal.closedWithoutResult ? undefined : 'replied';
    }
    return 'finished';
  }
  if (terminal.kind === 'aborted') {
    if (terminal.providerTurn) return 'reply-failed';
    // Only a settled stop says something stopped the turn. An abort nothing
    // asked for is the engine failing, as the server's push reads it.
    return stallStoppedTurns.has(key) ? 'stopped' : 'failed';
  }
  return terminal.providerTurn ? 'reply-failed' : 'failed';
}

function isOwnStop(key: string, turnId: string, chatKey?: string): boolean {
  if (userStoppedTurns.has(key)) return true;
  const chat = chatKey ? activeChatsStore.getSnapshot()[chatKey] : undefined;
  return chat?.stopPending === true || chat?.stopSettledTurnId === turnId;
}

function show(terminal: TurnTerminal & { turnId: string }): void {
  const key = turnKey(terminal.threadId, terminal.turnId);
  settle(key);
  const outcome = outcomeFor(terminal, key);
  if (!outcome) return;
  const chatKey =
    activeChatsStore.getChatKeyForExecutionSession(terminal.threadId) ??
    terminal.threadId;
  const chat = activeChatsStore.getSnapshot()[chatKey];
  if (
    isChatInForeground({
      chatKey,
      threadId: terminal.threadId,
      conversationId: chat?.conversationId,
    })
  ) {
    return;
  }
  const who = agentLabel(chat, terminal.provider);
  const answered = outcome === 'finished' || outcome === 'replied';
  const navigateTo = chat?.conversationId ?? chatKey;
  const open = () => {
    navigationStore.setDockState(true);
    navigationStore.setActiveChat(navigateTo);
  };
  toastStore.showTurnActivity({
    sessionId: terminal.threadId,
    message: describeTurnOutcome(who, outcome, terminal.reason),
    conversationTitle: chat?.title || 'New chat',
    detail: answered ? plainTextSnippet(terminal.text) : undefined,
    failed: !answered,
    onNavigate: open,
  });
}

/**
 * Called by each terminal handler (`turn.completed`, `turn.aborted`, a
 * turn-ending `runtime.error`) once the event has been applied to the chat.
 */
export function notifyTurnTerminal(terminal: TurnTerminal): void {
  const { threadId, turnId } = terminal;
  if (!turnId || isReplayThread(threadId)) return;
  const key = turnKey(threadId, turnId);
  if (handledTurns.has(key) || pendingTurns.has(key)) return;
  const chatKey = activeChatsStore.getChatKeyForExecutionSession(threadId);
  if (isOwnStop(key, turnId, chatKey)) {
    settle(key);
    return;
  }
  const stopLike = terminal.kind !== 'completed' || terminal.cancelled === true;
  if (!stopLike) {
    show({ ...terminal, turnId });
    return;
  }
  // Wait for the settled-stop fact; a user's Stop suppresses this in
  // `observeStopSettled`. An unaccompanied cancelled completion keeps its
  // ordinary finished/replied reading, as the server's push does.
  pendingTurns.set(
    key,
    setTimeout(() => {
      pendingTurns.delete(key);
      if (isOwnStop(key, turnId, chatKey)) {
        settle(key);
        return;
      }
      show({ ...terminal, turnId });
    }, STOP_FACT_GRACE_MS),
  );
}

/**
 * `session.stop-settled`: a user's Stop (`initiatedBy` absent on events that
 * predate the field, when only users could stop) is this user's own act, not
 * news. A stall-watchdog stop is not, and still toasts.
 */
export function observeStopSettled(event: {
  threadId: string;
  turnId?: string;
  initiatedBy?: 'user' | 'stall';
}): void {
  if (!event.turnId) return;
  const key = turnKey(event.threadId, event.turnId);
  if (event.initiatedBy === 'stall') {
    remember(stallStoppedTurns, key);
    return;
  }
  remember(userStoppedTurns, key);
  if (pendingTurns.has(key)) settle(key);
}
