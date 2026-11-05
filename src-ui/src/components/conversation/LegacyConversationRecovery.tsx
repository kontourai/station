import { useRef, useState, useSyncExternalStore } from 'react';
import { useStationConnectionsOptional } from '../../connections/StationConnectionsContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import {
  readPeerChatMessages,
  readRetainedPeerPendingText,
} from '../../lib/peer-chat';
import type { ChatSession } from '../../types';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { NewChatAction } from '../NewChatAction';
import { ErrorState } from '../state';
import './LegacyConversationRecovery.css';

/** Unattributed text stays local until the person confirms a new connection. */
export function LegacyConversationRecovery({
  chat,
  onNewChat,
}: {
  chat: Pick<
    ChatSession,
    'id' | 'input' | 'messages' | 'peerChat' | 'peerChatInvalid'
  >;
  onNewChat: () => void;
}) {
  const snapshots = useSyncExternalStore(
    activeChatsStore.subscribe,
    activeChatsStore.getSnapshot,
  );
  const stored = snapshots[chat.id];
  const current = stored ?? chat;
  const legacy = current.peerChat;
  const connections = useStationConnectionsOptional();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const messages = readPeerChatMessages(
    stored?.peerChatTranscript ?? current.messages,
  );
  const pendingText = readRetainedPeerPendingText(
    legacy ?? stored?.peerChatLegacy,
  );
  const pendingListed =
    legacy?.pending &&
    messages.some(
      (message) =>
        message.role === 'user' &&
        (message.id === legacy.pending?.id ||
          message.clientId === legacy.pending?.id),
    );
  const enabled = Boolean(connections?.remoteEnabled);
  const recover = async () => {
    if (!legacy || !connections?.remoteEnabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const lease = await connections.resolve({
        environmentId: legacy.environmentId,
        legacyPeer: true,
      });
      try {
        if (activeChatsStore.getSnapshot()[chat.id]?.peerChat !== legacy)
          throw new Error('This chat changed. Review it before reconnecting.');
        await activeChatsStore.migratePeerChat(chat.id, lease.connection, {
          confirmedRecovery: true,
        });
      } finally {
        lease.release();
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The chat could not reconnect.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <div className="legacy-conversation-recovery">
      <ErrorState
        title={
          legacy
            ? 'Reconnect this chat'
            : 'This remote chat’s saved destination could not be read'
        }
        description={
          error ??
          (legacy
            ? enabled
              ? 'Its original connection could not be identified.'
              : 'Enable Paired Station chats in Settings → Advanced → Feature previews to reconnect.'
            : undefined)
        }
        action={
          legacy ? (
            <Button
              disabled={!enabled || busy}
              onClick={() => setConfirming(true)}
            >
              Reconnect chat
            </Button>
          ) : (
            <NewChatAction onClick={onNewChat} />
          )
        }
      />
      {messages.length > 0 && (
        <ol
          aria-label="Saved conversation"
          className="legacy-conversation-recovery__messages"
        >
          {messages.map((message, index) => (
            <li key={message.id ?? `${index}:${message.role}`}>
              <strong>
                {message.role === 'user'
                  ? 'You'
                  : message.role === 'assistant'
                    ? 'Assistant'
                    : 'Notice'}
              </strong>
              <p className="legacy-conversation-recovery__text">
                {message.content}
              </p>
            </li>
          ))}
        </ol>
      )}
      {pendingText !== undefined && !pendingListed && (
        <section aria-label="Pending message">
          <p className="legacy-conversation-recovery__text">{pendingText}</p>
        </section>
      )}
      {current.input && (
        <section aria-label="Draft">
          <p className="legacy-conversation-recovery__text">{current.input}</p>
        </section>
      )}
      <Dialog
        open={confirming}
        title="Reconnect this chat?"
        closeLabel="Cancel reconnect"
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
        dismissible={!busy}
        footer={
          <>
            <Button disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !enabled}
              onClick={() => {
                void recover();
              }}
            >
              Reconnect
            </Button>
          </>
        }
      >
        <p>
          Use the current source Station to reconnect to {legacy?.stationName}.
        </p>
        <p>Any unconfirmed message will be checked before it is sent again.</p>
      </Dialog>
    </div>
  );
}
