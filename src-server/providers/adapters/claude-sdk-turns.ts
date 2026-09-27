import crypto from 'node:crypto';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { PROVIDER_TURN_TRIGGER } from '@kontourai/station-contracts/runtime-events';
import { providerOps } from '../../telemetry/metrics.js';
import type { ProviderSession } from '../adapter-shape.js';

/**
 * #2324: which turns the Claude SDK holds, and which one it is running.
 *
 * This is the ONE owner of Claude turn identity. It replaces a pair of
 * markers (`dispatchedTurnId`, `interruptingTurnId`) that could each name only
 * one turn, and so could not represent a stopped turn still owed its result
 * while a newer send was queued behind it. Two wedges came from that
 * (#2415 review, and its success-branch variant): a marker left on a turn that
 * would never report again, refusing every later send.
 *
 * Here every turn Station put into the SDK has its own entry, carrying its own
 * Stop mark, and a result closes the entry it names. A send is refused while
 * any entry is still owed a result and was not stopped, so a Stop exemption is
 * pinned to the stopped turn by construction.
 *
 * Attribution follows the engine's own evidence, strongest first:
 * - `command_lifecycle` messages (capability `msg_lifecycle_v1`): the CLI
 *   reports `queued` / `started` / `completed` for every user message by the
 *   uuid Station gave it (the turn id). A dispatched turn is running only once
 *   it has `started`; an `init` with no `started` before it is a turn the
 *   engine opened itself.
 * - `user_message_uuid(s)` on the first reply frame and on the `result`.
 * - Order, for engines that report neither: the SDK runs queued prompts in
 *   the order they were pushed.
 *
 * Live probe (claude 2.1.281): an unprompted reply after background work is a
 * separate SDK turn with its own `init`, frames carrying no user uuid, no
 * `command_lifecycle`, and a `result` with `origin.kind: 'task-notification'`.
 * A send pushed while it runs is folded into it at its next tool-round
 * boundary at the default priority: `started` for the send arrives mid-reply
 * and ONE result carries both the send's uuid and that origin.
 *
 * Published order follows the engine, not the push (#2324 review H1): a
 * dispatched send's `turn.started` is published when the SDK starts running
 * it, not when Station queued it. With lifecycle messages that is its
 * `started`; so a send queued behind a turn the engine opened itself reads
 * `P started → P ended → U started → U's reply → U ended`, which every
 * single-slot turn fold on the server can follow. Without lifecycle messages
 * (an older CLI) a send runs as soon as nothing else is running, and a reply
 * the engine began before that send reached it can still be attributed to
 * the send: that residual is documented, not closed.
 */
export interface ClaudeSdkTurn {
  turnId: string;
  /**
   * `dispatched`: Station sent the prompt. `provider`: the engine opened the
   * turn itself. `untracked`: the engine is answering a user message
   * Station has no turn for — a steer whose target turn already ended (the
   * SDK runs it as its own turn), or a message Station never sent. Its
   * frames stay turn-less and its result closes nothing, as before this
   * ledger existed; it is never mistaken for a turn the engine opened.
   */
  kind: 'dispatched' | 'provider' | 'untracked';
  /** A Stop was requested for exactly this turn; its result is a receipt. */
  stopRequested: boolean;
  /**
   * `dispatched` only: the turn's `turn.started`, held until the SDK starts
   * running it, then published once (with the time it actually started).
   */
  startEvent?: CanonicalRuntimeEvent;
  /** Its `turn.started` is published (a queued send's is not, yet). */
  startPublished?: boolean;
}

