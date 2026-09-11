import { useEffect, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { conversationOpenPhase } from '../../contexts/conversation-open-policy';
import { useChatPaneFileDrop } from '../../hooks/useChatPaneFileDrop';
import {
  chatTaskSessionId,
  type HomeWorkItem,
} from '../../views/home/home-view-model';
import { InboxRow } from '../chat-dock/ChatDockInboxRows';
import { SkeletonBlock } from '../state';
import './SidebarOpenChats.css';

/** Rows retain the shared inbox anatomy; file intake goes to the exact live composer. */
export function SidebarOpenChats({
  items,
  now,
  onActivate,
}: {
  items: HomeWorkItem[];
  now: number;
  onActivate: (item: HomeWorkItem) => void;
}) {
  return (
    <>
      {items.map((item) => (
        <FileDropRow
          key={item.id}
          item={item}
          now={now}
          onActivate={onActivate}
        />
      ))}
    </>
  );
}
function FileDropRow({
  item,
  now,
  onActivate,
}: {
  item: HomeWorkItem;
  now: number;
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
        if (!target || conversationOpenPhase(target) === 'read-only')
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
