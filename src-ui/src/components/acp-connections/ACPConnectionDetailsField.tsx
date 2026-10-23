import { useUpdateACPConnectionMutation } from '@kontourai/station-sdk';
import { useState } from 'react';
import type { ACPConnectionInfo } from '../../hooks/useACPConnections';
import type { AgentSummary } from '../../types';
import { ACPConnectionDetailModal } from './ACPConnectionDetailModal';

/**
 * A command engine's connection details (its handshake facts, its agents and
 * the tool servers passed to it), opened from the engine's own page.
 */
export function ACPConnectionDetailsField({
  connection,
  agents,
}: {
  connection: ACPConnectionInfo;
  agents: AgentSummary[];
}) {
  const [open, setOpen] = useState(false);
  const update = useUpdateACPConnectionMutation();
  return (
    <div className="editor-field">
      <span className="editor-label">Connection</span>
      <p className="editor-help">
        What {connection.name} reported when it connected, and which tool
        servers Station passes to it.
      </p>
      <button
        type="button"
        className="editor-btn"
        onClick={() => setOpen(true)}
      >
        Connection details
      </button>
      {open && (
        <ACPConnectionDetailModal
          conn={connection}
          agents={agents.filter((agent) =>
            agent.slug.startsWith(`${connection.id}-`),
          )}
          onClose={() => setOpen(false)}
          {...(connection.source !== 'plugin'
            ? {
                onUpdateToolServers: async (ids: string[]) => {
                  await update.mutateAsync({
                    id: connection.id,
                    updates: { provideToolServers: ids },
                  });
                },
                isUpdatingToolServers: update.isPending,
              }
            : {})}
        />
      )}
    </div>
  );
}
