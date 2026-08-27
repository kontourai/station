import {
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
} from '@kontourai/station-contracts/time';
import {
  type ConversationSummary,
  fetchAgentConversations,
} from '@kontourai/station-sdk';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import type { ShareTarget } from '../../hooks/useShareToConversation';
import type { FileAttachment } from '../../types';
import type { AttachmentInputCapabilities } from '../../utils/chatAttachments';
import { readChatAttachmentFiles } from '../../utils/chatAttachments';
import { Empty, SkeletonList } from '../state';
import './share-target-picker.css';

interface ShareTargetAgent {
  slug: string;
  name: string;
}

interface RecentConversation extends ConversationSummary {
  agentSlug: string;
  agentName: string;
}

export interface ShareTargetPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Agents whose recent conversations can receive the shared images. */
  agents: ShareTargetAgent[];
  /** Images arriving from the native share target, already materialized. */
  sharedFiles: File[];
  /** Capability envelope handed to the shared attachment pipeline. */
  attachmentCapabilities: AttachmentInputCapabilities;
  /**
   * Open the chosen conversation and seed the shared images into its composer.
   * Wired to {@link useShareToConversation} by the controller.
   */
  onShareToConversation: (
    target: ShareTarget,
    attachments: FileAttachment[],
  ) => void | Promise<void>;
}

function formatRelativeTime(dateStr: string): string {
  const then = new Date(dateStr).getTime();
  if (!Number.isFinite(then)) return '';
  const diffMs = Date.now() - then;
  const diffMins = Math.floor(diffMs / MS_PER_MINUTE);
  const diffHours = Math.floor(diffMs / MS_PER_HOUR);
  const diffDays = Math.floor(diffMs / MS_PER_DAY);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(then).toLocaleDateString();
}

/**
 * Android-Messages-style "Share to…" picker. Lists recent conversations across
 * the available agents and, on selection, drops the shared image(s) into that
 * conversation's composer through the shared `readChatAttachmentFiles`
 * pipeline — the same MIME/size/capability validation as the file picker,
 * paste, and drag-and-drop.
 *
 * The picker is inert in production: it is only ever opened by the
 * `share-intake`-gated intake entry point, which stays disabled until a
 * reviewed native receiver ships.
 */
export function ShareTargetPickerModal({
  isOpen,
  onClose,
  agents,
  sharedFiles,
  attachmentCapabilities,
  onShareToConversation,
}: ShareTargetPickerModalProps) {
  const visualViewport = useMobileVisualViewport();
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes the dialog. Without it the only dismissal paths were a
  // pointer click on the backdrop and the Close button, so a keyboard user had
  // no equivalent to the click-outside affordance.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const conversationQueries = useQueries({
    queries: agents.map((agent) => ({
      queryKey: ['conversations', agent.slug],
      queryFn: () => fetchAgentConversations(agent.slug),
      enabled: isOpen,
      staleTime: 0,
    })),
  });

  const isLoading = conversationQueries.some((query) => query.isLoading);

  const conversations = useMemo<RecentConversation[]>(() => {
    const rows: RecentConversation[] = [];
    conversationQueries.forEach((query, index) => {
      const agent = agents[index];
      if (!agent || !query.data) return;
      for (const conversation of query.data) {
        rows.push({
          ...conversation,
          agentSlug: agent.slug,
          agentName: agent.name,
        });
      }
    });
    return rows.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, [conversationQueries, agents]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter((conversation) =>
      (conversation.title ?? 'Untitled conversation')
        .toLowerCase()
        .includes(term),
    );
  }, [conversations, search]);

  if (!isOpen) return null;

  const handleSelect = async (conversation: RecentConversation) => {
    if (pendingId) return;
    setError(null);
    setPendingId(conversation.id);
    try {
      const { attachments, errors } = await readChatAttachmentFiles(
        sharedFiles,
        [],
        attachmentCapabilities,
      );
      if (attachments.length === 0) {
        setError(errors[0] ?? 'The shared image could not be attached.');
        setPendingId(null);
        return;
      }
      await onShareToConversation(
        {
          conversationId: conversation.id,
          agentSlug: conversation.agentSlug,
          agentName: conversation.agentName,
        },
        attachments,
      );
      onClose();
    } catch {
      setError('The shared image could not be attached.');
      setPendingId(null);
    }
  };

  const imageCount = sharedFiles.length;
  const subtitle =
    imageCount === 1
      ? 'Choose a conversation for the shared image'
      : `Choose a conversation for ${imageCount} shared images`;

  return (
    // `presentation` on the backdrop: it is a click-catcher, not a control.
    // The dismissal affordances a keyboard user needs are Escape (below) and
    // the Close button inside the dialog, so the backdrop carries no semantics
    // of its own.
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-dismiss backdrop, not a control — Escape and the Close button are the keyboard paths
    <div
      className="modal-overlay responsive-surface-overlay"
      style={visualViewport.style}
      onClick={onClose}
      role="presentation"
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: propagation guard so a click inside the dialog does not reach the backdrop; not an action, so there is no keyboard equivalent */}
      <div
        className="modal-dialog responsive-surface-panel share-target-picker"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-target-picker-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="share-target-picker-title">Share to…</h3>
          <p className="share-target-picker__subtitle">{subtitle}</p>
        </div>
        <div className="modal-body share-target-picker__body">
          <input
            type="search"
            className="share-target-picker__search"
            placeholder="Search conversations…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            // biome-ignore lint/a11y/noAutofocus: search-first picker focuses its filter on open.
            autoFocus
            aria-label="Search conversations"
          />
          {error && (
            <div className="share-target-picker__error" role="alert">
              {error}
            </div>
          )}
          <div className="share-target-picker__list">
            {isLoading ? (
              <SkeletonList count={5} label="Loading conversations" />
            ) : filtered.length === 0 ? (
              <Empty
                variant="compact"
                label={
                  conversations.length === 0
                    ? 'No conversations yet'
                    : 'No matching conversations'
                }
                description={
                  conversations.length === 0
                    ? 'Start a conversation to share images into it.'
                    : undefined
                }
              />
            ) : (
              <ul className="share-target-picker__items">
                {filtered.map((conversation) => (
                  <li key={`${conversation.agentSlug}:${conversation.id}`}>
                    <button
                      type="button"
                      className="share-target-picker__item"
                      disabled={pendingId !== null}
                      aria-busy={pendingId === conversation.id}
                      onClick={() => void handleSelect(conversation)}
                    >
                      <span className="share-target-picker__item-title">
                        {conversation.title || 'Untitled conversation'}
                      </span>
                      <span className="share-target-picker__item-meta">
                        <span>{conversation.agentName}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {formatRelativeTime(conversation.updatedAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ShareTargetPickerModal;
