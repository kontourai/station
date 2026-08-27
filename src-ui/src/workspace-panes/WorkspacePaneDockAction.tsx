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
      onClick={() => dock.dockPane(descriptor, instance)}
    >
      Dock this pane
    </Button>
  );
}
