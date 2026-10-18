import type { ToolAccessRequest } from '@kontourai/station-contracts/tool-library';
import {
  useOwnToolAccess,
  useToolLibraryChange,
  useToolRequests,
} from '@kontourai/station-sdk/tool-library';
import { lazy, Suspense, useState } from 'react';
import { AgentToolConnection } from '../../views/agent-editor/AgentToolDiscovery';
import { useToolLibraryClient } from '../../views/agent-editor/ToolLibraryContext';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { PageHeaderScope } from '../page-frame';
import { SkeletonList } from '../state';
import './ToolRequestsPanel.css';

const Registry = lazy(() =>
  import('../../views/RegistryView').then((module) => ({
    default: module.RegistryView,
  })),
);
export function ToolRequestsPanel({ requestId }: { requestId?: string }) {
  const client = useToolLibraryClient();
  const access = useOwnToolAccess(client);
  const requests = useToolRequests(
    client,
    undefined,
    access.data?.station.operator === true,
  );
  const change = useToolLibraryChange(client);
  const [plugin, setPlugin] = useState<ToolAccessRequest>();
  const [connection, setConnection] = useState<ToolAccessRequest>();
  const [dirty, setDirty] = useState(false);
  if (access.data?.station.operator !== true) return null;
  const pending =
    requests.data?.filter(
      (request) =>
        ['pending', 'setting-up', 'failed'].includes(request.status) &&
        (!requestId || request.id === requestId),
    ) ?? [];
  async function act(request: ToolAccessRequest, action: string) {
    if (!access.data) return;
    const result = await change.mutateAsync({
      path: `/requests/${encodeURIComponent(request.id)}/${action}`,
      body: { expectedActor: access.data.principalId },
    });
    const complete =
      result &&
      typeof result === 'object' &&
      'status' in result &&
      result.status === 'available';
    if (action !== 'decline' && !complete) {
      if (request.sourceKind === 'plugin') setPlugin(request);
      else setConnection(request);
    }
  }
  return (
    <section aria-label="Tool requests" className="tool-requests-panel">
      {requests.isError && <p role="alert">Tool requests unavailable.</p>}
      {!requestId && pending.length > 0 && <h2>Tool requests</h2>}
      {pending.map((request) => (
        <div className="tool-requests-panel__request" key={request.id}>
          {!requestId && (
            <>
              <strong>{request.sourceName}</strong>
              <small>
                {request.requesterName} · {request.projectName}
              </small>
            </>
          )}
          <div className="tool-requests-panel__actions">
            <Button
              variant="primary"
              pending={change.isPending}
              onClick={() =>
                void act(
                  request,
                  request.status === 'setting-up' ? 'complete' : 'approve',
                ).catch(() => {})
              }
            >
              {request.status === 'setting-up' ? 'Finish setup' : 'Approve'}
            </Button>
            <Button
              variant="ghost"
              disabled={change.isPending}
              onClick={() => void act(request, 'decline').catch(() => {})}
            >
              Decline
            </Button>
          </div>
          {request.error && <p role="status">{request.error}</p>}
        </div>
      ))}
      {change.isError && <p role="alert">{change.error.message}</p>}
      {connection && (
        <Dialog
          title={`Set up ${connection.sourceName}`}
          closeLabel="Close tool setup"
          dismissible={!dirty}
          onClose={() => {
            if (!dirty) setConnection(undefined);
          }}
          size="lg"
        >
          <AgentToolConnection
            id={connection.sourceId}
            onDirtyChange={setDirty}
            onBack={() => {
              setConnection(undefined);
              void act(connection, 'complete').catch(() => {});
            }}
          />
        </Dialog>
      )}
      {plugin && (
        <Dialog
          title={`Add ${plugin.sourceName}`}
          closeLabel="Close tool setup"
          onClose={() => setPlugin(undefined)}
          size="lg"
        >
          <PageHeaderScope>
            <Suspense fallback={<SkeletonList count={2} />}>
              <Registry
                initialTab="plugins"
                toolPicker
                installTarget={plugin.sourceId}
                onInstalled={() => {
                  void act(plugin, 'complete').finally(() =>
                    setPlugin(undefined),
                  );
                }}
              />
            </Suspense>
          </PageHeaderScope>
        </Dialog>
      )}
    </section>
  );
}
