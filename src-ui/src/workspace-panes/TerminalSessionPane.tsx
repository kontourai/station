import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { useMemo } from 'react';
import { TerminalPanel } from '../components/coding-layout/TerminalPanel';
import { Empty } from '../components/state';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';
import { useProject } from '../contexts/ProjectsContext';
import { FencedRelatedPane, RelatedPaneStrip } from './RelatedPaneStrip';
import { viewerTerminalAuthority } from './relatedTerminalSessions';
import {
  readTerminalPaneState,
  type TerminalPaneState,
} from './terminalPaneOccurrence';

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
      <TerminalSessionRecord id={id} />
    </FencedRelatedPane>
  );
}

function TerminalSessionRecord({ id }: { id: string }) {
  const state = useMemo(
    () => readTerminalPaneState(window.localStorage, id),
    [id],
  );
  if (!state)
    return (
      <Empty
        variant="compact"
        label="This terminal is no longer available"
        description="Station no longer knows which session this pane showed. Close it and reopen it from where it came."
      />
    );
  return (
    <div className="related-pane">
      <RelatedPaneStrip instanceId={id} />
      <TerminalSession id={id} state={state} />
    </div>
  );
}

function TerminalSession({
  id,
  state,
}: {
  id: string;
  state: TerminalPaneState;
}) {
  const { observation } = useAuthorityPersistence();
  const { project } = useProject(state.projectSlug);
  const target = useMemo(
    () => ({ projectId: state.projectId, bindingKey: state.binding }),
    [state.binding, state.projectId],
  );
  return (
    <TerminalPanel
      projectSlug={state.projectSlug}
      workingDir={project?.workingDirectory ?? ''}
      target={target}
      terminalId={state.terminalId}
      viewKey={id}
      attachOnly
      readOnly={viewerTerminalAuthority(observation) !== 'operate'}
    />
  );
}
