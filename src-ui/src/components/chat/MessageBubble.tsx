import { readTaskProposal } from '@kontourai/station-contracts/task-graph';
import { isSupportedTurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import { Fragment, memo, type ReactNode, useCallback, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';
import { isReplayThread } from '../../hooks/orchestration/replay/replay-registry';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMessageDeliveryState } from '../../hooks/useMessageDeliveryState';
import type { ChatMessage } from '../../types';
import { modelIdentityLabel } from '../../utils/modelCapabilities';
import type { OwnerAttribution } from '../../utils/ownerAttribution';
import { absoluteTime, messageTime } from '../../utils/relativeTime';
import { FlowGateVerdictCard } from '../flow/FlowGateVerdictCard';
import { FlowRunAttachedMarker } from '../flow/FlowRunAttachedMarker';
import { AgentIcon } from '../icons/AgentIcon';
import { CopyGlyph, PauseGlyph } from '../icons/Glyph';
import { UserIcon } from '../icons/UserIcon';
import { LazyBoundary } from '../LazyBoundary';
import { Skeleton } from '../state';
import { ConversationContextBoundary } from './ConversationContextBoundary';
import { ConversationHandoffBoundary } from './ConversationHandoffBoundary';
import { type ForkTurnSource, forkTurnSource } from './fork-turn-source';
import { MessageDetails } from './MessageDetails';
import { MessageAttribution } from './message-bubble/MessageAttribution';
import { MessageContent } from './message-bubble/MessageContent';
import {
  type DeliveryNotice,
  MessageDeliveryNote,
} from './message-bubble/MessageDeliveryNote';
import { MessageRating } from './message-bubble/MessageRating';
import {
  resolveTurnEngine,
  resolveTurnEngineId,
  resolveTurnModelIdentity,
  turnCompletedNormally,
} from './message-bubble/utils';
import { useHasVisibleTranscriptContent } from './message-bubble/visibleContent';
import { TaskProposalCard } from './TaskProposalCard';
import type { ToolApprovalOutcome } from './ToolCallDisplay';
import { TranscriptMarker, transcriptMarkerLabel } from './TranscriptMarker';
import './chat.css';

// The Task picker owns SDK queries, mutations, dialog primitives, and its own
// styles. Keep that optional interaction out of the first-paint chat bundle;
// completed-answer rows load it only when they can actually render the
// affordance. This follows the existing chat lazy-boundary pattern used for
// markdown and model selection.
const loadConnectedAttachUserInputToTaskButton = () =>
  import('./AttachAnswerToTaskButton').then((module) => ({
    default: module.ConnectedAttachUserInputToTaskButton,
  }));

// The Basis chip mounts on every eligible settled answer, so it loads its
// own small chunk rather than the Task picker's.
const loadConnectedAnswerBasisAffordance = () =>
  import('./ConnectedAnswerBasisAffordance').then((module) => ({
    default: module.ConnectedAnswerBasisAffordance,
  }));

const loadTurnActionsMenu = () => import('./TurnActionsMenu');
const loadCheckpointRestoreButton = () =>
  import('./CheckpointRestoreButton').then((module) => ({
    default: module.CheckpointRestoreButton,
  }));
const loadUserMessageActionsMenu = () =>
  import('./TurnActionsMenu').then((module) => ({
    default: module.UserMessageActionsMenu,
  }));
const loadShareAnswerButton = () =>
  import('./ShareAnswerButton').then((module) => ({
    default: module.ShareAnswerButton,
  }));

/**
 * The exact fields a row reads off the active session — not the session.
 *
 * `useDerivedSessions` mints a new `ChatSession` per streamed token by design
 * (the plan panel needs the artifact to advance), so passing the whole object
 * made every mounted row miss `memo` on every token even though none of these
 * eight values had moved. `messages` and `pendingApprovals` are counts here
 * because a row only ever read their lengths, and an array whose identity
 * churns per token would have defeated the memo just as thoroughly.
 */
export interface MessageBubbleSession {
  id: string;
  agentSlug: string;
  /**
   * archive#1424: the session's own threaded
   * agent name (`ChatSession.agentName`, already carries a slug/'Unknown
   * Agent' attribution chain from `deriveSession`) — the attribution strip's
   * fallback when `agents.find` misses (e.g. the agent was deleted after
   * this session started), so the row stays attributable instead of
   * silently dropping the identity text next to a now-orphaned owner chip.
   */
  agentName?: string;
  /** Project scope used to list eligible durable Tasks, when known. */
  projectSlug?: string;
  /** Present once a conversation can span replacement execution Sessions. */
  conversationId?: string;
  /** `activeSession.messages.length` — the row only needs to know if it is last. */
  messageCount: number;
  isThinking?: boolean;
  /** `activeSession.pendingApprovals.length`; the row renders only the count. */
  pendingApprovalCount?: number;
  /** The host's status pill presents activity and approvals; see
   * `ChatMessageList.statusShownElsewhere`. */
  activityShownElsewhere?: boolean;
  /**
   * The phone transcript folds a SETTLED assistant row's tool work into one
   * row (`MessageContent`'s `foldWork`). Only a caller that knows which row
   * is still the open turn sets this; without it no row folds.
   */
  foldSettledWork?: boolean;
  /** The open turn's id while a turn is live (`isTurnStreamLive`). */
  liveTurnId?: string;
  /** The live turn renders as the transcript's last row rather than in the
   * streaming shell (`ChatMessageList`'s `suppressStreamingRow`). */
  liveTailRow?: boolean;
}

type MessageContentPart = NonNullable<ChatMessage['contentParts']>[number];

// Hoisted (archive#1424 fix N4) so `agent || FALLBACK_AGENT` doesn't
// allocate a fresh object — and therefore a fresh `<AgentIcon>` element
// identity — on every render. Only feeds the avatar glyph (which needs some
// name for its initials source); the attribution strip below never uses
// this placeholder — see the `agent={agent ?? null}` call further down.
const FALLBACK_AGENT: { name: string } = { name: 'AI' };

/**
 * Which answer an answer's Basis controls belong to, by its opening words or,
 * wordless, its settle time: the chip's accessible name says it after its
 * visible text (`AnswerBasisAffordance`), and so does the chunk-failure Retry.
 */
export function answerBasisLabels(
  text: string,
  settledAt: number,
): { answer: string; retry: string } {
  const words = text.replace(/\s+/g, ' ').trim();
  const at = absoluteTime(settledAt);
  const answer = words
    ? `the answer “${words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words}”`
    : at
      ? `the answer at ${at}`
      : 'this answer';
  return {
    answer,
    retry: `Basis didn’t load · Retry for ${answer}`,
  };
}

/** A fixed, ordered list of optional slots (never reordered), so its index
 * is a stable key. */
function renderList(items: readonly ReactNode[]) {
  return items.map((item, index) => <Fragment key={index}>{item}</Fragment>);
}

interface MessageBubbleProps {
  msg: ChatMessage;
  idx: number;
  activeSession: MessageBubbleSession;
  agents: AgentData[];
  chatFontSize: number;
  showReasoning: boolean;
  showToolDetails: boolean;
  onCopy: (text: string) => void;
  onForkFromTurn?: (source: ForkTurnSource) => void;
  /** The previous row belongs to the same turn (a steer, or the rest of a
   * steered answer): no exchange starts here. */
  continuesTurn?: boolean;
  /** #2216: nearest preceding completed assistant turn, if any. */
  userForkSource?: ForkTurnSource | null;
  onNewChatFromMessage?: (text: string) => void;
  onToolApproval?: (
    sessionId: string,
    agentSlug: string,
    approvalId: string,
    toolName: string,
    action: 'once' | 'trust' | 'deny',
    approvalThreadId?: string,
    approvalEventId?: string,
  ) => Promise<ToolApprovalOutcome>;
  anchorKey?: string;
  /**
   * "via <Station>" row attribution (archive#2585), resolved by callers from
   * the active saved Station. Omitted call sites (e.g. a narrower test render)
   * simply render no Station chip.
   */
  owner?: OwnerAttribution | null;
  /** Display-only human accountability, shown in the expanded provenance. */
  accountableHuman?: string | null;
}

function MessageBubbleComponent({
  msg,
  idx,
  activeSession,
  agents,
  chatFontSize,
  showReasoning,
  showToolDetails,
  onCopy,
  onForkFromTurn,
  continuesTurn = false,
  userForkSource,
  onNewChatFromMessage,
  onToolApproval,
  anchorKey,
  owner,
  accountableHuman,
}: MessageBubbleProps) {
  const { developerToolsEnabled } = useDeviceSettings();
  const isMobile = useIsMobile();
  const textContent = typeof msg.content === 'string' ? msg.content : '';
  // The user's own message until the agent has it (`messageDeliveryState`).
  // Hoisted above the early returns below: hooks run unconditionally.
  const deliveryState = useMessageDeliveryState(activeSession.id, msg);
  const undelivered =
    msg.role === 'user' &&
    msg.clientId !== undefined &&
    deliveryState !== undefined &&
    deliveryState !== 'delivered'
      ? deliveryState
      : undefined;
  // Discard of a not-sent message runs from the bubble's ⋯ menu; its result
  // is reported on the bubble's delivery line.
  const [deliveryNotice, setDeliveryNotice] = useState<DeliveryNotice | null>(
    null,
  );
  const discardUnsent =
    undelivered === 'not-sent' && msg.clientId
      ? () => {
          const key = msg.clientId!;
          setDeliveryNotice(null);
          void import('../../lib/messageDeliveryActions')
            .then(async ({ discardMessage, ALREADY_DELIVERED }) => {
              if (
                (await discardMessage(activeSession.id, key, 'not-sent')) ===
                'delivered'
              )
                setDeliveryNotice({ text: ALREADY_DELIVERED, error: false });
            })
            .catch((error: unknown) =>
              setDeliveryNotice({
                text: `That didn't work: ${error instanceof Error ? error.message : String(error)}`,
                error: true,
              }),
            );
        }
      : undefined;

  // Hoisted above the flowPart early-return (hooks can't be called
  // conditionally) and stabilized so the memoized MessageContent below
  // doesn't get a fresh closure — and therefore re-renders/re-parses its
  // markdown — every time MessageBubble itself re-renders for an unrelated
  // reason (e.g. a sibling message's isThinking flag flipping).
  const handleContentToolApproval = useCallback(
    (part: MessageContentPart, action: 'once' | 'trust' | 'deny') => {
      if (!onToolApproval)
        return Promise.reject(new Error('This chat cannot answer requests.'));
      const toolName = part.toolName || part.name;
      if (!part.approvalId || !toolName) {
        return Promise.reject(
          new Error('This request is missing its identity.'),
        );
      }
      return onToolApproval(
        activeSession.id,
        activeSession.agentSlug,
        part.approvalId,
        toolName,
        action,
        part.approvalThreadId,
        part.approvalEventId,
      );
    },
    [onToolApproval, activeSession.id, activeSession.agentSlug],
  );

  // One rule with the streaming row (`visibleContent.ts`): an assistant row
  // with nothing to draw renders no bubble at all, rather than a header over
  // an empty card. Hoisted with the hooks above; read after the special rows.
  const hasVisibleContent = useHasVisibleTranscriptContent(
    msg.contentParts,
    textContent,
    { showReasoning },
  );

  const flowPart = msg.contentParts?.find(
    (part) =>
      part.type === 'flow-gate-verdict' || part.type === 'flow-run-attached',
  );
  if (flowPart) {
    return (
      <div
        className="message-row message-row--flow-event"
        data-chat-message-key={anchorKey}
      >
        {flowPart.type === 'flow-gate-verdict' && flowPart.flowGateVerdict ? (
          <FlowGateVerdictCard
            verdict={flowPart.flowGateVerdict}
            onCopy={onCopy}
          />
        ) : flowPart.flowRunAttached ? (
          <FlowRunAttachedMarker binding={flowPart.flowRunAttached} />
        ) : null}
      </div>
    );
  }

  const handoff = msg.contentParts?.find(
    (part) => part.type === 'conversation-handoff',
  )?.conversationHandoff;
  if (handoff) {
    return <ConversationHandoffBoundary handoff={handoff} agents={agents} />;
  }
  const contextBoundary = msg.contentParts?.find(
    (part) => part.type === 'conversation-context-boundary',
  )?.conversationContextBoundary;
  if (contextBoundary) {
    return <ConversationContextBoundary boundary={contextBoundary} />;
  }
  const transcriptMarker = transcriptMarkerLabel(msg.contentParts);
  if (transcriptMarker) {
    return <TranscriptMarker label={transcriptMarker} anchorKey={anchorKey} />;
  }

  // A user row always draws (its bubble carries delivery state even when
  // empty of text); an assistant row only once it has content.
  if (msg.role === 'assistant' && !hasVisibleContent) return null;

  const isLastMessage = idx === activeSession.messageCount - 1;
  const isStreamingMessage = isLastMessage && msg.role === 'assistant';

  const isAssistant = msg.role === 'assistant';
  // A row is the open turn when it carries the live turn's id, or when the
  // live turn renders as the last row instead of the streaming shell.
  const rowIsLiveTurn =
    (activeSession.liveTurnId !== undefined &&
      msg.turnId === activeSession.liveTurnId) ||
    (activeSession.liveTailRow === true && isLastMessage);
  const foldWork =
    isMobile &&
    isAssistant &&
    activeSession.foldSettledWork === true &&
    !rowIsLiveTurn;
  // The meta row's time is the turn's own terminal event time, read from the
  // turn's envelope: `msg.timestamp` can be a client-clock fill-in on some
  // load paths, and a historical row must never state one as its time.
  const envelope =
    isAssistant && isSupportedTurnProvenanceEnvelope(msg.provenance)
      ? msg.provenance
      : undefined;
  const settledAt = envelope ? Date.parse(envelope.observedAt) : Number.NaN;
  const hasTurnFooter =
    msg.role === 'assistant' &&
    (msg.provenance !== undefined || msg.turnId !== undefined);
  // Historical assistant rows own their execution Session identity. In the
  // legacy one-to-one shape only, the active Session is an equivalent
  // fallback; once a conversation id is present, guessing would attach a
  // historical answer to the wrong replacement Session.
  const replaying = isReplayThread(activeSession.id);
  const answerSessionId = replaying
    ? undefined
    : (msg.sessionId ??
      (activeSession.conversationId === undefined
        ? activeSession.id
        : undefined));
  const taskProposal =
    msg.role === 'assistant' &&
    msg.answerEligible === true &&
    msg.turnId &&
    answerSessionId
      ? readTaskProposal(textContent)
      : null;
  // An execution Session is immutable history once it has produced a turn.
  // A conversation can point at another current Session after a handoff, so
  // resolving this row through `activeSession.agentSlug` would relabel old
  // Codex answers as Claude. A one-session legacy transcript may still use
  // its active session because no replacement Session exists in that shape.
  const rowAgentSlug =
    msg.agentSlug ??
    (activeSession.conversationId === undefined
      ? activeSession.agentSlug
      : undefined);
  const exactCurrentSession =
    Boolean(msg.sessionId) && msg.sessionId === activeSession.id;
  const turnForkSource = forkTurnSource(
    msg,
    exactCurrentSession ? { agentSlug: activeSession.agentSlug } : undefined,
  );
  const feedbackConversationId = replaying
    ? undefined
    : (activeSession.conversationId ?? activeSession.id);
  const registeredRowAgent = rowAgentSlug
    ? agents.find((candidate) => candidate.slug === rowAgentSlug)
    : undefined;
  const resolvedRowAgent =
    (msg.agentDisplayName
      ? { slug: rowAgentSlug, name: msg.agentDisplayName, icon: msg.agentIcon }
      : registeredRowAgent) ??
    (rowAgentSlug
      ? {
          slug: rowAgentSlug,
          // A deleted agent is not a nameless one: the session threaded a
          // real `agentName` at turn time, and it names exactly this slug
          // whenever the row's agent IS the session's agent. Reaching for
          // the slug-derived placeholder first discards a human-readable
          // name in favour of an identifier (archive#1424).
          name:
            rowAgentSlug === activeSession.agentSlug && activeSession.agentName
              ? activeSession.agentName
              : `Deleted Agent “${rowAgentSlug}”`,
        }
      : undefined);
  // #3355: the avatar's engine mark is the engine that ran THIS turn, read
  // from the turn's own envelope (`resolveTurnEngineId`), in every branch
  // above — so a Codex turn draws the Codex mark rather than initials, and a
  // rebound agent cannot relabel history (archive#1424). A row without an
  // envelope keeps whatever the branch already carried.
  const turnEngineId = isAssistant ? resolveTurnEngineId(msg) : undefined;
  const rowAgent =
    resolvedRowAgent && turnEngineId
      ? { ...resolvedRowAgent, engineId: turnEngineId }
      : resolvedRowAgent;
  const avatarContent = isAssistant ? (
    <AgentIcon agent={rowAgent ?? FALLBACK_AGENT} size={20} />
  ) : (
    <UserIcon size={20} />
  );
  // archive#1424 fix, wired to its authority in archive#1434:
  // `msg` is a COMPLETED, persisted turn, so its engine chip reads only the
  // turn's own provenance envelope (see `resolveTurnEngine`'s doc comment),
  // never `agent`'s current live binding.
  const engine = isAssistant ? resolveTurnEngine(msg) : null;
  // archive#1434: this component composes the row's identity surfaces, so it
  // is the one place that decides where each fact is stated — the strip
  // states the engine, the badge row states the model(s), and the card's
  // collapsed headline stands down for whatever they already said.
  const modelIdentity = resolveTurnModelIdentity(msg);
  const modelOptionsTitle = msg.modelOptions
    ? Object.entries(msg.modelOptions)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(' · ')
    : undefined;
  // #2211: the settled row's reasoning moves out of the bubble into the turn
  // overflow menu. The reasoning part is the turn's record of what the model
  // thought, so it stays reachable per-row; the streaming row keeps its
  // inline section (StreamingMessage's renderReasoning path).
  const reasoningPart = msg.contentParts?.find(
    (part) => part.type === 'reasoning' && typeof part.content === 'string',
  );
  const reasoningContent =
    reasoningPart?.content && reasoningPart.content.trim().length > 0
      ? reasoningPart.content
      : undefined;
  // `modelOptions` (effort, thinking, …) describe Station's REQUEST, so they
  // ride the claim that names the requested model. When the envelope observed
  // only the model the engine reported back, they ride that claim instead —
  // never silently dropped (the pre-archive#1434 badge always carried them), and
  // always prefixed so they cannot read as something the engine reported.
  const requestOptionsSlot =
    modelIdentity.source === 'envelope'
      ? (
          modelIdentity.claims.find((claim) => claim.slot !== 'reported') ??
          modelIdentity.claims[0]
        )?.slot
      : undefined;
  // If session lineage names an Agent that has since been deleted, `rowAgent`
  // preserves its durable id and an identicon seed instead of borrowing the
  // current Agent's name/icon. Only a legacy single-session transcript may
  // use the threaded session display name as its historical fallback.
  const attributionAgentName =
    msg.agentDisplayName ??
    rowAgent?.name ??
    (activeSession.conversationId === undefined
      ? activeSession.agentName
      : undefined);

  // Every copy control on a message is one icon button, named for what it
  // copies; no menu repeats it as text. On a phone it sits inline beside the
  // row's ⋯ trigger (`inlineCopy` below), so none of the desktop sites renders
  // there: one copy per row, never a second one inside the sheet.
  const copyLabel =
    msg.role === 'user'
      ? 'Copy your message'
      : isAssistant
        ? 'Copy answer'
        : 'Copy message';
  const desktopCopy =
    !isMobile && textContent ? (
      <button
        type="button"
        onClick={() => onCopy(textContent)}
        className="message__copy-btn"
        title={copyLabel}
        aria-label={copyLabel}
      >
        <CopyGlyph />
      </button>
    ) : null;
  // Only a rehydrated, durable authored input has the exact identity needed
  // for an explicit Task pin. Optimistic/content-reconciled rows deliberately
  // carry no surrogate action. On desktop it is a row of the bubble's ⋯ menu,
  // like an answer's "Add to Task"; the phone sheet lists it itself.
  const userTaskTarget =
    !replaying &&
    msg.role === 'user' &&
    msg.sourceEventId &&
    msg.sessionId &&
    msg.turnId
      ? {
          sessionId: msg.sessionId,
          eventId: msg.sourceEventId,
          excerpt: textContent,
          projectId: activeSession.projectSlug,
        }
      : undefined;
  const menuTaskTarget = isMobile ? undefined : userTaskTarget;
  // Gated on exactly what the menu can list (TurnActionsMenu's
  // UserMessageActionsMenu): a fork needs its handler, so a fork source alone
  // would draw a ⋯ that opens an empty menu.
  const userMessageMenu =
    msg.role === 'user' &&
    textContent &&
    ((userForkSource && onForkFromTurn) ||
      onNewChatFromMessage ||
      discardUnsent ||
      menuTaskTarget) ? (
      <LazyBoundary
        load={loadUserMessageActionsMenu}
        componentProps={{
          forkSource: userForkSource,
          onForkFromTurn,
          onNewChatFromMessage: onNewChatFromMessage
            ? () => onNewChatFromMessage(textContent)
            : undefined,
          onDiscardUnsent: discardUnsent,
          taskTarget: menuTaskTarget,
          // The phone already opens a sheet for the row: its actions are
          // listed there, not behind a second ⋯ inside it.
          inline: isMobile,
        }}
        pending={null}
        // In the phone sheet a failed load must not leave an empty sheet
        // behind its ⋯; the desktop corner simply omits the menu.
        unavailable={(retry) =>
          isMobile ? (
            <span className="task-picker__status" role="alert">
              Message actions unavailable.{' '}
              <button type="button" onClick={retry}>
                Retry
              </button>
            </span>
          ) : null
        }
      />
    ) : null;
  const traceLink =
    developerToolsEnabled && msg.traceId && !hasTurnFooter ? (
      <a
        href={`/developer/telemetry?filters=${encodeURIComponent(JSON.stringify({ trace: [msg.traceId] }))}`}
        target="_blank"
        rel="noopener noreferrer"
        className="message__trace"
        title={`Trace: ${msg.traceId}`}
      >
        {msg.traceId.slice(-8)}
      </a>
    ) : null;
  // The phone sheet's Task row (desktop lists it in the ⋯ menu instead).
  const userTaskAction =
    isMobile && userTaskTarget ? (
      <div className="message__task-input-action">
        <LazyBoundary
          load={loadConnectedAttachUserInputToTaskButton}
          componentProps={userTaskTarget}
          pending={
            <span
              className="task-picker__status"
              role="status"
              aria-busy="true"
              aria-label="Task action pending"
            >
              <Skeleton variant="line" />
            </span>
          }
          unavailable={(retry) => (
            <span className="task-picker__status" role="alert">
              Task action unavailable.{' '}
              <button type="button" onClick={retry}>
                Retry
              </button>
            </span>
          )}
        />
      </div>
    ) : null;
  const metadataControls = (
    <>
      {traceLink}

      {/* Desktop: the user's bubble carries the same copy icon as an
          answer, sharing its corner with the overflow menu. */}
      {msg.role === 'user' && desktopCopy ? (
        <div className="message__user-actions">
          {desktopCopy}
          {userMessageMenu}
        </div>
      ) : (
        userMessageMenu
      )}
      {msg.role === 'assistant' && !hasTurnFooter && desktopCopy}

      {msg.role === 'assistant' &&
        textContent &&
        !hasTurnFooter &&
        feedbackConversationId &&
        rowAgentSlug && (
          <MessageRating
            conversationId={feedbackConversationId}
            messageIndex={idx}
            messagePreview={textContent.slice(0, 200)}
            agentSlug={rowAgentSlug}
          />
        )}
    </>
  );
  // The row's identity facts. The phone sheet states them first, above its
  // actions; the desktop bubble keeps its original order (controls, then
  // identity) so nothing there moves.
  const metadataIdentity = (
    <>
      {isAssistant && (
        <MessageAttribution
          agent={attributionAgentName ? { name: attributionAgentName } : null}
          engine={engine}
          owner={owner}
        />
      )}

      {/* No readable envelope (an earlier message, a flag-off session, a
            payload this build cannot decode): the pre-station#1434 badge,
            unchanged — the row keeps stating the one model fact it holds. */}
      {isAssistant &&
        modelIdentity.source === 'metadata-absent' &&
        msg.model && (
          <div className="message__model-badge" title={modelOptionsTitle}>
            {/* #1536 B5: the shared identity rule. This used to be a
                hardcoded table that answered "Custom" for every model newer
                than Claude 3, so a row running claude-opus-5 with no
                provenance envelope named it "Custom". */}
            {modelIdentityLabel(msg.model)}
          </div>
        )}

      {/* archive#1434: with an envelope on the row, model identity comes
            from it and only from it, and each slot it observed is named. */}
      {isAssistant &&
        modelIdentity.source === 'envelope' &&
        modelIdentity.claims.length > 0 && (
          <div className="message__model-claims">
            {modelIdentity.claims.map((claim) => (
              <span
                key={claim.slot}
                className="message__model-claim"
                title={
                  modelOptionsTitle && claim.slot === requestOptionsSlot
                    ? `${claim.description} · Station requested: ${modelOptionsTitle}`
                    : claim.description
                }
              >
                {/* The space is a real text node, not CSS spacing: a
                      screen reader and a copy-paste both read the DOM text,
                      and "Requestedsonnet-latest" is not what a person sees. */}
                <span className="message__model-claim-label">
                  {claim.label}
                </span>{' '}
                {claim.value}
              </span>
            ))}
          </div>
        )}
    </>
  );
  // #1536 B3: the same precondition the Basis route applies. A turn whose
  // envelope records an aborted outcome can only ever be answered 404, so it
  // gets no Basis entry; nor does the still-streaming last answer.
  // Every answer's chip reads "Basis"; its accessible name says WHICH answer,
  // by the answer's opening words (or, wordless, its settle time), so a
  // screen reader's list of buttons is not a column of identical "Basis".
  const basisLabels = answerBasisLabels(textContent, settledAt);
  const basisChip =
    isAssistant &&
    msg.turnId &&
    answerSessionId &&
    msg.answerEligible === true &&
    turnCompletedNormally(msg) &&
    (!isLastMessage || !activeSession.isThinking) ? (
      <LazyBoundary
        load={loadConnectedAnswerBasisAffordance}
        componentProps={{
          projectSlug: activeSession.projectSlug,
          chatStoreId: activeSession.id,
          sessionId: answerSessionId,
          turnId: msg.turnId,
          answerName: basisLabels.answer,
        }}
        pending={null}
        shareAcrossMounts
        // A chunk that failed to load leaves a visible, retryable chip
        // rather than an answer that silently lost its Basis entry.
        unavailable={(retry) => (
          <button
            type="button"
            className="answer-basis-chip answer-basis-chip--unavailable"
            // Visible text first, then which answer (as the chip itself).
            aria-label={basisLabels.retry}
            onClick={retry}
          >
            Basis didn’t load · Retry
          </button>
        )}
      />
    ) : null;
  // A settled answer's per-turn actions: the desktop footer row, or the phone
  // sheet's action group.
  const footerActions = (
    <>
      {developerToolsEnabled && msg.traceId && (
        <a
          href={`/developer/telemetry?filters=${encodeURIComponent(JSON.stringify({ trace: [msg.traceId] }))}`}
          target="_blank"
          rel="noopener noreferrer"
          className="message__trace"
          title={`Trace: ${msg.traceId}`}
        >
          {msg.traceId.slice(-8)}
        </a>
      )}
      {desktopCopy}
      {((msg.turnId &&
        answerSessionId &&
        msg.answerEligible === true &&
        (!isLastMessage || !activeSession.isThinking)) ||
        (turnForkSource && onForkFromTurn) ||
        msg.provenance !== undefined ||
        reasoningContent !== undefined) && (
        <LazyBoundary
          load={loadTurnActionsMenu}
          componentProps={{
            taskTarget:
              msg.turnId &&
              answerSessionId &&
              msg.answerEligible === true &&
              (!isLastMessage || !activeSession.isThinking)
                ? {
                    sessionId: answerSessionId,
                    turnId: msg.turnId,
                    excerpt: textContent,
                    projectId: activeSession.projectSlug,
                  }
                : undefined,
            forkSource: turnForkSource,
            onForkFromTurn,
            provenance:
              msg.provenance !== undefined
                ? {
                    envelope: msg.provenance,
                    statedInRow: {
                      engine: engine !== null,
                      model:
                        modelIdentity.source === 'envelope' &&
                        modelIdentity.claims.length > 0,
                    },
                    accountableHuman,
                    shareContent: (
                      <LazyBoundary
                        load={loadShareAnswerButton}
                        componentProps={{ provenance: msg.provenance }}
                        pending={null}
                      />
                    ),
                  }
                : undefined,
            reasoning:
              reasoningContent !== undefined
                ? { content: reasoningContent }
                : undefined,
          }}
          pending={null}
          unavailable={() => null}
        />
      )}
      {textContent && feedbackConversationId && rowAgentSlug && (
        <MessageRating
          conversationId={feedbackConversationId}
          messageIndex={idx}
          messagePreview={textContent.slice(0, 200)}
          agentSlug={rowAgentSlug}
        />
      )}
    </>
  );
  const metadataAfter = (
    <>
      {msg.role === 'assistant' && msg.changedFiles && (
        <details className="message__changed-files">
          <summary>
            {msg.changedFiles.status === 'available'
              ? `${msg.changedFiles.files.length} changed ${msg.changedFiles.files.length === 1 ? 'file' : 'files'}`
              : 'Changed files unavailable'}
          </summary>
          {msg.changedFiles.status === 'available' ? (
            msg.changedFiles.files.length > 0 ? (
              <ul>
                {msg.changedFiles.files.map((file) => (
                  <li
                    key={`${file.status}:${file.previousPath ?? ''}:${file.path}`}
                  >
                    <span>{file.status}</span>{' '}
                    <code>
                      {file.previousPath
                        ? `${file.previousPath} → ${file.path}`
                        : file.path}
                    </code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No files changed during this turn.</p>
            )
          ) : (
            <p>
              {msg.changedFiles.reason === 'checkpoint_failed'
                ? 'Station failed to capture a checkpoint for this turn.'
                : msg.changedFiles.reason === 'checkpoint_refused'
                  ? 'Station does not take checkpoints in this repository: its own git configuration defines a filter or diff program that Station will not run for you.'
                  : msg.changedFiles.reason === 'checkpoint_pruned'
                    ? 'This turn’s checkpoint expired and was pruned.'
                    : msg.changedFiles.reason === 'checkpoint_missing'
                      ? 'A checkpoint for this turn is missing.'
                      : msg.changedFiles.reason === 'diff_output_limit_exceeded'
                        ? 'This turn changed too many files to summarize.'
                        : msg.changedFiles.reason === 'repository_changed'
                          ? 'The turn crossed repository boundaries and cannot be compared.'
                          : 'The turn’s checkpoint pair could not be compared.'}
            </p>
          )}
          {msg.changedFiles.status === 'available' &&
            msg.turnId &&
            answerSessionId &&
            !replaying && (
              <LazyBoundary
                load={loadCheckpointRestoreButton}
                pending={null}
                componentProps={{
                  sessionId: answerSessionId,
                  turnId: msg.turnId,
                }}
              />
            )}
        </details>
      )}

      {/* archive#1410: the answer's provenance is the turn's record, now
            opened from the overflow menu (#2211) so the transcript stays
            focused on the answer. A row with no envelope claims nothing
            rather than showing an empty affordance. */}
      {/* archive#2652 redesign: one quiet footer row holds every per-turn
            meta affordance — icon-weight, muted, so the answer above stays
            the loudest thing in the column; provenance and reasoning open
            from the overflow as dialogs (#2211). */}
      {hasTurnFooter && !isMobile && (
        <div className="turn-footer">
          {/* #926 amendment (owner, 2026-10): Basis stays visible at rest,
              beside the hover-revealed row rather than inside it. */}
          <div className="turn-footer__bar">
            {basisChip}
            <div className="turn-footer__actions">{footerActions}</div>
          </div>
        </div>
      )}
    </>
  );

  // The phone sheet's content, as the one list it renders from: its summary
  // row's start (facts, or the user's Task pin) and end (actions), and what
  // follows. A user row whose lists are empty (copy moved inline) gets no ⋯
  // rather than a trigger for an empty sheet.
  const sheetStart =
    msg.role === 'user' ? [userTaskAction] : [metadataIdentity];
  const sheetEnd =
    msg.role === 'user'
      ? [traceLink, userMessageMenu]
      : [metadataControls, hasTurnFooter ? footerActions : null];
  const sheetAfter = msg.role === 'user' ? null : metadataAfter;
  // Only a user row's slots can all be empty; an answer's always carry its
  // identity and footer fragments, so it keeps its ⋯ as before.
  const sheetHasContent =
    msg.role !== 'user' ||
    [...sheetStart, ...sheetEnd, sheetAfter].some((item) => item !== null);
  const details =
    isMobile && sheetHasContent ? (
      <MessageDetails
        label={
          msg.role === 'user'
            ? 'Your message actions'
            : 'Answer details and actions'
        }
      >
        {/* Identity left, actions right, on one row when both fit; the
            actions wrap to their own row only when they do not. */}
        <div className="message-details__summary">
          <div className="message-details__lead">{renderList(sheetStart)}</div>
          <div className="message-details__actions">{renderList(sheetEnd)}</div>
        </div>
        {sheetAfter}
      </MessageDetails>
    ) : null;
  // Copy is the action a phone reaches for most, so it sits beside the ⋯
  // instead of one sheet deep, for the user's words and the answer alike.
  const inlineCopy =
    isMobile && textContent ? (
      <button
        type="button"
        className="message-details__copy"
        onClick={() => onCopy(textContent)}
        title={copyLabel}
        aria-label={copyLabel}
      >
        <CopyGlyph />
      </button>
    ) : null;
  const time =
    isMobile && Number.isFinite(settledAt)
      ? messageTime(settledAt, Date.now())
      : '';
  // An answer's copy and ⋯ share one quiet row with the turn's settle time;
  // the user's bubble keeps its controls beside it.
  const mobileDetails = isAssistant ? (
    <div className="message-meta">
      {time && envelope && (
        <time
          className="message-meta__time"
          dateTime={envelope.observedAt}
          title={absoluteTime(settledAt)}
        >
          {time}
        </time>
      )}
      {basisChip}
      {inlineCopy}
      {details}
    </div>
  ) : inlineCopy || details ? (
    <div className="message-actions">
      {inlineCopy}
      {details}
    </div>
  ) : null;
  // 44px per control plus the compact row's 8px gap.
  const userControlCount = (inlineCopy ? 1 : 0) + (details ? 1 : 0);

  return (
    <div
      className={`message-row ${msg.role === 'user' ? 'message-row--user' : ''}${isMobile ? ' message-row--compact' : ''}${
        // Phone: a thin rule opens every exchange after the first. A steer is
        // more input on the same turn, not a new exchange.
        isMobile && msg.role === 'user' && idx > 0 && !continuesTurn
          ? ' message-row--exchange-start'
          : ''
      }`}
      data-chat-message-key={anchorKey}
    >
      {!isMobile && <div className="message-row__avatar">{avatarContent}</div>}
      <div
        style={{
          position: 'relative',
          // On a phone only the user's bubble keeps a reserved column for its
          // copy and ⋯ controls; an answer spends the full width on its words
          // and carries them below it (chat.css `.message-row--compact`).
          maxWidth: isMobile
            ? msg.role === 'user' && userControlCount > 0
              ? `calc(100% - ${8 + 44 * userControlCount}px)`
              : undefined
            : '70%',
        }}
        className={`message ${msg.role}${msg.role === 'user' && msg.fromPrompt ? ' message--from-prompt' : ''}${
          // Outlined, not filled, until the agent has the message.
          undelivered
            ? ` message--undelivered message--delivery-${undelivered}`
            : ''
        }`}
      >
        {!isMobile && metadataControls}
        {!isMobile && metadataIdentity}
        <div
          data-quote-source-message={
            msg.role === 'assistant' &&
            msg.answerEligible &&
            msg.sessionId &&
            msg.turnId
              ? msg.id
              : undefined
          }
        >
          <MessageContent
            contentParts={
              taskProposal
                ? msg.contentParts?.map((part) =>
                    part.type === 'text'
                      ? {
                          ...part,
                          content: part.content?.replace(
                            /```station-task-proposal\s*\n[\s\S]*?\n```/g,
                            '',
                          ),
                        }
                      : part,
                  )
                : msg.contentParts
            }
            messageKey={anchorKey}
            textContent={
              taskProposal
                ? textContent.replace(
                    /```station-task-proposal\s*\n[\s\S]*?\n```/g,
                    '',
                  )
                : textContent
            }
            chatFontSize={chatFontSize}
            showReasoning={showReasoning}
            showToolDetails={showToolDetails}
            isStreamingMessage={isStreamingMessage}
            foldWork={foldWork}
            onToolApproval={
              onToolApproval ? handleContentToolApproval : undefined
            }
          />
          {taskProposal && msg.turnId && answerSessionId && (
            <TaskProposalCard
              proposal={taskProposal}
              sessionId={answerSessionId}
              conversationId={activeSession.conversationId}
              turnId={msg.turnId}
              projectId={activeSession.projectSlug}
            />
          )}
        </div>
        {msg.role === 'user' && msg.steerInterruptedRun && (
          <div className="message__steer-note">
            Sent by stopping the step that was running
          </div>
        )}
        {/* Delivered is passed too: a note that showed an undelivered state
            fades its glyph out rather than vanishing (it renders nothing for
            a message that was already delivered when it mounted). */}
        {msg.role === 'user' && msg.clientId && deliveryState ? (
          <MessageDeliveryNote
            chatKey={activeSession.id}
            clientTurnId={msg.clientId}
            state={deliveryState}
            text={textContent}
            notice={deliveryNotice}
          />
        ) : null}

        {!isMobile && metadataAfter}
        {msg.role === 'assistant' && isLastMessage && (
          <>
            {/* Paused on a decision is not working: the typing dots beside
                "Awaiting tool approval" told two stories at once. */}
            {activeSession.isThinking &&
              textContent &&
              !activeSession.activityShownElsewhere &&
              (activeSession.pendingApprovalCount ?? 0) === 0 && (
                <div className="message__thinking">
                  <span className="loading-dots">
                    <span style={{ animationDelay: '0s' }}>●</span>
                    <span style={{ animationDelay: '0.2s' }}>●</span>
                    <span style={{ animationDelay: '0.4s' }}>●</span>
                  </span>
                </div>
              )}
            {!activeSession.activityShownElsewhere &&
              activeSession.pendingApprovalCount !== undefined &&
              activeSession.pendingApprovalCount > 0 && (
                <div className="message__pending-approval">
                  <span>
                    <PauseGlyph />
                  </span>
                  <span>
                    Awaiting tool approval ({activeSession.pendingApprovalCount}
                    )
                  </span>
                </div>
              )}
          </>
        )}
      </div>
      {isMobile && mobileDetails}
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleComponent);
