import { useEffect } from 'react';
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
  onResync,
  onRecoveryFocus,
  onMounted,
}: {
  input: ChatStatusInput;
  onRevealApproval: () => void;
  onRepair: () => void;
  /** Re-reads the conversation; absent leaves an unobservable pill inert. */
  onResync?: () => void;
  /** Focus the recovered composer without changing its write permission. */
  onRecoveryFocus?: () => boolean;
  /** The pill is on screen: its host may hand it the chat's status. */
  onMounted: () => void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: reports the mount once.
  useEffect(onMounted, []);
  return (
    <ChatStatusPill
      status={deriveChatStatus(input)}
      onRevealApproval={onRevealApproval}
      onRepair={onRepair}
      onResync={onResync}
      onRecoveryFocus={onRecoveryFocus}
    />
  );
}
