import type {
  WorkspacePaneHostActionExecution,
  WorkspacePaneHostActionUnavailableReason,
  WorkspacePaneHostAgentRef,
  WorkspacePaneHostCompositionProjection,
} from '@kontourai/station-contracts/workspace-pane-host-contribution';
import {
  useWorkspacePaneHostActionMutation,
  useWorkspacePaneHostActionsQuery,
} from '@kontourai/station-sdk/workspace-pane';
import { type ReactNode, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { openChatsStore } from '../contexts/open-chats-store';
import { useShowSurface } from '../contexts/useShowSurface';
import './WorkspacePaneHostActions.css';

const reasons: Record<WorkspacePaneHostActionUnavailableReason, string> = {
  'authorization-changed':
    'Your connection authorization changed. Reconnect before starting this action.',
  'permission-required':
    'Review this plugin’s Agent invocation permission in Library.',
  'agent-restricted': 'This Agent is not available in this Project.',
  'agent-unavailable':
    'This Agent is not ready. Review its model or engine connection.',
  'shared-workspace-required':
    'This action needs a shared Project workspace; worktree provisioning is not supported yet.',
  'installation-changed':
    'This package or its Project changed. Refresh actions before starting new work.',
  'host-unavailable': 'Workspace actions are temporarily unavailable.',
};

function agentKey(agent: WorkspacePaneHostAgentRef) {
  return `${agent.kind}:${agent.agentId}`;
}

function PackageHostActions({
  projectSlug,
  projection,
  reason,
  displayName,
}: {
  projectSlug: string;
  projection: WorkspacePaneHostCompositionProjection;
  reason?: WorkspacePaneHostActionUnavailableReason;
  displayName?: string;
}) {
  const authority = useHostRequestAuthorityScope();
  const showSurface = useShowSurface();
  const [opening, setOpening] = useState(false);
  const declaredDefault =
    'resolution' in projection.agentSelection.defaultAgent
      ? projection.agentSelection.defaultAgent.declaration
      : undefined;
  const [selection, setSelection] = useState<string>(() =>
    declaredDefault ? agentKey(declaredDefault) : '',
  );
  const [result, setResult] = useState<WorkspacePaneHostActionExecution>();
  const [pendingKey, setPendingKey] = useState<string>();
  // React's disabled render is not synchronous with a click; this latch is.
  const busy = useRef(false);
  const mutation = useWorkspacePaneHostActionMutation(projectSlug, authority);
  const selected = projection.agentSelection.availableAgents.find(
    (entry) => agentKey(entry.declaration) === selection,
  );
  const blocked =
    result?.state === 'accepted' || result?.state === 'indeterminate';

  async function run(
    action: WorkspacePaneHostCompositionProjection['actions'][number],
  ) {
    if (busy.current || blocked || reason || !authority?.isCurrent()) return;
    busy.current = true;
    setPendingKey(action.key);
    setResult(undefined);
    try {
      const outcome = await mutation.mutateAsync({
        pluginId: projection.owner.pluginId,
        installationGeneration: projection.owner.installationGeneration,
        actionKey: action.key,
        ...(!action.agent && selected
          ? { selectedAgent: selected.declaration }
          : {}),
      });
      if (authority.isCurrent()) setResult(outcome);
    } catch {
      // Preparation performs no invocation. A transport failure during execute
      // is converted to indeterminate by the SDK and never reaches this catch.
      if (authority.isCurrent())
        setResult({ state: 'unavailable', reason: 'host-unavailable' });
    } finally {
      busy.current = false;
      setPendingKey(undefined);
    }
  }

  async function openCreatedConversation(
    created: Extract<WorkspacePaneHostActionExecution, { state: 'accepted' }>,
  ) {
    if (opening || !authority?.isCurrent()) return;
    setOpening(true);
    try {
      const opened = await openChatsStore.openConversation(
        created.conversationId,
        authority.isCurrent,
      );
      if (!opened && authority.isCurrent())
        showSurface('activity', {
          session: created.sessionId,
          focus: 'evidence',
        });
    } catch {
      if (authority.isCurrent())
        showSurface('activity', {
          session: created.sessionId,
          focus: 'evidence',
        });
    } finally {
      setOpening(false);
    }
  }

  return (
    <fieldset className="workspace-host-actions__package">
      <legend>{displayName ?? projection.owner.pluginId}</legend>
      <div className="workspace-host-actions__controls">
        <label>
          Agent
          <select
            value={selection}
            disabled={Boolean(pendingKey) || blocked}
            onChange={(event) => setSelection(event.target.value)}
          >
            <option value="">Choose an Agent</option>
            {projection.agentSelection.availableAgents.map((entry) => (
              <option
                key={agentKey(entry.declaration)}
                value={agentKey(entry.declaration)}
                disabled={entry.resolution.state !== 'available'}
              >
                {entry.declaration.agentId}
                {declaredDefault &&
                agentKey(entry.declaration) === agentKey(declaredDefault)
                  ? ' (default)'
                  : ''}
                {entry.resolution.state !== 'available'
                  ? ` — ${entry.resolution.state}`
                  : ''}
              </option>
            ))}
          </select>
        </label>
        {projection.actions.map((action) => (
          <Button
            key={action.key}
            pending={pendingKey === action.key}
            pendingLabel="Starting…"
            disabled={
              Boolean(reason) ||
              Boolean(pendingKey) ||
              blocked ||
              (action.agent
                ? action.availability !== 'available'
                : selected?.resolution.state !== 'available')
            }
            onClick={() => void run(action)}
          >
            {action.label}
            {action.agent ? ` (${action.agent.agentId})` : ''}
          </Button>
        ))}
      </div>
      {reason ? <p>{reasons[reason]}</p> : null}
      <div role="status" aria-live="polite">
        {result?.state === 'unavailable' ? (
          <p>{reasons[result.reason]}</p>
        ) : null}
        {result?.state === 'indeterminate' ? (
          <p>
            This action may have started. Check Activity before starting it
            again.
          </p>
        ) : null}
        {result?.state === 'accepted' ? (
          <>
            <Button
              pending={opening}
              pendingLabel="Opening…"
              onClick={() => void openCreatedConversation(result)}
            >
              Open conversation
            </Button>
            <Button
              onClick={() => {
                if (authority?.isCurrent())
                  showSurface('activity', {
                    session: result.sessionId,
                    focus: 'evidence',
                  });
              }}
            >
              View result
            </Button>
          </>
        ) : null}
      </div>
    </fieldset>
  );
}

/** One bar outside the pane tree: direct and placed renderers share this owner. */
export function WorkspacePaneHostActions({
  projectSlug,
}: {
  projectSlug: string;
}) {
  const authority = useHostRequestAuthorityScope();
  const query = useWorkspacePaneHostActionsQuery(projectSlug, {
    requestScope: authority,
    enabled: Boolean(authority),
  });
  if (query.isLoading) return <p role="status">Loading workspace actions…</p>;
  if (query.isError)
    return (
      <div className="workspace-host-actions" role="status">
        Workspace actions could not be loaded.{' '}
        <Button onClick={() => void query.refetch()}>Refresh actions</Button>
      </div>
    );
  if (!query.data || (!query.data.contributions.length && query.data.complete))
    return null;
  return (
    <section className="workspace-host-actions" aria-label="Workspace actions">
      {!query.data.complete ? (
        <p role="status">
          Some package declarations could not be read. Review Library before
          using legacy workspace actions.
        </p>
      ) : null}
      {query.data.contributions.map(({ projection, reason, displayName }) => (
        <PackageHostActions
          key={`${projectSlug}:${projection.owner.pluginId}:${projection.owner.installationGeneration}`}
          projectSlug={projectSlug}
          projection={projection}
          reason={reason}
          displayName={displayName}
        />
      ))}
      <Button onClick={() => void query.refetch()}>Refresh actions</Button>
    </section>
  );
}

export function WorkspacePaneHostActionsFrame({
  projectSlug,
  children,
}: {
  projectSlug: string;
  children: ReactNode;
}) {
  const authority = useHostRequestAuthorityScope();
  return (
    <div className="workspace-host-actions__frame">
      <WorkspacePaneHostActions
        key={`${projectSlug}:${authority?.apiBase}:${authority?.authorityKey}`}
        projectSlug={projectSlug}
      />
      <div className="workspace-host-actions__content">{children}</div>
    </div>
  );
}
