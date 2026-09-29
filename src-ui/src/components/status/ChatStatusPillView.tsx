import { ChatStatusPill } from './ChatStatusPill';
import { type ChatStatusInput, deriveChatStatus } from './chatStatus';

/**
 * The lazily loaded half of the chat pane's status pill: derivation and
 * rendering. Kept out of the entry chunk; `useChatStatusPill` loads it.
 */
export function ChatStatusPillView({
  input,
  onRevealApproval,
  onRepair,
}: {
  input: ChatStatusInput;
  onRevealApproval: () => void;
  onRepair: () => void;
}) {
  return (
    <ChatStatusPill
      status={deriveChatStatus(input)}
      onRevealApproval={onRevealApproval}
      onRepair={onRepair}
    />
  );
}