export interface ClaudeSdkTurnLedger {
  /** The turn the SDK is running now. Frames and results attribute to it. */
  running?: ClaudeSdkTurn;
  /** Dispatched turns whose prompt is queued in the SDK, not yet started. */
  queued: ClaudeSdkTurn[];
  /**
   * The CLI declared `msg_lifecycle_v1` on its `init`. `undefined` until the
   * first `init`; the first turn of a session is dispatched before it.
   */
  lifecycleMessages?: boolean;
  /**
   * A `command_lifecycle` `started` began a new SDK turn and no `init`
   * consumed it yet. Not set by a `started` that folds into the running turn
   * (a steer, a send merged into a reply): no `init` follows those.
   */
  startedAwaitingInit: boolean;
  /**
   * An `init` no `started` preceded: the engine began a turn of its own that
   * has not produced a frame yet. Sends are refused as they are for an open
   * provider turn, but nothing is published until its first frame — so a
   * turn that never replies (a handshake) leaves no phantom turn behind.
   */
  providerTurnPending: boolean;
  /** The bounded display fact published for a provider follow-up. */
  followUpFactPending?: boolean;
  /** Steer uuid → the turn it was steered into. */
  steers: Map<string, string>;
}

export interface ClaudeSdkTurnState {
  session: ProviderSession;
  sdkTurns?: ClaudeSdkTurnLedger;
  activeTurnId?: string;
  lastReportedModel?: string;
}

export interface ClaudeSdkTurnContext {
  provider: ProviderSession['provider'];
  record: ClaudeSdkTurnState;
  publish: (event: CanonicalRuntimeEvent) => void;
  createdAt: string;
  logInfo?: (message: string, details: Record<string, unknown>) => void;
  /**
   * Interrupts whatever the SDK is running. Called when a send Stop was
   * requested for while it was still queued (and could not be withdrawn)
   * starts running.
   */
  interruptEngine?: () => void;
}

export type ProviderTurnCloseReason =
  | 'folded-send'
  | 'next-turn-started'
  | 'session-ended';

/** The CLI capability that makes `command_lifecycle` messages available. */
const CLAUDE_MSG_LIFECYCLE_CAPABILITY = 'msg_lifecycle_v1';

/**
 * The CLI's per-message lifecycle frame. Not in the SDK's typings (0.3.261)
 * though the CLI advertises it as `msg_lifecycle_v1`, so it is typed here,
 * narrowly, and read only through {@link readClaudeCommandLifecycle}.
 */
export interface ClaudeCommandLifecycleMessage {
  type: 'command_lifecycle';
  command_uuid: string;
  state: 'queued' | 'started' | 'completed' | 'cancelled';
}

export function readClaudeCommandLifecycle(
  message: unknown,
): ClaudeCommandLifecycleMessage | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const candidate = message as Record<string, unknown>;
  if (candidate.type !== 'command_lifecycle') return undefined;
  if (typeof candidate.command_uuid !== 'string' || !candidate.command_uuid)
    return undefined;
  const state = candidate.state;
  if (
    state !== 'queued' &&
    state !== 'started' &&
    state !== 'completed' &&
    state !== 'cancelled'
  )
    return undefined;
  return {
    type: 'command_lifecycle',
    command_uuid: candidate.command_uuid,
    state,
  };
}

