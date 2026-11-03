import type { ProjectMetadata } from '@kontourai/station-contracts';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { useMemo } from 'react';
import { TerminalPanel } from '../components/coding-layout/TerminalPanel';
import { Empty } from '../components/state';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';
import { FencedRelatedPane, RelatedPaneStrip } from './RelatedPaneStrip';
import { viewerTerminalAuthority } from './relatedTerminalSessions';
import {
  readTerminalPaneState,
  type TerminalPaneState,
} from './terminalPaneOccurrence';
import { useWorkspacePaneBoundIdentity } from './useWorkspacePaneBoundIdentity';
import { WorkspacePaneBindingUnavailable } from './WorkspacePaneBindingUnavailable';

/**
 * One terminal session a plugin opened through related panes
 * (docs/design/terminal.md, "Plugins"), in a dock region. Station renders it
 * on its own socket, as the viewer: without the viewer's
 * `terminal:operate` it only watches.
 */
export function TerminalSessionPane({
  instance,
}: {
  instance: WorkspacePaneInstance;
}) {
  const id = String(instance.instanceId);
  return (
    <FencedRelatedPane instanceId={id}>
      <TerminalSessionRecord id={id} instance={instance} />
    </FencedRelatedPane>
  );
}

function TerminalSessionRecord({
  id,
  instance,
}: {
  id: string;
  instance: WorkspacePaneInstance;
}) {
  const state = useMemo(
    () => readTerminalPaneState(window.localStorage, id),
    [id],
  );
  // The pane's Project, resolved by its stable id: a deleted Project's
  // shells are never attached from a record a dock region kept.
  const identity = useWorkspacePaneBoundIdentity(instance, false);
  if (!state)
    return (
      <Empty
        variant="compact"
        label="This terminal is no longer available"
        description="Station no longer knows which session this pane showed. Close it and reopen it from where it came."
      />
    );
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (identity.project.id !== state.projectId)
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-state-mismatch' }}
      />
    );
  return (
    <div className="related-pane">
      <RelatedPaneStrip instanceId={id} />
      <TerminalSession id={id} state={state} project={identity.project} />
    </div>
  );
}

function TerminalSession({
  id,
  state,
  project,
}: {
  id: string;
  state: TerminalPaneState;
  project: ProjectMetadata;
}) {
  const { observation } = useAuthorityPersistence();
  const target = useMemo(
    () => ({ projectId: state.projectId, bindingKey: state.binding }),
    [state.binding, state.projectId],
  );
  return (
    <TerminalPanel
      projectSlug={project.slug}
      workingDir={project.workingDirectory ?? ''}
      target={target}
      terminalId={state.terminalId}
      viewKey={id}
      attachOnly
      readOnly={viewerTerminalAuthority(observation) !== 'operate'}
    />
  );
}
