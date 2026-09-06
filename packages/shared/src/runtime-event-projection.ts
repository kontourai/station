import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { TurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import type {
  ConversationMessage,
  MessagePart,
} from './conversation-message.js';
import { assembleTurnProvenanceEnvelopes } from './turn-provenance-fold.js';

function repeatedRuntimeErrorText(message: string, count: number) {
  const text = `⚠️ ${message}`;
  return count > 1 ? `${text} (repeated ${count}×)` : text;
}

/**
 * station#3769: every part this function writes carries `runtimeError: true`.
 * The `⚠️` is presentation — a reader's cue, and one a translation or a
 * restyle is free to change. The flag is the machine-readable fact, and it is
 * what the dock's failure-ownership predicate matches on, so "the transcript
 * already shows this failure" stops depending on a glyph.
 */
function runtimeErrorPart(text: string, code?: string): MessagePart {
  return {
    type: 'text',
    text,
    runtimeError: true,
    // #765 A1: keep the structured code beside the prose so a rehydrated
    // failure can be translated exactly like the live one, instead of only
    // ever rendering the engine's raw error text.
    ...(code ? { runtimeErrorCode: code } : {}),
  };
}

function appendRuntimeErrorPart(
  parts: MessagePart[],
  message: string,
  code?: string,
) {
  const previous = parts.at(-1);
  const prefix = `⚠️ ${message}`;
  const previousText = previous?.type === 'text' ? previous.text : undefined;
  if (previousText?.startsWith(prefix)) {
    const suffix = previousText.slice(prefix.length);
    const match = /^ \(repeated (\d+)×\)$/.exec(suffix);
    if (suffix && !match) return [...parts, runtimeErrorPart(prefix, code)];
    const count = match ? Number(match[1]) + 1 : 2;
    return [
      ...parts.slice(0, -1),
      {
        ...previous,
        ...runtimeErrorPart(repeatedRuntimeErrorText(message, count), code),
      },
    ];
  }
  return [...parts, runtimeErrorPart(prefix, code)];
}

/**
 * Project a durable `CanonicalRuntimeEvent` stream (the orchestration EventStore)
 * into the canonical conversation-message shape every chat surface consumes.
 *
 * This is the single source of truth for "turn events → chat messages". The
 * native-SDK path (Claude/Codex) persists turns as events, so it can refresh by
 * replaying them through this projection — no second copy in the memory store —
 * and the ACP/internal paths can converge on the same projection over time.
 *
 * Lives in station-shared so the server read path and the client replay can use
 * the identical mapping. Pure and deterministic: no I/O, no clock/random, output
 * order follows input. Callers rendering bounded/prepended windows may request
 * ids derived from the authoritative turn-start event; all other callers keep
 * the established deterministic positional ids.
 */

/**
 * station#4080 slice 1: the honest interrupted-turn banner's default text,
 * shared so the two write paths (this projection's `session.state-changed`
 * case, and the FileMemory `[SYSTEM_EVENT]` marker
 * `interrupted-turn-recovery.ts` writes for Station-engine chats) say the
 * exact same thing regardless of which store a given engine's transcript
 * lives in.
 */
export const TURN_INTERRUPTED_MESSAGE =
  'Turn interrupted — the process restarted while this turn was in progress.';

/**
 * Canonical observed assistant identity for an event-backed turn. The same
 * factory is consumed by the general conversation projection and Basis; a
 * caller must not recreate this tuple from turn position or text.
 */
export function observedAssistantMessageId(
  turnStartEventId: unknown,
): string | null {
  return typeof turnStartEventId === 'string' && turnStartEventId.length > 0
    ? `${turnStartEventId}:assistant`
    : null;
}

export function projectRuntimeEventsToMessages(
  events: CanonicalRuntimeEvent[],
  options: { stableIds?: boolean } = {},
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const turnKey = (
    sessionId: string | undefined,
    turnId: string | undefined,
  ) =>
    sessionId && turnId
      ? `${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}`
      : undefined;

  // station#1410: one extra pass over the same durable events assembles a
  // provenance envelope per completed turn, which the assistant message for
  // that turn then carries. Deriving it here (rather than persisting a
  // parallel record) keeps the canonical event stream the only store —
  // the envelope is a projection, exactly like the messages themselves.
  const envelopesByTurn = new Map<string, TurnProvenanceEnvelope>(
    assembleTurnProvenanceEnvelopes(events).map((envelope) => [
      turnKey(envelope.sessionId, envelope.turnId)!,
      envelope,
    ]),
  );
  // The turn whose events are currently being folded, read straight off the
  // events' own `turnId` — never inferred from ordering.
  let turnIdentity: string | undefined;
  let turnAnchorEventId: string | undefined;
  let approvalTargets = new Map<string, MessagePart>();
  /**
   * station#1410: adopt a terminal event's turn id ONLY when it is plausibly
   * about the content we have buffered.
   *
   * A terminal event usually closes the turn we are mid-way through, and it
   * is also the authoritative identity when that turn's `turn.started` fell
   * outside this replay window. But adapters do emit a terminal for an
   * EARLIER turn after the next one has already begun streaming (see
   * `finalizeAssistantTurn`'s note about a `turn.completed` arriving after
   * an error). Taking that foreign id would stamp the earlier turn's
   * provenance envelope onto THIS turn's text — an exact, confident, wrong
   * attribution, which is worse than no card at all.
   *
   * So an open turn keeps its own identity, and the buffered content still
   * resolves to the right envelope (the envelope map is built from the whole
   * stream, so a later terminal for this turn is already accounted for).
   */
  const adoptTerminalIdentity = (terminalTurnId: string | undefined) => {
    if (!turnIdentity) turnIdentity = terminalTurnId;
  };

  let parts: MessagePart[] = [];
  let textBuf = '';
  let reasoningBuf = '';
  let toolsByCallId = new Map<string, MessagePart>();
  // A result id is globally owner-issued. It distinguishes two terminal
  // results which legitimately reuse a provider's toolCallId.
  let terminalToolsByEventId = new Map<string, MessagePart>();
  /**
   * station#1558: tool calls whose `tool.started` was folded into a turn this
   * projection has ALREADY emitted, and whose `tool.completed` has not
   * arrived yet.
   *
   * `toolsByCallId` is per-turn and reset by `emitAssistantTurn`, so before
   * this map a completion that arrived after the next turn opened could not
   * find its own call. It landed in whatever turn happened to be open — as a
   * settled row on the wrong turn, or (with no start there either) as a
   * standalone result-only part on it. The event names its turn
   * (`turnId`, PR #1560); reading the stream position instead is exactly the
   * confident wrong attribution the provenance fold
   * (`turn-provenance-fold.ts`, which groups by `turnId` and was already
   * right) avoids.
   *
   * The parts held here are the SAME objects already inside an emitted
   * message's `parts` array, so mutating one settles the row in place on its
   * own turn.
   */
  const carriedToolsByCallId = new Map<string, MessagePart>();
  /**
   * station#1558: `turnKey` → index in `messages` of the assistant message
   * emitted for that turn, so a late completion with no matching start can
   * still be appended to the turn its own `turnId` names rather than to the
   * open one.
   */
  const assistantMessageIndexByTurn = new Map<string, number>();
  let turnOpen = false;
  let turnTimestamp: number | undefined;
  let turnModel: string | undefined;
  let turnModelOptions: Record<string, string | number | boolean> | undefined;
  // A visible conversation can outlive one execution Session. Keep the
  // origin on each projected row so later affordances never substitute the
  // currently active Session for historical turn identity.
  let turnSessionId: string | undefined;
  let turnAnswerEligible = false;
  const revokedAnswerTurns = new Set<string>();
  // station#1182: `turnReportedModel` is per-turn (set from turn.started/
  // turn.completed metadata); `sessionReportedModel` is the last value seen
  // on a session.configured event, carried forward as a fallback across
  // turns that don't themselves carry one (mirrors how `model` persists via
  // session.configured today). Never derived from `turnModel`/
  // `sessionModel` — an absent runtime report stays absent.
  let turnReportedModel: string | undefined;
  let sessionReportedModel: string | undefined;
  // station#1182 fix round (review-found HIGH): `sessionReportedModel` was
  // carried forward across a model switch with no correlation to which
  // model generation it belonged to — e.g. Codex's #903 restatement
  // republishes `session.configured` with a new `model` but no `metadata`
  // at all, and Claude's mid-session switch never republishes
  // `session.configured` at all, only the next `turn.started`'s
  // `effectiveModel` moves. `currentGenerationModel` tracks the last model
  // identity established by either `session.configured` or `turn.started`;
  // `noteModelGeneration` invalidates `sessionReportedModel` whenever that
  // identity changes without a fresh `reportedModel` arriving alongside it,
  // so a stale value from a superseded model is never surfaced as current.
  let currentGenerationModel: string | undefined;
  const noteModelGeneration = (
    model: string | undefined,
    reportedModel: string | undefined,
  ) => {
    if (model && model !== currentGenerationModel) {
      currentGenerationModel = model;
      sessionReportedModel = reportedModel;
    } else if (reportedModel) {
      sessionReportedModel = reportedModel;
    }
  };

  const pushMessage = (
    role: ConversationMessage['role'],
    p: MessagePart[],
    inputKind?: 'steer',
  ) => {
    const reportedModel = turnReportedModel ?? sessionReportedModel;
    // station#1410: only an assistant turn that both has an observed turn
    // identity AND reached a terminal event has an envelope. An open or
    // untagged turn carries none rather than a partially-folded one.
    const provenance =
      role === 'assistant' && turnIdentity
        ? envelopesByTurn.get(turnKey(turnSessionId, turnIdentity) ?? '')
        : undefined;
    const metadata = {
      ...(turnTimestamp !== undefined ? { timestamp: turnTimestamp } : {}),
      ...(role === 'user' && inputKind ? { inputKind } : {}),
      ...(role === 'user' && turnAnchorEventId
        ? { sourceEventId: turnAnchorEventId }
        : {}),
      ...(role === 'user' && turnIdentity ? { turnId: turnIdentity } : {}),
      ...(role === 'user' && turnSessionId ? { sessionId: turnSessionId } : {}),
      ...(role === 'assistant' && turnModel ? { model: turnModel } : {}),
      ...(role === 'assistant' && turnModelOptions
        ? { modelOptions: turnModelOptions }
        : {}),
      ...(role === 'assistant' && reportedModel ? { reportedModel } : {}),
      ...(role === 'assistant' && turnIdentity ? { turnId: turnIdentity } : {}),
      ...(role === 'assistant' && turnSessionId
        ? { sessionId: turnSessionId }
        : {}),
      ...(role === 'assistant' && turnAnswerEligible
        ? { answerEligible: true }
        : {}),
      ...(provenance ? { provenance } : {}),
    };
    messages.push({
      id:
        role === 'assistant'
          ? (observedAssistantMessageId(turnAnchorEventId) ??
            `proj-${messages.length}`)
          : options.stableIds && turnAnchorEventId
            ? `${turnAnchorEventId}:${role}`
            : `proj-${messages.length}`,
      role,
      parts: p,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
    // station#1558: only an assistant row carries a turn's activity, and only
    // the FIRST row emitted for a turn identity owns it — a re-emission would
    // otherwise redirect a late result away from the row that shows the call.
    const emittedKey =
      role === 'assistant' ? turnKey(turnSessionId, turnIdentity) : undefined;
    if (emittedKey && !assistantMessageIndexByTurn.has(emittedKey)) {
      assistantMessageIndexByTurn.set(emittedKey, messages.length - 1);
    }
  };

  const flushText = () => {
    if (textBuf) {
      parts.push({ type: 'text', text: textBuf });
      textBuf = '';
    }
  };
  const flushReasoning = () => {
    if (reasoningBuf) {
      parts.push({ type: 'reasoning', text: reasoningBuf });
      reasoningBuf = '';
    }
  };

  const emitAssistantTurn = () => {
    flushReasoning();
    flushText();
    if (parts.length > 0) pushMessage('assistant', parts);
    // station#1558: an unsettled call outlives its turn (a stopped turn's
    // in-flight tool, a backgrounded Task). `toolsByCallId` only ever holds
    // calls with no terminal yet — the terminal branch deletes the slot — so
    // everything left here is still owed a result on THIS turn's row.
    for (const [callId, part] of toolsByCallId) {
      carriedToolsByCallId.set(callId, part);
    }
    parts = [];
    textBuf = '';
    reasoningBuf = '';
    toolsByCallId = new Map();
    terminalToolsByEventId = new Map();
    approvalTargets = new Map();
    turnOpen = false;
    turnTimestamp = undefined;
    turnModel = undefined;
    turnModelOptions = undefined;
    turnReportedModel = undefined;
    turnIdentity = undefined;
    turnSessionId = undefined;
    turnAnswerEligible = false;
    turnAnchorEventId = undefined;
  };

  const stamp = (createdAt?: string) => {
    if (!createdAt) return;
    const ms = Date.parse(createdAt);
    if (!Number.isNaN(ms)) turnTimestamp = ms;
  };

  const resultText = (output: unknown, error?: string): string | undefined => {
    if (typeof output === 'string') return output;
    if (output != null) {
      try {
        return JSON.stringify(output);
      } catch {
        return String(output);
      }
    }
    return error ?? undefined;
  };

  for (const ev of events) {
    switch (ev.method) {
      case 'turn.started': {
        if (turnOpen) emitAssistantTurn();
        turnOpen = true;
        turnIdentity = ev.turnId;
        turnSessionId = ev.threadId;
        turnAnchorEventId = ev.eventId;
        stamp(ev.createdAt);
        turnModel =
          typeof ev.metadata?.effectiveModel === 'string'
            ? ev.metadata.effectiveModel
            : undefined;
        const rawModelOptions = ev.metadata?.effectiveModelOptions;
        turnModelOptions =
          rawModelOptions &&
          typeof rawModelOptions === 'object' &&
          !Array.isArray(rawModelOptions)
            ? (rawModelOptions as Record<string, string | number | boolean>)
            : undefined;
        turnReportedModel =
          typeof ev.metadata?.reportedModel === 'string'
            ? ev.metadata.reportedModel
            : undefined;
        // station#1182 fix round: a turn.started that moves the effective
        // model without its own reportedModel invalidates any carried-over
        // sessionReportedModel — it belongs to the prior model generation.
        noteModelGeneration(turnModel, turnReportedModel);
        const userParts: MessagePart[] = [];
        if (ev.prompt) userParts.push({ type: 'text', text: ev.prompt });
        for (const attachment of ev.attachments ?? []) {
          // `url` is omitted, not empty, when the bytes are not in this read:
          // retention reclaimed the blob, or the caller asked for a bounded
          // window that hands on the reference instead (station#3374). The
          // part still carries what the turn provably contained — this file,
          // by this name, of this type — so the transcript shows a chip
          // rather than losing the attachment entirely.
          userParts.push({
            type: 'file',
            ...(attachment.dataUrl === undefined
              ? {}
              : { url: attachment.dataUrl }),
            ...(attachment.blobRef === undefined
              ? {}
              : { blobRef: attachment.blobRef }),
            mediaType: attachment.mimeType,
            name: attachment.name,
          });
        }
        if (userParts.length > 0) {
          pushMessage('user', userParts, ev.inputKind);
        }
        break;
      }
      case 'content.text-delta': {
        turnSessionId ??= ev.threadId;
        turnOpen = true;
        flushReasoning();
        textBuf += ev.delta ?? '';
        break;
      }
      case 'content.reasoning-delta': {
        turnSessionId ??= ev.threadId;
        turnOpen = true;
        flushText();
        reasoningBuf += ev.delta ?? '';
        break;
      }
      case 'tool.started': {
        turnSessionId ??= ev.threadId;
        turnOpen = true;
        flushText();
        flushReasoning();
        // Upsert by call id: a repeated tool.started (e.g. a corrected
        // re-emission carrying the real programmatic name/args that arrived
        // late) must update the existing part, not append a duplicate row.
        const existing = toolsByCallId.get(ev.toolCallId);
        if (existing) {
          if (ev.toolName !== undefined) existing.toolName = ev.toolName;
          if (ev.arguments !== undefined) existing.args = ev.arguments;
          existing.state = 'call';
          break;
        }
        const part: MessagePart = {
          type: 'tool-invocation',
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          args: ev.arguments,
          state: 'call',
        };
        toolsByCallId.set(ev.toolCallId, part);
        parts.push(part);
        break;
      }
      case 'tool.completed': {
        turnSessionId ??= ev.threadId;
        const text = resultText(ev.output, ev.error);
        // station#3167: `cancelled` gets its own branch instead of folding
        // into `isError` — a rehydrated cancellation used to render as
        // "error", contradicting the live path's own `state: 'cancelled'`
        // (`streamHandlers.ts`'s `handleToolCompletedEvent`). `isError`
        // keeps meaning "failed" specifically, so anything downstream that
        // counts failures from it (e.g. `thread-projection.ts`'s export
        // fold, which reads `isError`/`state === 'error'` to mark an
        // exported tool result as failed) does not start counting
        // cancellations.
        const isError = ev.status === 'error';
        const isCancelled = ev.status === 'cancelled';
        // station#1558: `unresolved` is its own part state for the same
        // reason `cancelled` is one — it is neither a failure (nothing
        // observed the tool fail) nor a stop anyone asked for. The session
        // ended with the call open, so no result can ever arrive. Folding it
        // into `result` would render the "no result" sentence as the tool's
        // output; folding it into `error` would blame the tool.
        const isUnresolved = ev.status === 'unresolved';
        const derivedState = isError
          ? 'error'
          : isCancelled
            ? 'cancelled'
            : isUnresolved
              ? 'unresolved'
              : 'result';
        // station#3117: derived ONLY from the event's own marker — never
        // inferred from `isError` alone, so a rehydrated transcript shows
        // the same distinct state a live one does (`streamHandlers.ts`'s
        // `handleToolCompletedEvent` applies the identical rule).
        const policyDenied = ev.policyDenied === true;
        const completed = terminalToolsByEventId.get(ev.eventId);
        // station#1558: the carried map is consulted last, so a call still
        // open in the CURRENT turn always wins over a same-id call carried
        // from an earlier one.
        const carried = toolsByCallId.has(ev.toolCallId)
          ? undefined
          : carriedToolsByCallId.get(ev.toolCallId);
        const existing =
          completed ?? toolsByCallId.get(ev.toolCallId) ?? carried;
        if (existing) {
          if (ev.toolName !== undefined) existing.toolName = ev.toolName;
          existing.state = derivedState;
          existing.output = ev.output;
          if (ev.outputReceipt?.truncated) existing.outputTruncated = true;
          existing.error = ev.error;
          existing.sourceEventId = ev.eventId;
          existing.cancelled = isCancelled;
          if (text !== undefined) existing.result = text;
          existing.isError = isError;
          // Overrides any earlier call-time approvalStatus (e.g. an
          // optimistic 'auto-approved') — Station's own policy can deny a
          // call the client believed pre-approved, and this is the
          // authoritative, later verdict.
          if (policyDenied) existing.approvalStatus = 'policy-denied';
          terminalToolsByEventId.set(ev.eventId, existing);
          // A terminal settles this call slot. A later terminal reusing the
          // same call id must become a distinct durable result, not overwrite
          // this sourceEventId.
          if (!completed) {
            toolsByCallId.delete(ev.toolCallId);
            carriedToolsByCallId.delete(ev.toolCallId);
          }
        } else {
          // Completion without a captured start (replay gap) — still surface it.
          // station#1558: on the turn the event NAMES. An already-emitted turn
          // takes the row; only a completion for the open turn (or one whose
          // turn this window never saw at all) reaches the live buffer, and
          // the fallback is documented at the push below.
          const namedTurnIndex =
            ev.turnId === undefined
              ? undefined
              : assistantMessageIndexByTurn.get(
                  turnKey(ev.threadId, ev.turnId) ?? '',
                );
          const part: MessagePart = {
            type: 'tool-invocation',
            toolCallId: ev.toolCallId,
            sourceEventId: ev.eventId,
            toolName: ev.toolName,
            state: derivedState,
            output: ev.output,
            ...(ev.outputReceipt?.truncated
              ? { outputTruncated: true as const }
              : {}),
            error: ev.error,
            cancelled: isCancelled,
            isError,
            ...(policyDenied ? { approvalStatus: 'policy-denied' } : {}),
            ...(text !== undefined ? { result: text } : {}),
          };
          terminalToolsByEventId.set(ev.eventId, part);
          if (namedTurnIndex !== undefined) {
            messages[namedTurnIndex]!.parts.push(part);
          } else {
            // Either the event names the turn currently being folded, or it
            // names one whose `turn.started` fell outside this bounded window
            // and which therefore has no row to attach to. The open turn is
            // the only surface left; the part carries its own identity.
            turnOpen = true;
            flushText();
            flushReasoning();
            parts.push(part);
          }
        }
        break;
      }
      case 'tool.progress': {
        const existing = toolsByCallId.get(ev.toolCallId);
        if (existing) {
          existing.progressMessage = ev.message;
          if (ev.outputReceipt?.truncated) existing.outputTruncated = true;
        }
        break;
      }
      case 'request.opened': {
        const toolName = ev.payload?.toolName ?? ev.payload?.tool;
        const toolCallId = ev.payload?.toolCallId;
        const target = [...toolsByCallId.values()]
          .reverse()
          .find(
            (part) =>
              (typeof toolCallId === 'string' &&
                part.toolCallId === toolCallId) ||
              (typeof toolName === 'string' && part.toolName === toolName),
          );
        if (target) {
          target.needsApproval = true;
          target.approvalId = ev.requestId;
          target.state = 'awaiting-approval';
          approvalTargets.set(ev.requestId, target);
        }
        break;
      }
      case 'request.resolved': {
        const target = approvalTargets.get(ev.requestId);
        if (target) {
          target.needsApproval = false;
          target.approvalStatus =
            ev.status === 'approved'
              ? 'user-approved'
              : ev.status === 'denied'
                ? 'user-denied'
                : undefined;
        }
        break;
      }
      case 'runtime.error': {
        turnSessionId ??= ev.threadId;
        // Surface errors inline rather than letting a failed turn render blank.
        turnOpen = true;
        flushText();
        flushReasoning();
        parts = appendRuntimeErrorPart(parts, ev.message, ev.code);
        break;
      }
      case 'turn.aborted': {
        const revoked = turnKey(ev.threadId, ev.turnId);
        if (revoked) revokedAnswerTurns.add(revoked);
        turnSessionId ??= ev.threadId;
        adoptTerminalIdentity(ev.turnId);
        turnAnswerEligible = false;
        stamp(ev.createdAt);
        flushText();
        if (ev.reason) parts.push({ type: 'text', text: `_${ev.reason}_` });
        emitAssistantTurn();
        break;
      }
      case 'turn.completed': {
        turnSessionId ??= ev.threadId;
        adoptTerminalIdentity(ev.turnId);
        turnAnswerEligible = ev.finishReason !== 'cancelled';
        stamp(ev.createdAt);
        // station#1182: some adapters (e.g. Claude — see
        // claude-adapter-events.ts) only learn the runtime-reported model
        // once the turn's API response has arrived, so turn.completed can
        // carry a value turn.started did not have yet.
        if (typeof ev.metadata?.reportedModel === 'string') {
          turnReportedModel = ev.metadata.reportedModel;
        }
        // Fall back to the authoritative outputText only if no text was streamed.
        const hasText =
          Boolean(textBuf) || parts.some((p) => p.type === 'text');
        if (!hasText && ev.outputText) textBuf = ev.outputText;
        emitAssistantTurn();
        break;
      }
      case 'session.configured': {
        // station#1182: no chat content, but persist a session-level
        // reported-model fallback (e.g. Codex/ACP report it here, not
        // per-turn) so a turn.started that carries none still has one.
        //
        // station#1182 fix round: a model switch can arrive here as either
        // the top-level `model` field (Codex's #903 restatement republishes
        // session.configured with `model` but no `metadata` at all) or
        // `metadata.effectiveModel`. Either signal moving without a fresh
        // `reportedModel` alongside it must invalidate the carried-forward
        // fallback rather than let a prior generation's value survive.
        const sessionModel =
          typeof ev.metadata?.effectiveModel === 'string'
            ? ev.metadata.effectiveModel
            : typeof ev.model === 'string'
              ? ev.model
              : undefined;
        const sessionReportedModelFromEvent =
          typeof ev.metadata?.reportedModel === 'string'
            ? ev.metadata.reportedModel
            : undefined;
        noteModelGeneration(sessionModel, sessionReportedModelFromEvent);
        break;
      }
      case 'session.state-changed': {
        // station#4080 slice 1 (review round 1, M3): gate on
        // `interruptedTurnBoundary` — a field documented as written ONLY by
        // the boot-time interrupted-turn consumer — rather than on the
        // (sessionState, transitionReason, transitionSource) vocabulary
        // triple those fields also carry. That triple is ordinary enum
        // vocabulary a future generic transition could legitimately
        // reproduce for an unrelated reason; this field cannot be minted by
        // anything else, so a fabricated triple with no field renders no
        // banner. Every other `session.state-changed` still carries no chat
        // content and falls through to `default` below.
        if (!ev.interruptedTurnBoundary?.boundaryId) {
          break;
        }
        turnSessionId ??= ev.threadId;
        stamp(ev.createdAt);
        // Close out any partial assistant output the crash left open BEFORE
        // the banner, so the banner reads after what the user actually saw
        // — not before it.
        if (turnOpen) emitAssistantTurn();
        pushMessage('user', [
          {
            type: 'text',
            text: `[SYSTEM_EVENT] [TURN_INTERRUPTED] ${ev.reason ?? TURN_INTERRUPTED_MESSAGE}`,
          },
        ]);
        break;
      }
      default:
        // session.started/exited, token-usage.*, tool.progress, request.*,
        // flow.*, policy.* carry no chat content — ignored. (An ordinary
        // session.state-changed also carries none; the one exception is
        // handled above, before it ever reaches this branch.)
        break;
    }
  }

  if (turnOpen) emitAssistantTurn();
  return messages.map((message) => {
    if (
      message.role !== 'assistant' ||
      !message.metadata?.turnId ||
      !revokedAnswerTurns.has(
        turnKey(message.metadata.sessionId, message.metadata.turnId) ?? '',
      )
    ) {
      return message;
    }
    const {
      answerEligible: _eligible,
      provenance: _provenance,
      ...metadata
    } = message.metadata;
    return { ...message, metadata };
  });
}
