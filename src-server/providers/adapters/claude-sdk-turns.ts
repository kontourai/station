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
  /** A `command_lifecycle` `started` arrived and no `init` consumed it yet. */
  startedAwaitingInit: boolean;
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
    steers: new Map(),
  };
  return record.sdkTurns;
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
  return undefined;
}

function setRunning(
  record: ClaudeSdkTurnState,
  turn: ClaudeSdkTurn | undefined,
): void {
  const ledger = claudeSdkTurns(record);
  if (ledger.running !== turn) {
    // A new turn has not reported a model yet; a turn that ends before any
    // assistant message must not inherit the previous turn's.
    record.lastReportedModel = undefined;
  }
  ledger.running = turn;
  record.activeTurnId =
    turn && turn.kind !== 'untracked' ? turn.turnId : undefined;
}

/**
 * A dispatched prompt entered the SDK queue. Until the engine reports it
 * started it is queued; when this CLI cannot report that (no lifecycle
 * messages, or none seen yet) and nothing is running, the SDK runs it next,
 * so it is running now — exactly the attribution Station always used.
 */
export function recordClaudeTurnDispatched(
  record: ClaudeSdkTurnState,
  turnId: string,
): void {
  const ledger = claudeSdkTurns(record);
  const turn: ClaudeSdkTurn = {
    turnId,
    kind: 'dispatched',
    stopRequested: false,
  };
  if (ledger.lifecycleMessages !== true && !ledger.running) {
    setRunning(record, turn);
  } else {
    ledger.queued.push(turn);
  }
}

export function recordClaudeSteer(
  record: ClaudeSdkTurnState,
  steerUuid: string,
  turnId: string,
): void {
  claudeSdkTurns(record).steers.set(steerUuid, turnId);
}

/** Marks a Stop for the running turn; returns whether it was that turn. */
export function recordClaudeTurnStopRequested(
  record: ClaudeSdkTurnState,
  turnId: string,
): boolean {
  const running = claudeSdkTurns(record).running;
  if (running?.turnId !== turnId || running.kind === 'untracked') return false;
  running.stopRequested = true;
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
    metadata: turnMetadata(running),
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
  setRunning(record, turn);
  return true;
}

/** `command_lifecycle` for a user message Station pushed. */
export function observeClaudeCommandLifecycle(
  context: ClaudeSdkTurnContext,
  lifecycle: ClaudeCommandLifecycleMessage,
): void {
  const ledger = claudeSdkTurns(context.record);
  if (lifecycle.state === 'started') {
    // Only this CLI reports lifecycle, so it also reports the init that
    // follows; mark it even if the uuid is not one Station tracks.
    ledger.lifecycleMessages = true;
    ledger.startedAwaitingInit = true;
    startCommand(context, lifecycle.command_uuid);
    return;
  }
  if (lifecycle.state === 'cancelled') {
    const index = ledger.queued.findIndex(
      (turn) => turn.turnId === lifecycle.command_uuid,
    );
    if (index !== -1) ledger.queued.splice(index, 1);
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
  openProviderTurn(context);
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
    setRunning(context.record, ledger.queued.shift());
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
 * send's — the SDK runs prompts in the order they were pushed. Resolved
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
  if (!ledger.running && ledger.lifecycleMessages !== true) {
    // Without lifecycle messages the next queued send runs next.
    const next = ledger.queued.shift();
    if (next) setRunning(record, next);
  }
}

/**
 * The SDK iterator ended: a turn the engine opened on its own will never
 * report its end, so it is closed here. Dispatched turns are left as they
 * are — their terminal comes from the failure that ended the iterator or
 * from `session.exited`, as before this ledger existed.
 */
export function endClaudeProviderTurn(context: ClaudeSdkTurnContext): void {
  closeProviderTurnWithoutResult(context, 'session-ended');
}

/** A terminal failure: nothing is running any more. */
export function clearClaudeSdkTurns(
  context: ClaudeSdkTurnContext,
  reason: ProviderTurnCloseReason = 'session-ended',
): void {
  closeProviderTurnWithoutResult(context, reason);
  const ledger = claudeSdkTurns(context.record);
  ledger.queued = [];
  ledger.steers.clear();
  ledger.startedAwaitingInit = false;
  setRunning(context.record, undefined);
}
