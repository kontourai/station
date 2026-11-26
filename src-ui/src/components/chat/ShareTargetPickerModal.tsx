import {
  type ConversationSummary,
  fetchAgentConversations,
} from '@kontourai/station-sdk';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useScopedProjectsQuery } from '../../contexts/ProjectsContext';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import type { ShareTarget } from '../../hooks/useShareToConversation';
import { dispatchNewChatIntent } from '../../lib/newChatIntent';
import type { FileAttachment } from '../../types';
import type { AttachmentInputCapabilities } from '../../utils/chatAttachments';
import { readChatAttachmentFiles } from '../../utils/chatAttachments';
import { relativeTimeFromIso } from '../../utils/relativeTime';
import { Button } from '../Button';
import { contextGlyph } from '../chat-start/ContextPickerOptions';
import { ArrowLeftGlyph, NewChatGlyph } from '../icons/Glyph';
import { LayoutIcon } from '../icons/LayoutIcon';
import {
  buildContextOptions,
  filterContextOptions,
  type NewChatModalContextOption,
} from '../modals/new-chat-modal-utils';
import { Empty, ErrorState, SkeletonList } from '../state';
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

/**
 * The New chat step's project list: the start composer's own context options
 * (No project first), read only once this step is open.
 */
function ShareTargetProjectList({
  search,
  onSelect,
}: {
  search: string;
  onSelect: (option: NewChatModalContextOption) => void;
}) {
  const projectsQuery = useScopedProjectsQuery();
  const options = useMemo(
    () =>
      filterContextOptions(
        buildContextOptions(projectsQuery.data ?? []),
        search.trim(),
      ),
    [projectsQuery.data, search],
  );
  if (projectsQuery.isError && !projectsQuery.data)
    return (
      <ErrorState
        variant="compact"
        title="Couldn’t load projects"
        action={
          <Button onClick={() => void projectsQuery.refetch()}>Retry</Button>
        }
      />
    );
  if (projectsQuery.isLoading)
    return <SkeletonList count={4} label="Loading projects" />;
  if (options.length === 0)
    return <Empty variant="compact" label="Nothing matches that search" />;
  return (
    <ul className="share-target-picker__items">
      {options.map((option) => (
        <li key={option.value}>
          <button
            type="button"
            className="share-target-picker__item"
            disabled={Boolean(option.unavailable)}
            title={option.unavailable}
            onClick={() => onSelect(option)}
          >
            <span className="share-target-picker__item-title">
              <LayoutIcon
                layout={{ name: option.label, icon: option.icon }}
                fallback={contextGlyph(option.glyph)}
                size={20}
              />
              {option.label}
            </span>
            {option.unavailable && (
              <span className="share-target-picker__item-meta">
                Can't start here
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Android-Messages-style "Share to…" picker, opened by `ShareIntakeController`
 * when images are shared into the Android app (`image-share-intake`). It lists
 * recent conversations across the available agents and, on selection, drops
 * the shared image(s) into that conversation's composer through the shared
 * `readChatAttachmentFiles` pipeline — the same MIME/size/capability
 * validation as the file picker, paste, and drag-and-drop.
 *
 * "New chat" instead asks for a project (the start composer's own context
 * options) and hands the images to the dock's New chat through
 * {@link dispatchNewChatIntent}; the chat that starts stages them under its
 * own engine, as it does for Home's start.
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
  const [mode, setMode] = useState<'conversation' | 'new-chat'>('conversation');
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

  const handleStartNewChat = (option: NewChatModalContextOption) => {
    setError(null);
    const accepted = dispatchNewChatIntent({
      initialFiles: sharedFiles,
      selection: { context: option.value },
    });
    if (!accepted) {
      setError('Open Chat, then share again to start a new chat.');
      return;
    }
    onClose();
  };

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
  const shared =
    imageCount === 1 ? 'the shared image' : `${imageCount} shared images`;
  const subtitle =
    mode === 'new-chat'
      ? `Choose a project for a new chat with ${shared}`
      : `Choose a conversation for ${shared}`;

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
            placeholder={
              mode === 'new-chat' ? 'Search projects…' : 'Search chats…'
            }
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            // biome-ignore lint/a11y/noAutofocus: search-first picker focuses its filter on open.
            autoFocus
            aria-label={
              mode === 'new-chat' ? 'Search projects' : 'Search chats'
            }
          />
          {error && (
            <div className="share-target-picker__error" role="alert">
              {error}
            </div>
          )}
          {mode === 'conversation' ? (
            <button
              type="button"
              className="share-target-picker__item share-target-picker__new-chat"
              disabled={pendingId !== null}
              onClick={() => {
                setMode('new-chat');
                setSearch('');
                setError(null);
              }}
            >
              <span className="share-target-picker__item-title">
                <NewChatGlyph />
                New chat
              </span>
              <span className="share-target-picker__item-meta">
                Start a chat in a project
              </span>
            </button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="share-target-picker__back"
              onClick={() => {
                setMode('conversation');
                setSearch('');
                setError(null);
              }}
            >
              <ArrowLeftGlyph />
              Conversations
            </Button>
          )}
          <div className="share-target-picker__list">
            {mode === 'new-chat' ? (
              <ShareTargetProjectList
                search={search}
                onSelect={handleStartNewChat}
              />
            ) : isLoading ? (
              <SkeletonList count={5} label="Loading chats" />
            ) : filtered.length === 0 ? (
              <Empty
                variant="compact"
                label={
                  conversations.length === 0
                    ? 'No chats yet'
                    : 'No matching chats'
                }
                description={
                  conversations.length === 0
                    ? 'Start a chat to share images into it.'
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
                          {relativeTimeFromIso(conversation.updatedAt)}
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
