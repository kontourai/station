import { memo, useCallback } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ChatMessage } from '../../types';
import type { OwnerAttribution } from '../../utils/ownerAttribution';
import { FlowGateVerdictCard } from '../flow/FlowGateVerdictCard';
import { FlowRunAttachedMarker } from '../flow/FlowRunAttachedMarker';
import { AgentIcon } from '../icons/AgentIcon';
import { PauseGlyph } from '../icons/Glyph';
import { UserIcon } from '../icons/UserIcon';
import { LazyBoundary } from '../LazyBoundary';
import { Skeleton } from '../state';
import { ConversationContextBoundary } from './ConversationContextBoundary';
import { ConversationHandoffBoundary } from './ConversationHandoffBoundary';
import { type ForkTurnSource, forkTurnSource } from './fork-turn-source';
import { MessageAttribution } from './message-bubble/MessageAttribution';
import { MessageContent } from './message-bubble/MessageContent';
import { MessageRating } from './message-bubble/MessageRating';
import {
  getModelDisplayName,
  resolveTurnEngine,
  resolveTurnModelIdentity,
} from './message-bubble/utils';
import { ShareAnswerButton } from './ShareAnswerButton';
import { TurnProvenanceCard } from './TurnProvenanceCard';
import './chat.css';

// The Task picker owns SDK queries, mutations, dialog primitives, and its own
// styles. Keep that optional interaction out of the first-paint chat bundle;
// completed-answer rows load it only when they can actually render the
// affordance. This follows the existing chat lazy-boundary pattern used for
// markdown and model selection.
const loadConnectedAttachAnswerToTaskButton = () =>
  import('./AttachAnswerToTaskButton').then((module) => ({
    default: module.ConnectedAttachAnswerToTaskButton,
  }));

const loadConnectedAttachUserInputToTaskButton = () =>
  import('./AttachAnswerToTaskButton').then((module) => ({
    default: module.ConnectedAttachUserInputToTaskButton,
  }));

const loadConnectedAnswerBasisAffordance = () =>
  import('./AttachAnswerToTaskButton').then((module) => ({
    default: module.ConnectedAnswerBasisAffordance,
  }));

