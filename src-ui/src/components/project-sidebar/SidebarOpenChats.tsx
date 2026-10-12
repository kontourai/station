import { useEffect, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { conversationOpenPhase } from '../../contexts/conversation-open-policy';
import { useChatPaneFileDrop } from '../../hooks/useChatPaneFileDrop';
import {
  chatTaskSessionId,
  type HomeWorkItem,
} from '../../views/home/home-view-model';
import type { WorkFacts, WorkFactsById } from '../../views/home/work-facts';
import { InboxRow } from '../chat-dock/ChatDockInboxRows';
import {
  type RowProjectMarks,
  rowProjectMarks,
} from '../inbox-row/row-project-marks';
import { SkeletonBlock } from '../state';
import './SidebarOpenChats.css';

/** Rows retain the shared inbox anatomy; file intake goes to the exact live composer. */
export function SidebarOpenChats({
  items,
  now,
  workFacts,
  projectAccentBySlug,
  projectIconBySlug,
  onActivate,
}: {
  items: HomeWorkItem[];
  now: number;
  /** Status facts by item id, so a chat reads here as it does in the dock. */
  workFacts?: WorkFactsById;
  /** The sidebar's project colours (`useProjectAccents`), by slug. */
  projectAccentBySlug?: ReadonlyMap<string, string>;
  /** The projects' icons (`useProjectIcons`), by slug. */
  projectIconBySlug?: ReadonlyMap<string, string>;
  onActivate: (item: HomeWorkItem) => void;
}) {
  return (
    <>
      {items.map((item) => (
        <FileDropRow
          key={item.id}
          item={item}
          now={now}
          facts={workFacts?.get(item.id)}
          // The mark every other work row wears, by the same rule
          // (`rowProjectMarks`: a remote row takes neither).
          marks={rowProjectMarks(item, projectAccentBySlug, projectIconBySlug)}
          onActivate={onActivate}
        />
      ))}
    </>
  );
}
function FileDropRow({
  item,
  now,
  facts,
  marks,
  onActivate,
}: {
  item: HomeWorkItem;
  now: number;
  facts?: WorkFacts;
  marks: RowProjectMarks;
  onActivate: (item: HomeWorkItem) => void;
}) {
  const root = useRef<HTMLFieldSetElement>(null);
  const scope = useHostRequestAuthorityScope();
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const sessionId = chatTaskSessionId(item);
  const owner = useRef(scope);
  owner.current = scope;
  const identity = `${scope?.apiBase}:${scope?.authorityKey}:${sessionId}`;
  const previousIdentity = useRef(identity);
  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    setError(null);
    setOpening(false);
  }, [identity]);
  const drop = useChatPaneFileDrop({
    rootRef: root,
    resetKey: `${scope?.apiBase}:${scope?.authorityKey}:${sessionId}`,
    reportError: setError,
    selectFiles: async (files) => {
      setError(null);
      setOpening(true);
      try {
        const target = activeChatsStore.getSnapshot()[sessionId];
        if (!scope?.isCurrent())
          throw new Error('Reconnect to this Station before adding files.');
        const phase = target ? conversationOpenPhase(target) : undefined;
        if (!target || phase === 'read-only' || phase === 'unverified')
          throw new Error(
            'This chat is unavailable or read-only. Open a writable chat to attach files.',
          );
        const { requestConversationFileIntake } = await import(
          '../../lib/conversation-file-intake'
        );
        const result = await requestConversationFileIntake(
          scope,
          sessionId,
          files,
          () => onActivate(item),
        );
        if (scope.isCurrent() && result.errors.length)
          setError(result.errors[0]);
      } catch (cause) {
        if (owner.current === scope && scope?.isCurrent())
          setError(
            cause instanceof Error
              ? cause.message
              : 'Files could not be attached to this chat.',
          );
      } finally {
        if (owner.current === scope) setOpening(false);
      }
    },
  });
  return (
    <fieldset
      ref={root}
      className="sidebar-chat-drop"
      aria-label={`Chat ${item.title}`}
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      onDragEnd={drop.onDragEnd}
    >
      <InboxRow
        item={item}
        isCurrent={false}
        isSnoozed={false}
        isOpenChat={false}
        now={now}
        facts={facts}
        {...marks}
        onActivate={onActivate}
      />
      {drop.isDraggingFiles && (
        <span className="sidebar-chat-drop__hint" role="status">
          Add {drop.fileCount} file{drop.fileCount === 1 ? '' : 's'} to{' '}
          {item.title}
        </span>
      )}
      {opening && (
        <SkeletonBlock label="Opening the target chat for files" count={1} />
      )}
      {error && <span role="alert">{error}</span>}
    </fieldset>
  );
}
