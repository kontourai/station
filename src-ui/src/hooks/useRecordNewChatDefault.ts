import type { NewChatDefault } from '@kontourai/station-contracts/config';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  useEngineConnectionsQuery,
  useNewChatDefaultCapability,
  useRecordNewChatDefaultMutation,
} from '@kontourai/station-sdk';
import { useEffect } from 'react';
import { selectGlobalContextAgents } from '../components/agent-selection-policy';
import { firstSignedInEngine } from '../components/modals/new-chat-modal-utils';
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
 * Station has verified this engine connection's sign-in: its login
 * prerequisite (`<command>-auth`, written by the engine's sign-in check) is
 * met. A login Station cannot check is written as errored (optional or
 * required), never met, and an engine with no such row has no check at all.
 */
function engineSignInVerified(
  connection: Pick<ConnectionConfig, 'prerequisites'> | undefined,
): boolean {
  return Boolean(
    connection?.prerequisites?.some(
      (prerequisite) =>
        prerequisite.id.endsWith('-auth') &&
        prerequisite.status === 'installed',
    ),
  );
}

/**
 * Records the Station's default for new chats the first time one can be
 * chosen: the first engine in the fixed order whose sign-in Station has
 * verified (`firstSignedInEngine`), from the No project list. Station's own
 * engine and engines whose sign-in Station cannot check are never recorded.
 *
 * It waits while anything it reads is settling, and while the chosen engine is
 * not yet selectable. The server refuses a second first-signed-in record, so
 * a stale read here costs one refused request, never a changed default.
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
  // The picker's catalog drops prerequisites, which is where the sign-in
  // check lives, so read the engine connections themselves, and only while
  // no default is recorded.
  const engines = useEngineConnectionsQuery({
    enabled: stored === undefined && capability.data === true,
  });
  const record = useRecordNewChatDefaultMutation({
    onError: (error) =>
      log.api('Failed to record the default for new chats:', error),
  });
  const pick =
    stored === undefined &&
    settled &&
    capability.data === true &&
    engines.data &&
    !engines.isFetching
      ? firstSignedInEngine(selectGlobalContextAgents(agents), (agent) =>
          engineSignInVerified(
            engines.data?.find(
              (connection) =>
                connection.id === agent.execution?.agentConnectionId,
            ),
          ),
        )
      : undefined;
  const ready = pick ? canAgentStartChat(pick, agentConnections) : false;
  const { mutate } = record;
  useEffect(() => {
    if (!pick || !ready || attempted) return;
    attempted = true;
    mutate({ agent: pick.slug, reason: 'first-signed-in' });
  }, [pick, ready, mutate]);
}
