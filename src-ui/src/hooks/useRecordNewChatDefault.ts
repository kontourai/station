import type { NewChatDefault } from '@kontourai/station-contracts/config';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  useNewChatDefaultCapability,
  useRecordNewChatDefaultMutation,
} from '@kontourai/station-sdk';
import { useEffect } from 'react';
import { selectGlobalContextAgents } from '../components/agent-selection-policy';
import { firstSignedInAgent } from '../components/modals/new-chat-modal-utils';
import type { AgentData } from '../contexts/AgentsContext';
import { canAgentStartChat } from '../utils/execution';
import { log } from '../utils/logger';

/**
 * One attempt per page load: every mounted composer runs this hook, and a
 * first-signed-in record is the server's to keep once written.
 */
let attempted = false;

/** Test seam: a fresh page load. */
export function resetRecordNewChatDefaultForTests() {
  attempted = false;
}

/**
 * Records the Station's default for new chats the first time one can be
 * chosen: the first engine that can run a chat, in fixed order
 * (`firstSignedInAgent`), from the No project list.
 *
 * It waits while anything it reads is settling, and while the engine first
 * in line is not yet selectable, so a connection that turns ready a moment
 * after the catalog cannot hand the record to the next engine. The server
 * refuses a second first-signed-in record, so a stale read here costs one
 * refused request, never a changed default.
 */
export function useRecordNewChatDefault({
  stored,
  agents,
  agentConnections,
  settled,
}: {
  /** `AppConfig.newChatDefault`; `null` while config has not been read. */
  stored: NewChatDefault | undefined | null;
  agents: AgentData[];
  agentConnections: ConnectionConfig[];
  /** The Agent and connection reads have both answered and are not refetching. */
  settled: boolean;
}) {
  const capability = useNewChatDefaultCapability(stored === undefined);
  const record = useRecordNewChatDefaultMutation({
    onError: (error) =>
      log.api('Failed to record the default for new chats:', error),
  });
  const pick =
    stored === undefined && settled && capability.data === true
      ? firstSignedInAgent(selectGlobalContextAgents(agents))
      : undefined;
  const ready = pick ? canAgentStartChat(pick, agentConnections) : false;
  const { mutate } = record;
  useEffect(() => {
    if (!pick || !ready || attempted) return;
    attempted = true;
    mutate({ agent: pick.slug, reason: 'first-signed-in' });
  }, [pick, ready, mutate]);
}