/** The user-message uuids a reply frame or result names, in order. */
function claudeMessageUserUuids(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const candidate = message as {
    user_message_uuid?: unknown;
    user_message_uuids?: unknown;
  };
  const uuids = Array.isArray(candidate.user_message_uuids)
    ? candidate.user_message_uuids.filter(
        (uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0,
      )
    : [];
  if (
    typeof candidate.user_message_uuid === 'string' &&
    candidate.user_message_uuid &&
    !uuids.includes(candidate.user_message_uuid)
  ) {
    uuids.push(candidate.user_message_uuid);
  }
  return uuids;
}

function claudeSdkTurns(record: ClaudeSdkTurnState): ClaudeSdkTurnLedger {
  record.sdkTurns ??= {
    queued: [],
    startedAwaitingInit: false,
    providerTurnPending: false,
    steers: new Map(),
  };
  return record.sdkTurns;
}

function publishFollowUpFact(
  context: ClaudeSdkTurnContext,
  pending: boolean,
): void {
  const ledger = claudeSdkTurns(context.record);
  if (!pending && ledger.followUpFactPending !== true) return;
  if (ledger.followUpFactPending === pending) return;
  ledger.followUpFactPending = pending;
  context.publish({
    eventId: crypto.randomUUID(),
    provider: context.provider,
    threadId: context.record.session.threadId,
    createdAt: context.createdAt,
    method: 'extension.notification',
    namespace: 'claude-code',
    type: 'provider/follow-up-pending',
    payload: { pending },
  });
}

/** Mark the handoff before a background child's settle is published, so the
 * settle frame itself never briefly advertises an idle conversation. */
export function observeClaudeBackgroundChildSettling(
  context: ClaudeSdkTurnContext,
): void {
  const ledger = claudeSdkTurns(context.record);
  if (ledger.lifecycleMessages === true && !ledger.running)
    publishFollowUpFact(context, true);
}

/**
 * Why a new send must be refused now, if it must.
 *
 * `dispatched`: a turn Station sent is still owed its result and was not
 * stopped. A stopped turn does not block — its result is only a receipt —
 * but the exemption is that turn's own mark, so a send queued behind a Stop
 * still blocks the next one. `provider`: the engine is running a turn it
 * opened itself and nobody stopped.
 */
export function claudeSendBlockedBy(
  record: ClaudeSdkTurnState,
): 'dispatched' | 'provider' | undefined {
  const ledger = claudeSdkTurns(record);
  const owed = [...(ledger.running ? [ledger.running] : []), ...ledger.queued];
  if (owed.some((turn) => turn.kind === 'dispatched' && !turn.stopRequested))
    return 'dispatched';
  if (ledger.running?.kind === 'provider' && !ledger.running.stopRequested)
    return 'provider';
  if (!ledger.running && ledger.providerTurnPending) return 'provider';
  return undefined;
}

function setRunning(
  record: ClaudeSdkTurnState,
  turn: ClaudeSdkTurn | undefined,
  context?: ClaudeSdkTurnContext,
): void {
  const ledger = claudeSdkTurns(record);
  if (ledger.running !== turn) {
    // A new turn has not reported a model yet; a turn that ends before any
    // assistant message must not inherit the previous turn's.
    record.lastReportedModel = undefined;
  }
  ledger.running = turn;
  if (turn) ledger.providerTurnPending = false;
  record.activeTurnId =
    turn && turn.kind !== 'untracked' ? turn.turnId : undefined;
  if (turn && context) publishClaudeTurnStart(context, turn);
  if (turn && context) publishFollowUpFact(context, false);
}

/**
 * Publishes a dispatched turn's held `turn.started`, once. A turn Stop was
 * requested for while it was queued is then stopped at once: its
 * `turn.aborted` follows its start and the engine is interrupted, so its
 * result arrives as the Stop's receipt.
 */
function publishClaudeTurnStart(
  context: ClaudeSdkTurnContext,
  turn: ClaudeSdkTurn,
): void {
  if (turn.kind !== 'dispatched' || turn.startPublished || !turn.startEvent)
    return;
  turn.startPublished = true;
  context.publish({ ...turn.startEvent, createdAt: context.createdAt });
  if (!turn.stopRequested) return;
  context.publish({
    eventId: crypto.randomUUID(),
    provider: context.provider,
    threadId: context.record.session.threadId,
    createdAt: context.createdAt,
    turnId: turn.turnId,
    method: 'turn.aborted',
    reason: 'interrupted',
  });
  context.interruptEngine?.();
}

/**
 * A dispatched turn is about to report a terminal: its start must precede
 * it. Reached only without lifecycle messages, when a result names a send
 * the ledger still holds as queued.
 */
export function ensureClaudeTurnStartPublished(
  context: ClaudeSdkTurnContext,
  turn: ClaudeSdkTurn,
): void {
  publishClaudeTurnStart({ ...context, interruptEngine: undefined }, turn);
}

/**
 * A dispatched prompt entered the SDK queue. Until the engine reports it
 * started it is queued, and its `turn.started` is held; when this CLI cannot
 * report that (no lifecycle messages, or none seen yet) and nothing is
 * running, the SDK runs it next, so it is running now and its start is
 * published now — exactly the attribution Station always used.
 */
export function recordClaudeTurnDispatched(
  record: ClaudeSdkTurnState,
  turnId: string,
  start?: { event: CanonicalRuntimeEvent; context: ClaudeSdkTurnContext },
): void {
  const ledger = claudeSdkTurns(record);
  if (start) publishFollowUpFact(start.context, false);
  const turn: ClaudeSdkTurn = {
    turnId,
    kind: 'dispatched',
    stopRequested: false,
    ...(start ? { startEvent: start.event } : { startPublished: true }),
  };
  if (ledger.lifecycleMessages !== true && !ledger.running) {
    setRunning(record, turn, start?.context);
  } else {
    ledger.queued.push(turn);
  }
}

/** A dispatched send the SDK holds but has not started. */
export function queuedClaudeTurn(
  record: ClaudeSdkTurnState,
  turnId: string,
): ClaudeSdkTurn | undefined {
  return claudeSdkTurns(record).queued.find((turn) => turn.turnId === turnId);
}

/**
 * A queued send was withdrawn before it ran (the engine cancelled it, or a
 * Stop withdrew it). Its boundary needs a terminal, so `turn.aborted` is
 * published — never a `turn.started` first: nothing ran.
 */
export function withdrawQueuedClaudeTurn(
  context: ClaudeSdkTurnContext,
  turnId: string,
  reason: string,
): boolean {
  const ledger = claudeSdkTurns(context.record);
  const index = ledger.queued.findIndex((turn) => turn.turnId === turnId);
  if (index === -1) return false;
  ledger.queued.splice(index, 1);
  context.publish({
    eventId: crypto.randomUUID(),
    provider: context.provider,
    threadId: context.record.session.threadId,
    createdAt: context.createdAt,
    turnId,
    method: 'turn.aborted',
    reason,
  });
  return true;
}

export function recordClaudeSteer(
  record: ClaudeSdkTurnState,
  steerUuid: string,
  turnId: string,
): void {
  claudeSdkTurns(record).steers.set(steerUuid, turnId);
}

/**
 * Marks a Stop for `turnId`: the running turn, or a queued send (which is
 * then stopped the moment it starts, see {@link publishClaudeTurnStart}).
 * Returns whether it named either.
 */
export function recordClaudeTurnStopRequested(
  record: ClaudeSdkTurnState,
  turnId: string,
): boolean {
  const ledger = claudeSdkTurns(record);
  const running = ledger.running;
  if (running?.turnId === turnId && running.kind !== 'untracked') {
    running.stopRequested = true;
    return true;
  }
  const queued = ledger.queued.find((turn) => turn.turnId === turnId);
  if (!queued) return false;
  queued.stopRequested = true;
  return true;
}

function turnMetadata(turn: ClaudeSdkTurn): Record<string, unknown> {
  return turn.kind === 'provider' ? { trigger: PROVIDER_TURN_TRIGGER } : {};
}

/** The running turn's terminal metadata, when it has any (a provider turn). */
export function claudeRunningTurnTerminalMetadata(
  record: ClaudeSdkTurnState,
): Record<string, unknown> | undefined {
  const running = claudeSdkTurns(record).running;
  return running?.kind === 'provider' ? turnMetadata(running) : undefined;
}

/** Whether a turn's terminal carries `trigger`, for callers that publish one. */
export function claudeTurnTerminalMetadata(
  turn: ClaudeSdkTurn,
): Record<string, unknown> {
  return turnMetadata(turn);
}

function openProviderTurn(context: ClaudeSdkTurnContext): void {
  const { record } = context;
  const turn: ClaudeSdkTurn = {
    turnId: `provider:${crypto.randomUUID()}`,
    kind: 'provider',
    stopRequested: false,
  };
  setRunning(record, turn);
  context.publish({
    eventId: crypto.randomUUID(),
    provider: context.provider,
    threadId: record.session.threadId,
    createdAt: context.createdAt,
    turnId: turn.turnId,
    method: 'turn.started',
    metadata: turnMetadata(turn),
  });
  publishFollowUpFact(context, false);
}

/**
 * Closes a still-running provider turn whose own result never arrived, with
 * the no-authority `'other'` finish. Reached when the engine starts something
 * else first: a send folded into it, a new turn's `init`, or the session
 * ending. A stopped provider turn already has its `turn.aborted`.
 */
function closeProviderTurnWithoutResult(
  context: ClaudeSdkTurnContext,
  reason: ProviderTurnCloseReason,
): void {
  const running = claudeSdkTurns(context.record).running;
  if (running?.kind !== 'provider') return;
  setRunning(context.record, undefined);
  if (running.stopRequested) return;
  providerOps.add(1, {
    operation: 'claude-provider-turn-closed-without-result',
    provider: context.provider,
    reason,
  });
  context.logInfo?.('Closed a Claude provider turn without its result', {
    threadId: context.record.session.threadId,
    turnId: running.turnId,
    reason,
  });
  context.publish({
    eventId: crypto.randomUUID(),
    provider: context.provider,
    threadId: context.record.session.threadId,
    createdAt: context.createdAt,
    turnId: running.turnId,
    method: 'turn.completed',
    finishReason: 'other',
    // Why it closed without its result: consumers that act on a reply
    // (the "replied" push) skip a turn whose end is really something else's
    // start — derived from what the engine did, not from `finishReason`.
    metadata: { ...turnMetadata(running), closedWithoutResult: reason },
  });
}

/**
 * The engine started running `uuid`. A queued send becomes the running turn;
 * a provider turn it was folded into ends here, because everything after this
 * point is the reply to the send. A steer continues its turn, or — when its
 * turn already ended — runs as an untracked SDK turn.
 */
function startCommand(context: ClaudeSdkTurnContext, uuid: string): true {
  const { record } = context;
  const ledger = claudeSdkTurns(record);
  ledger.providerTurnPending = false;
  const steeredInto = ledger.steers.get(uuid);
  if (steeredInto !== undefined) {
    // Kept until its turn settles: the steer's uuid also names the frames
    // and the result of the turn it continues.
    if (ledger.running?.turnId === steeredInto) return true;
    if (ledger.running?.kind === 'provider') {
      closeProviderTurnWithoutResult(context, 'next-turn-started');
    }
    setRunning(record, {
      turnId: steeredInto,
      kind: 'untracked',
      stopRequested: false,
    });
    return true;
  }
  const index = ledger.queued.findIndex((turn) => turn.turnId === uuid);
  if (index === -1) {
    if (ledger.running?.turnId === uuid) return true;
    // A user message Station did not send (or no longer tracks): the engine
    // is answering someone, so this is not a turn it opened on its own.
    if (ledger.running?.kind === 'provider') {
      closeProviderTurnWithoutResult(context, 'next-turn-started');
    }
    setRunning(record, {
      turnId: uuid,
      kind: 'untracked',
      stopRequested: false,
    });
    return true;
  }
  const [turn] = ledger.queued.splice(index, 1);
  if (ledger.running?.kind === 'provider') {
    closeProviderTurnWithoutResult(context, 'folded-send');
  } else if (ledger.running?.kind === 'dispatched') {
    // Only a stopped turn can still be running when the next send starts
    // (the send guard refuses otherwise): the engine moved on from it, and
    // its `turn.aborted` is already published.
    context.logInfo?.('Claude moved to a queued send before a turn result', {
      threadId: record.session.threadId,
      turnId: ledger.running.turnId,
      stopRequested: ledger.running.stopRequested,
    });
  }
  setRunning(record, turn, context);
  return true;
}

/** `command_lifecycle` for a user message Station pushed. */
export function observeClaudeCommandLifecycle(
  context: ClaudeSdkTurnContext,
  lifecycle: ClaudeCommandLifecycleMessage,
): void {
  const ledger = claudeSdkTurns(context.record);
  if (lifecycle.state === 'started') {
    // Only this CLI reports lifecycle. A `started` with nothing running
    // begins a new SDK turn, whose `init` follows; one that folds into the
    // running turn (a steer, a send merged into a reply) has no `init`.
    ledger.lifecycleMessages = true;
    ledger.startedAwaitingInit = ledger.running === undefined;
    startCommand(context, lifecycle.command_uuid);
    return;
  }
  if (lifecycle.state === 'cancelled') {
    withdrawQueuedClaudeTurn(context, lifecycle.command_uuid, 'cancelled');
    ledger.steers.delete(lifecycle.command_uuid);
  }
}

/**
 * Every SDK turn begins with `init`. With lifecycle messages, an `init` that
 * no `started` preceded is a turn the engine opened itself — known before its
 * first frame, which is what lets a send racing it be refused instead of
 * folded. Any turn still running at a new `init` did not deliver its result.
 */
export function observeClaudeInit(
  context: ClaudeSdkTurnContext,
  capabilities: unknown,
): void {
  const ledger = claudeSdkTurns(context.record);
  const declared =
    Array.isArray(capabilities) &&
    capabilities.includes(CLAUDE_MSG_LIFECYCLE_CAPABILITY);
  if (ledger.lifecycleMessages === undefined || declared) {
    ledger.lifecycleMessages = declared || ledger.startedAwaitingInit;
  }
  const startedBefore = ledger.startedAwaitingInit;
  ledger.startedAwaitingInit = false;
  if (!ledger.lifecycleMessages || startedBefore) return;
  if (ledger.running?.kind === 'provider') {
    closeProviderTurnWithoutResult(context, 'next-turn-started');
  }
  if (ledger.running) return;
  // Opened on its first frame (`observeClaudeReplyFrame`); until then sends
  // are refused, and a turn that never replies publishes nothing.
  ledger.providerTurnPending = true;
  publishFollowUpFact(context, true);
}

/**
 * A top-level reply frame (`message_start`, a content block, a top-level
 * `assistant`). Its user uuids start a queued send the engine folded in or
 * started without a lifecycle message. A frame naming no user message, with
 * nothing running, starts the next queued send when this CLI cannot say
 * otherwise, and otherwise is a reply the engine began on its own.
 */
export function observeClaudeReplyFrame(
  context: ClaudeSdkTurnContext,
  message: unknown,
): void {
  const ledger = claudeSdkTurns(context.record);
  const uuids = claudeMessageUserUuids(message);
  if (uuids.length > 0) {
    // The LAST uuid is the send the reply answers (earlier ones were merged
    // into it); a frame of the running turn changes nothing.
    const uuid = uuids[uuids.length - 1];
    if (ledger.running?.turnId !== uuid) startCommand(context, uuid);
    return;
  }
  if (ledger.running) return;
  if (ledger.lifecycleMessages !== true && ledger.queued.length > 0) {
    setRunning(context.record, ledger.queued.shift(), context);
    return;
  }
  openProviderTurn(context);
}

export type ClaudeResultTarget =
  | { kind: 'turn'; turn: ClaudeSdkTurn; folded: ClaudeSdkTurn[] }
  | { kind: 'none' };

/**
 * Which turn a `result` closes. Its user uuids name the turn(s) it answers;
 * a result naming none is the running turn's (a provider turn's carries
 * `origin: task-notification`), and with nothing running, the oldest queued
 * send's — the SDK runs prompts in the order they were pushed — unless the
 * CLI reports command lifecycle, in which case a queued send has not started
 * and the result closes nothing. Resolved
 * WITHOUT changing the ledger; {@link settleClaudeResultTarget} removes it.
 */
export function resolveClaudeResultTarget(
  record: ClaudeSdkTurnState,
  message: unknown,
): ClaudeResultTarget {
  const ledger = claudeSdkTurns(record);
  const uuids = claudeMessageUserUuids(message);
  const all = [...(ledger.running ? [ledger.running] : []), ...ledger.queued];
  const named = all.filter(
    (turn) => turn.kind === 'dispatched' && uuids.includes(turn.turnId),
  );
  if (named.length > 0) {
    // The LAST named send is the turn the reply answered; earlier ones were
    // merged into it by the engine.
    const turn = named[named.length - 1];
    return { kind: 'turn', turn, folded: named.slice(0, -1) };
  }
  if (ledger.running) return { kind: 'turn', turn: ledger.running, folded: [] };
  // With lifecycle messages a queued send has provably not started, so a
  // result naming nobody is not its result (#2324 delta review).
  if (ledger.lifecycleMessages === true) return { kind: 'none' };
  const head = ledger.queued[0];
  return head ? { kind: 'turn', turn: head, folded: [] } : { kind: 'none' };
}

/**
 * Removes a result's turn(s) from the ledger. A provider turn still running
 * when a result names a send ends with it: the engine folded the send into it
 * (without lifecycle messages that fold is only visible here).
 */
export function settleClaudeResultTarget(
  context: ClaudeSdkTurnContext,
  target: Extract<ClaudeResultTarget, { kind: 'turn' }>,
): void {
  const { record } = context;
  const ledger = claudeSdkTurns(record);
  const ended = new Set([target.turn, ...target.folded]);
  if (
    ledger.running &&
    ledger.running.kind === 'provider' &&
    !ended.has(ledger.running)
  ) {
    closeProviderTurnWithoutResult(context, 'folded-send');
  }
  ledger.queued = ledger.queued.filter((turn) => !ended.has(turn));
  for (const [steerUuid, turnId] of ledger.steers) {
    if ([...ended].some((turn) => turn.turnId === turnId)) {
      ledger.steers.delete(steerUuid);
    }
  }
  if (ledger.running && ended.has(ledger.running)) {
    setRunning(record, undefined);
  }
  // A result ends whatever turn the engine was beginning, too.
  ledger.providerTurnPending = false;
  if (!ledger.running && ledger.lifecycleMessages !== true) {
    // Without lifecycle messages the next queued send runs next.
    const next = ledger.queued.shift();
    if (next) setRunning(record, next, context);
  }
}

/**
 * A result that closes nothing (`num_turns: 0`, a handshake): the turn the
 * engine was beginning did not happen.
 */
export function observeClaudeEmptyResult(context: ClaudeSdkTurnContext): void {
  claudeSdkTurns(context.record).providerTurnPending = false;
  publishFollowUpFact(context, false);
}

/**
 * #2324 delta review M-1: sends the engine never started when it stopped
 * running anything. Each held start is published — it carries the user's
 * message, which must reach the durable transcript — and then its
 * `turn.aborted`, so the send has a terminal and its boundary row retires. A
 * send whose start was already published (or never held) gets the abort
 * alone.
 */
const ENGINE_ENDED_BEFORE_START = 'engine-ended-before-start';

function endQueuedClaudeTurns(context: ClaudeSdkTurnContext): void {
  const ledger = claudeSdkTurns(context.record);
  const queued = ledger.queued;
  ledger.queued = [];
  for (const turn of queued) {
    if (turn.startEvent && !turn.startPublished) {
      turn.startPublished = true;
      context.publish({ ...turn.startEvent, createdAt: context.createdAt });
    }
    context.publish({
      eventId: crypto.randomUUID(),
      provider: context.provider,
      threadId: context.record.session.threadId,
      createdAt: context.createdAt,
      turnId: turn.turnId,
      method: 'turn.aborted',
      reason: ENGINE_ENDED_BEFORE_START,
    });
  }
}

/**
 * The SDK iterator ended: a turn the engine opened on its own will never
 * report its end, so it is closed here, and a send still queued is ended
 * (see {@link endQueuedClaudeTurns}). The running dispatched turn is left as
 * it is — its terminal comes from the failure that ended the iterator or
 * from `session.exited`, as before this ledger existed.
 */
export function endClaudeProviderTurn(context: ClaudeSdkTurnContext): void {
  closeProviderTurnWithoutResult(context, 'session-ended');
  endQueuedClaudeTurns(context);
  claudeSdkTurns(context.record).providerTurnPending = false;
  publishFollowUpFact(context, false);
}

/** A terminal failure: nothing is running any more. */
export function clearClaudeSdkTurns(
  context: ClaudeSdkTurnContext,
  reason: ProviderTurnCloseReason = 'session-ended',
): void {
  closeProviderTurnWithoutResult(context, reason);
  endQueuedClaudeTurns(context);
  const ledger = claudeSdkTurns(context.record);
  ledger.steers.clear();
  ledger.startedAwaitingInit = false;
  ledger.providerTurnPending = false;
  setRunning(context.record, undefined);
  publishFollowUpFact(context, false);
}
