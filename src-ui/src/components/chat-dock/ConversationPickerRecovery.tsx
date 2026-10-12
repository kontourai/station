import { LazyBoundary } from '../LazyBoundary';
import type { ConversationOpenRecovery } from './conversationOpenController';

const loadConversationOpenRecoveryNotice = () =>
  import('./ConversationOpenRecoveryNotice').then((module) => ({
    default: module.ConversationOpenRecoveryNotice,
  }));

/**
 * The recovery notice for a conversation opened from the picker that could
 * not be opened writable. Takes the whole recovery so the caller cannot drop
 * the server's per-caller answer on the way: "Start new chat" is withheld
 * when the open read said this caller may not start a chat
 * (`callerAccess.startChat === false`), and shown when it said nothing,
 * because the server still enforces.
 */
export function ConversationPickerRecovery({
  recovery,
  onRetry,
  onStartNew,
}: {
  recovery: ConversationOpenRecovery;
  onRetry: () => void;
  onStartNew: () => void;
}) {
  return (
    <LazyBoundary
      load={loadConversationOpenRecoveryNotice}
      componentProps={{
        title: recovery.conversation.title,
        // #2424: passed through unmapped; the notice decides which statuses
        // are verdicts.
        state: recovery.status,
        onRetry,
        onStartNew:
          recovery.callerAccess?.startChat === false ? undefined : onStartNew,
      }}
      pending={
        <div className="session-history-error" role="status">
          Conversation recovery is loading. Sending is paused.
        </div>
      }
    />
  );
}
