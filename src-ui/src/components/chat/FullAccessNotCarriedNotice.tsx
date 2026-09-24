import { activeChatsStore } from '../../contexts/active-chats-store';
import { EphemeralMessage } from './EphemeralMessage';

/**
 * #2423: full access is deliberately not carried into a new Session (#2449,
 * `approvalModeToSend`). When the chat KNOWS that just happened
 * (`settleApprovalPick`, utils/approvalMode.ts), it says so for that Session
 * only. Informational: re-granting inside this Session cannot work on Claude
 * (it refuses a mid-session escalation to full access, claude-adapter.ts),
 * so the copy names the path that does — a new chat whose first send carries
 * Never ask, which spawns the engine with full access.
 *
 * Rendered from the lazily loaded ChatMessageList, beside the pending
 * approvals strip, and self-contained: the entry bundle has no headroom.
 */
export default function FullAccessNotCarriedNotice({
  session,
  fontSize,
}: {
  session: {
    id: string;
    currentSessionId?: string;
    fullAccessNotCarriedSessionId?: string;
  };
  fontSize: number;
}) {
  // Both must be a real Session id: a chat with no current Session (a fresh
  // chat, or one being reopened) has both undefined, which is not a match.
  if (
    !session.fullAccessNotCarriedSessionId ||
    session.fullAccessNotCarriedSessionId !== session.currentSessionId
  )
    return null;
  return (
    <EphemeralMessage
      idx={0}
      fontSize={fontSize}
      isRemoving={false}
      msg={{
        id: 'full-access-not-carried',
        content:
          "Full access didn't carry over to this new session. It's running with a stricter approval setting. To work with full access again, start a new chat and choose Never ask before your first message.",
      }}
      onDismiss={() =>
        activeChatsStore.updateChat(session.id, {
          fullAccessNotCarriedSessionId: undefined,
        })
      }
    />
  );
}
