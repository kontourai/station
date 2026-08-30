import {
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
  workspacePaneModesSatisfiableBy,
} from '@kontourai/station-contracts/workspace-pane';
import { Button } from '../components/Button';
import { useWorkspacePaneDockAction } from './WorkspacePaneDockContext';

/** One keyboard-reachable action; the ambient host owns its persistence. */
export function WorkspacePaneDockAction({
  descriptor,
  instance,
}: {
  descriptor: WorkspacePaneDescriptor;
  instance: WorkspacePaneInstance;
}) {
  const dock = useWorkspacePaneDockAction();
  // Existing surface-side placement control is intentionally unchanged in
  // step 1; shell chrome takes it over later. // #928 step 2
  // A synchronous host replacement has no waiting phase. More importantly,
  // a renderer outside the ambient host must not offer an action that has no
  // persistence owner to answer it.
  if (
    !dock ||
    workspacePaneModesSatisfiableBy(descriptor, dock.suppliable).length === 0
  )
    return null;
  return (
    <Button
      type="button"
      size="sm"
      // station#520: this button is rendered BY the pane it docks, so every
      // click is "dock what the main viewport currently, entirely shows" —
      // the exact case `dockPaneAsOnlyContent`'s mobile-maximize contract
      // covers. See its doc on `WorkspacePaneDockAction` (the interface).
      onClick={() => dock.dockPaneAsOnlyContent(descriptor, instance)}
    >
      Dock this pane
    </Button>
  );
}
