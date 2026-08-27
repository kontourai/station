import { agentId } from '@kontourai/station-contracts/agent-identity';
import { MS_PER_DAY } from '@kontourai/station-contracts/time';
import { getAgentDisplayName } from '@kontourai/station-sdk';
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { chatDraftsStore } from '../../contexts/chat-drafts-store';
import { copyToClipboard } from '../../lib/clipboard';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { triggerHaptic } from '../../platform/native/haptics';
import type { EngineDescriptor } from '../../utils/engine';
import { EngineChip } from '../badges/EngineChip';
import { EditGlyph } from '../icons/Glyph';

interface Conversation {
  id: string;
  agentSlug: string;
  agentName?: string;
  agentType?: 'acp' | 'layout' | 'global';
  agentLabel?: string;
  agentContext?: string;
  agentIcon?: string;
  agentEngine?: EngineDescriptor | null;
  /** S1 of #1302: the project this conversation was created in/for, if any. */
  projectSlug?: string;
  title?: string;
  updatedAt: string;
  mutable?: boolean;
  metadata?: {
    titleSource?: string;
    stats?: {
      turns?: number;
      totalTokens?: number;
      contextWindowPercentage?: number;
    };
  };
  forkProvenance?: {
    forkedFrom?: ForkProvenance;
    forkedTo: ForkProvenance[];
  };
}

interface ForkProvenance {
  sourceConversationId: string;
  targetConversationId: string;
  targetAgent: string;
  forkedAt: string;
  branchPointTurnId?: string;
  sourceSessionId?: string;
  continuation?: 'native' | 'replay-seed';
}

interface SessionConversationItemProps {
  conversation: Conversation;
  projectLabel?: string;
  isActive: boolean;
  hasActiveChat: boolean;
  isRenaming: boolean;
  newTitle: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onSelect: () => void;
  onStartRename: () => void;
  onRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
  onRegenerateTitle?: () => void;
  actionError?: string;
  onOpenForkSource?: (conversationId: string) => void;
  onOpenForkConversation?: (conversationId: string) => void;
  resolveConversationTitle?: (conversationId: string) => string | undefined;
  onTitleChange: (value: string) => void;
}

// A 24-hour window makes a recent conversation easy to scan by time, while
// anything older needs a calendar date to stay unambiguous after a day away.
const RECENT_TIMESTAMP_WINDOW_MS = MS_PER_DAY;

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < RECENT_TIMESTAMP_WINDOW_MS) {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
  }).format(date);
}

function getShortId(conversationId: string): string {
  return conversationId.slice(-6);
}