interface Session {
  id: string;
  agentSlug: string;
  /**
   * archive#1424 fix : the session's own threaded
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
  messages: ChatMessage[];
  isThinking?: boolean;
  pendingApprovals?: unknown[];
}

type MessageContentPart = NonNullable<ChatMessage['contentParts']>[number];

// Hoisted (archive#1424 fix N4) so `agent || FALLBACK_AGENT` doesn't
// allocate a fresh object — and therefore a fresh `<AgentIcon>` element
// identity — on every render. Only feeds the avatar glyph (which needs some
// name for its initials source); the attribution strip below never uses
// this placeholder — see the `agent={agent ?? null}` call further down.
const FALLBACK_AGENT: { name: string } = { name: 'AI' };

interface MessageBubbleProps {
  msg: ChatMessage;
  idx: number;
  activeSession: Session;
  agents: AgentData[];
  chatFontSize: number;
  showReasoning: boolean;
  showToolDetails: boolean;
  onCopy: (text: string) => void;
  onForkFromTurn?: (source: ForkTurnSource) => void;
  onToolApproval?: (
    sessionId: string,
    agentSlug: string,
    approvalId: string,
    toolName: string,
    action: 'once' | 'trust' | 'deny',
  ) => void;
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
  onToolApproval,
  anchorKey,
  owner,
  accountableHuman,
}: MessageBubbleProps) {
  const textContent = typeof msg.content === 'string' ? msg.content : '';

  // Hoisted above the flowPart early-return (hooks can't be called
  // conditionally) and stabilized so the memoized MessageContent below
  // doesn't get a fresh closure — and therefore re-renders/re-parses its
  // markdown — every time MessageBubble itself re-renders for an unrelated
  // reason (e.g. a sibling message's isThinking flag flipping).
  const handleContentToolApproval = useCallback(
    (part: MessageContentPart, action: 'once' | 'trust' | 'deny') => {
      if (!onToolApproval) return;
      const toolName = part.toolName || part.name;
      if (!part.approvalId || !toolName) {
        return;
      }
      onToolApproval(
        activeSession.id,
        activeSession.agentSlug,
        part.approvalId,
        toolName,
        action,
      );
    },
    [onToolApproval, activeSession.id, activeSession.agentSlug],
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

  const isLastMessage = idx === activeSession.messages.length - 1;
  const isStreamingMessage = isLastMessage && msg.role === 'assistant';

  const isAssistant = msg.role === 'assistant';
  const hasTurnFooter =
    msg.role === 'assistant' &&
    (msg.provenance !== undefined || msg.turnId !== undefined);
  // Historical assistant rows own their execution Session identity. In the
  // legacy one-to-one shape only, the active Session is an equivalent
  // fallback; once a conversation id is present, guessing would attach a
  // historical answer to the wrong replacement Session.
  const answerSessionId =
    msg.sessionId ??
    (activeSession.conversationId === undefined ? activeSession.id : undefined);
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
  const feedbackConversationId =
    activeSession.conversationId ?? activeSession.id;
  const registeredRowAgent = rowAgentSlug
    ? agents.find((candidate) => candidate.slug === rowAgentSlug)
    : undefined;
  const rowAgent =
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

  return (
    <div
      className={`message-row ${msg.role === 'user' ? 'message-row--user' : ''}`}
      data-chat-message-key={anchorKey}
    >
      <div className="message-row__avatar">{avatarContent}</div>
      <div
        style={{
          position: 'relative',
          maxWidth: '70%',
        }}
        className={`message ${msg.role}${msg.role === 'user' && msg.fromPrompt ? ' message--from-prompt' : ''}`}
      >
        {msg.traceId && !hasTurnFooter && (
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

        {msg.role === 'assistant' && textContent && !hasTurnFooter && (
          <button
            type="button"
            onClick={() => onCopy(textContent)}
            className="message__copy-btn"
            title="Copy message"
            aria-label="Copy message"
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        )}

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
              {getModelDisplayName(msg.model)}
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

        <MessageContent
          contentParts={msg.contentParts}
          textContent={textContent}
          chatFontSize={chatFontSize}
          showReasoning={showReasoning}
          showToolDetails={showToolDetails}
          isStreamingMessage={isStreamingMessage}
          onToolApproval={
            onToolApproval ? handleContentToolApproval : undefined
          }
        />

        {/* Only a rehydrated, durable authored input has the exact identity
            needed for an explicit Task pin. Optimistic/content-reconciled rows
            deliberately carry no surrogate action. */}
        {msg.role === 'user' &&
          msg.sourceEventId &&
          msg.sessionId &&
          msg.turnId && (
            <div className="message__task-input-action">
              <LazyBoundary
                load={loadConnectedAttachUserInputToTaskButton}
                componentProps={{
                  sessionId: msg.sessionId,
                  eventId: msg.sourceEventId,
                  projectId: activeSession.projectSlug,
                }}
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
          )}

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
          </details>
        )}

        {/* archive#1410: the answer's provenance, rendered only for a turn
            Station actually observed through the canonical event store.
            A row with no envelope claims nothing rather than showing an
            empty card. */}
        {/* archive#2652 redesign: one quiet footer row holds every per-turn
            meta affordance — the provenance disclosure leads (its collapsed
            line IS the takeaway) and the share control sits beside it, both
            text-weight and muted so the answer above stays the loudest thing
            in the column. */}
        {hasTurnFooter && (
          <div className="turn-footer">
            {msg.provenance !== undefined && (
              <TurnProvenanceCard
                provenance={msg.provenance}
                statedInRow={{
                  engine: engine !== null,
                  model:
                    modelIdentity.source === 'envelope' &&
                    modelIdentity.claims.length > 0,
                }}
                accountableHuman={accountableHuman}
              />
            )}
            <div className="turn-footer__actions">
              {/* archive#1423: sharing an answer is sharing it WITH its
                  receipts. Keep it in the one action row with Task, copy, and
                  feedback controls so narrow docks wrap deliberately instead
                  of centering a single long control on a second line. */}
              {msg.provenance !== undefined && (
                <ShareAnswerButton provenance={msg.provenance} />
              )}
              {/* A finalized assistant row carries its exact turn id. Attaching
                  stores only that identity tuple; it is not gated on execution
                  provenance, and it never calls provenance semantic support. */}
              {msg.turnId &&
                answerSessionId &&
                msg.answerEligible === true &&
                (!isLastMessage || !activeSession.isThinking) && (
                  <LazyBoundary
                    load={loadConnectedAttachAnswerToTaskButton}
                    componentProps={{
                      sessionId: answerSessionId,
                      turnId: msg.turnId,
                      projectSlug: activeSession.projectSlug,
                    }}
                    pending={
                      <span
                        className="share-answer__status"
                        role="status"
                        aria-busy="true"
                        aria-label="Loading Task action"
                      >
                        <Skeleton variant="line" />
                      </span>
                    }
                    unavailable={(retry) => (
                      <span className="share-answer__status" role="alert">
                        Task action unavailable.{' '}
                        <button type="button" onClick={retry}>
                          Retry
                        </button>
                      </span>
                    )}
                  />
                )}
              {msg.turnId &&
                answerSessionId &&
                msg.answerEligible === true &&
                (!isLastMessage || !activeSession.isThinking) && (
                  <LazyBoundary
                    load={loadConnectedAnswerBasisAffordance}
                    componentProps={{
                      projectSlug: activeSession.projectSlug,
                      sessionId: answerSessionId,
                      turnId: msg.turnId,
                    }}
                    pending={
                      <span
                        className="share-answer__status"
                        role="status"
                        aria-label="Loading Basis action"
                      >
                        <Skeleton variant="line" />
                      </span>
                    }
                    unavailable={(retry) => (
                      <span className="share-answer__status" role="alert">
                        Basis action unavailable.{' '}
                        <button type="button" onClick={retry}>
                          Retry
                        </button>
                      </span>
                    )}
                  />
                )}
              {msg.traceId && (
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
              {textContent &&
                (turnForkSource && onForkFromTurn ? (
                  <button
                    type="button"
                    onClick={() => onForkFromTurn(turnForkSource)}
                    className="message__copy-btn message__fork-btn"
                    title="Fork from this completed turn"
                    aria-label="Fork from here"
                  >
                    Fork from here…
                  </button>
                ) : null)}
              {textContent && (
                <button
                  type="button"
                  onClick={() => onCopy(textContent)}
                  className="message__copy-btn"
                  title="Copy message"
                  aria-label="Copy message"
                >
                  Copy
                </button>
              )}
              {textContent && feedbackConversationId && rowAgentSlug && (
                <MessageRating
                  conversationId={feedbackConversationId}
                  messageIndex={idx}
                  messagePreview={textContent.slice(0, 200)}
                  agentSlug={rowAgentSlug}
                />
              )}
            </div>
          </div>
        )}

        {msg.role === 'assistant' && isLastMessage && (
          <>
            {activeSession.isThinking && textContent && (
              <div className="message__thinking">
                <span className="loading-dots">
                  <span style={{ animationDelay: '0s' }}>●</span>
                  <span style={{ animationDelay: '0.2s' }}>●</span>
                  <span style={{ animationDelay: '0.4s' }}>●</span>
                </span>
              </div>
            )}
            {activeSession.pendingApprovals &&
              activeSession.pendingApprovals.length > 0 && (
                <div className="message__pending-approval">
                  <span>
                    <PauseGlyph />
                  </span>
                  <span>
                    Awaiting tool approval (
                    {activeSession.pendingApprovals.length})
                  </span>
                </div>
              )}
          </>
        )}
      </div>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleComponent);
