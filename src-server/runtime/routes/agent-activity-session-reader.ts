/**
 * How the agent-activity publisher reads sessions for one registered phone:
 * with the read authority a request carrying that paired device's own
 * credential resolves to (`pairedDevicePrincipal`), minted the way the
 * session-list route mints it (`sessionReadAuthorityFromRequest`) — never a
 * process-wide view, and never the OS alias, which owns no current session.
 *
 * Only a device that could make that request gets a reader: an active
 * person's device (not a delegation grant) whose scope includes
 * `orchestration:read` — the tier the session-list route requires — and
 * that is not bound to a deployment account (those requests resolve to the
 * account principal, which a background reader cannot present). Anything
 * else reads nothing.
 */
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { canReadAgentActivity } from '../../services/notifications/agent-activity-eligibility.js';
import {
  type AgentActivitySessionReader,
  agentActivityRowFromSummary,
  agentActivityRowsWithEntries,
} from '../../services/notifications/agent-activity-publisher.js';
import { pairedDevicePrincipal } from '../bootstrap/orchestration-request-principal.js';

export interface AgentActivitySessionReaderDeps {
  listDevices(): PairedDevice[];
  listSessionReadModel(
    authority: SessionReadAuthority,
  ): Promise<OrchestrationSessionSummary[]>;
  /** The lifecycle projection events the read model folds, per thread. */
  listProjectionEvents?(
    threadIds: readonly string[],
  ): Map<string, CanonicalRuntimeEvent[]>;
  projectNames(): Map<string, string>;
}

export function createAgentActivitySessionReader(
  deps: AgentActivitySessionReaderDeps,
): (deviceId: string) => AgentActivitySessionReader | null {
  return (deviceId) => {
    const device = deps
      .listDevices()
      .find((candidate) => candidate.id === deviceId);
    if (!device || !canReadAgentActivity(device)) return null;
    const principal = pairedDevicePrincipal(device);
    return {
      principalId: principal.id,
      listSessions: async () => {
        // Personal mode only: the publisher is disabled in hosted mode, so
        // no tenant context exists to carry.
        const sessions = await deps.listSessionReadModel(
          sessionReadAuthorityFromRequest(principal.id, undefined, undefined),
        );
        const projects = deps.projectNames();
        return agentActivityRowsWithEntries(
          sessions.map((session) =>
            agentActivityRowFromSummary(session, (slug) => projects.get(slug)),
          ),
          (threadIds) => deps.listProjectionEvents?.(threadIds) ?? new Map(),
        );
      },
    };
  };
}