export function SessionConversationItem({
  conversation: conv,
  projectLabel,
  isActive,
  hasActiveChat,
  isRenaming,
  newTitle,
  inputRef,
  onSelect,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
  onRegenerateTitle,
  actionError,
  onOpenForkSource,
  onOpenForkConversation,
  resolveConversationTitle,
  onTitleChange,
}: SessionConversationItemProps) {
  const contextPct = conv.metadata?.stats?.contextWindowPercentage;
  const forkedFrom = conv.forkProvenance?.forkedFrom;
  const forkedTo = conv.forkProvenance?.forkedTo ?? [];
  const sourceTitle = forkedFrom
    ? resolveConversationTitle?.(forkedFrom.sourceConversationId)
    : undefined;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const copyResetRef = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (copyResetRef.current !== undefined) {
        window.clearTimeout(copyResetRef.current);
      }
    },
    [],
  );
  const hasDraft = useSyncExternalStore(
    chatDraftsStore.subscribe,
    () => chatDraftsStore.hasDraft(conv.id),
    () => false,
  );
  const copyConversationId = useCallback(async () => {
    const copied = await copyToClipboard(conv.id);
    if (copied) triggerHaptic('light');
    setCopyState(copied ? 'copied' : 'failed');
    if (copyResetRef.current !== undefined) {
      window.clearTimeout(copyResetRef.current);
    }
    copyResetRef.current = window.setTimeout(() => setCopyState('idle'), 1500);
  }, [conv.id]);

  if (isRenaming) {
    return (
      <div className={`session-item ${isActive ? 'is-active' : ''}`}>
        <input
          ref={inputRef}
          type="text"
          className="session-item__rename-input"
          value={newTitle}
          onChange={(e) => onTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isComposingKeyEvent(e)) onRename();
            if (e.key === 'Escape') onCancelRename();
          }}
          onBlur={onRename}
        />
      </div>
    );
  }

  return (
    <div className={`session-item ${isActive ? 'is-active' : ''}`}>
      {/* biome-ignore lint/a11y/useSemanticElements: composite conversation row contains an independent provenance action, so it cannot be a native button. */}
      <div
        className="session-item__content"
        onClick={onSelect}
        role="button"
        aria-label={`Open conversation ${(typeof conv.title === 'string' ? conv.title : 'Untitled') || 'Untitled'}`}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      >
        <div className="session-item__title-row">
          {hasActiveChat && <span className="session-item__active-dot">●</span>}
          <span>
            {(typeof conv.title === 'string' ? conv.title : 'Untitled') ||
              'Untitled'}{' '}
            <span className="session-item__id">{getShortId(conv.id)}</span>
          </span>
        </div>
        <div className="session-item__meta">
          {/* Round-3: every resolved agent's conversation gets an engine
              chip now (not just ACP ones) — the Layout/Global badge below
              is a different axis (workspace scope, not engine identity) and
              stays alongside it unchanged. */}
          <EngineChip engine={conv.agentEngine ?? null} />
          {hasDraft && (
            <span className="session-item__badge session-item__badge--draft">
              Draft
            </span>
          )}
          {conv.agentType === 'layout' ? (
            <span className="session-item__badge session-item__badge--workspace">
              Layout
            </span>
          ) : conv.agentType === 'global' ? (
            <span className="session-item__badge session-item__badge--global">
              Global
            </span>
          ) : null}
          {conv.agentContext && <span>{conv.agentContext}</span>}
          {projectLabel && (
            <span
              className="session-item__badge session-item__badge--project"
              title={projectLabel}
            >
              {projectLabel}
            </span>
          )}
          <span>
            {conv.agentLabel ||
              conv.agentName ||
              getAgentDisplayName(agentId(conv.agentSlug))}
          </span>
          {conv.metadata?.stats?.turns && (
            <>
              <span>•</span>
              <span>{conv.metadata.stats.turns} messages</span>
            </>
          )}
        </div>
        {contextPct !== undefined && (
          <div className="session-item__context">
            <span>Context:</span>
            <div className="session-item__context-bar">
              <div
                className="session-item__context-fill"
                style={{
                  width: `${Math.min(contextPct, 100)}%`,
                  background:
                    contextPct > 80
                      ? '#ef4444'
                      : contextPct > 50
                        ? '#f59e0b'
                        : '#10b981',
                }}
              />
            </div>
            <span>{contextPct.toFixed(1)}%</span>
          </div>
        )}
        {forkedFrom && (
          <div className="session-item__provenance">
            {sourceTitle ? (
              <button
                type="button"
                className="session-item__provenance-link"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenForkSource?.(forkedFrom.sourceConversationId);
                }}
              >
                Forked from {sourceTitle}
              </button>
            ) : (
              <span>Forked from earlier conversation (unavailable)</span>
            )}
            <span>
              Agent: {forkedFrom.targetAgent} · {forkedFrom.forkedAt}
              {forkedFrom.branchPointTurnId
                ? ` · from turn ${forkedFrom.branchPointTurnId}`
                : ''}
            </span>
          </div>
        )}
        {forkedTo.length > 0 && (
          <div className="session-item__provenance">
            <span>Forked to</span>
            <ul>
              {forkedTo.map((fork) => {
                const targetTitle = resolveConversationTitle?.(
                  fork.targetConversationId,
                );
                return (
                  <li key={fork.targetConversationId}>
                    {onOpenForkConversation && targetTitle ? (
                      <button
                        type="button"
                        className="session-item__provenance-link"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenForkConversation(fork.targetConversationId);
                        }}
                      >
                        {targetTitle}
                      </button>
                    ) : (
                      (targetTitle ?? 'earlier conversation (unavailable)')
                    )}
                    {' · '}Agent: {fork.targetAgent} · {fork.forkedAt}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
      <div className="session-item__date">{formatDate(conv.updatedAt)}</div>
      {actionError && (
        <div className="session-item__action-error" role="alert">
          {actionError}
        </div>
      )}
      <div className="session-item__actions">
        <button
          type="button"
          className={`session-item__action-btn${
            copyState === 'failed' ? ' copy-affordance--failed' : ''
          }`}
          onClick={(event) => {
            event.stopPropagation();
            void copyConversationId();
          }}
          title={
            copyState === 'failed'
              ? 'This browser refused clipboard access — the thread ID was not copied.'
              : 'Copy thread ID'
          }
          aria-label="Copy thread ID"
        >
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? "Can't copy"
              : 'ID'}
        </button>
        {/* The button's own name is fixed, so its label change is never
            announced; this sibling carries the outcome. */}
        <span role="status" className="copy-status-sr">
          {copyState === 'copied'
            ? 'Thread ID copied.'
            : copyState === 'failed'
              ? 'This browser refused clipboard access. The thread ID was not copied.'
              : ''}
        </span>
        {conv.mutable !== false && (
          <>
            <button
              type="button"
              className="session-item__action-btn"
              onClick={(e) => {
                e.stopPropagation();
                onStartRename();
              }}
              title="Rename"
              aria-label="Rename conversation"
            >
              <EditGlyph />
            </button>
            {onRegenerateTitle && (
              <button
                type="button"
                className="session-item__action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onRegenerateTitle();
                }}
                title="Regenerate title"
                aria-label="Regenerate conversation title"
              >
                ↻
              </button>
            )}
            <button
              type="button"
              className="session-item__action-btn session-item__action-btn--delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              title="Delete"
            >
              ×
            </button>
          </>
        )}
      </div>
    </div>
  );
}
