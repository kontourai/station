import {
  childWorkKey,
  childWorkKindOf,
} from '@kontourai/station-contracts/child-work';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { stationPartitionKey } from '../../connections/station-state';
import { childWorkGlobalStore } from '../../contexts/child-work-global-store';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { ChatStatusPill } from './ChatStatusPill';
import { type ChatStatusInput, deriveChatStatus } from './chatStatus';
import { ScheduledCheckBackContext } from './ScheduledCheckBackContext';

/**
 * The lazily loaded half of the chat pane's status pill: derivation and
 * rendering. Kept out of the entry chunk; `useChatStatusPill` loads it.
 */
export function ChatStatusPillView({
  input,
  sessionSummary,
  onRevealApproval,
  onRepair,
  onResync,
  onRecoveryFocus,
  onMounted,
}: {
  input: ChatStatusInput;
  sessionSummary?: OrchestrationSessionSummary | null;
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
  const checkBack = useContext(ScheduledCheckBackContext);
  const connection = useOptionalConversationConnection();
  const partition = stationPartitionKey(
    connection?.station ?? connection?.apiBase,
  );
  const observation = useSyncExternalStore(childWorkGlobalStore.subscribe, () =>
    childWorkGlobalStore.getPartition(partition),
  );
  const agents = useMemo(() => {
    if (!sessionSummary || !connection || connection.record) return [];
    const report = sessionSummary.childWork?.children;
    const items = new Map(
      (report?.observability === 'reported'
        ? [...report.running, ...(report.settled ?? [])]
        : []
      ).map((item) => [childWorkKey(item), item]),
    );
    for (const item of Object.values(observation.registry.items)) {
      if (item.reporterThreadId !== sessionSummary.threadId) continue;
      const key = childWorkKey(item);
      const prior = items.get(key);
      if (!prior || prior.status === 'running' || item.status !== 'running')
        items.set(key, item);
    }
    return [...items.values()].filter(
      (item) =>
        item.reporterThreadId === sessionSummary.threadId &&
        item.status === 'running' &&
        childWorkKindOf(item) === 'agent',
    );
  }, [connection, observation, sessionSummary]);
  const status = deriveChatStatus(
    agents?.length && !input.backgroundWork
      ? {
          ...input,
          backgroundWork: {
            agent: agents.length,
            command: 0,
            monitor: 0,
            tool: 0,
          },
        }
      : input,
  );
  const combine = !!checkBack && (!status || status.kind === 'working');
  return (
    <>
      {checkBack && !combine && checkBack.notes}
      <ChatStatusPill
        status={
          status ??
          (checkBack
            ? {
                kind: 'waiting',
                label: 'Waiting',
                tone: 'neutral',
                glyph: 'idle',
                details: [],
                action: 'details',
              }
            : undefined)
        }
        checkBack={combine ? checkBack : undefined}
        runningChildren={agents}
        onRevealApproval={onRevealApproval}
        onRepair={onRepair}
        onResync={onResync}
        onRecoveryFocus={onRecoveryFocus}
      />
    </>
  );
}
