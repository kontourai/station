import { RequiredSlotRecoveryScope } from './requiredSlotRecovery';
import {
  WorkspacePaneHostTree,
  type WorkspacePaneHostTreeProps,
} from './WorkspacePaneHostTree';
import { workspacePaneHostScopeKey } from './workspacePaneHostNavigation';

/** Public host boundary. Rendering lives in the tree module. */
export type WorkspacePaneHostProps = WorkspacePaneHostTreeProps;

export function WorkspacePaneHost(props: WorkspacePaneHostProps) {
  return (
    <RequiredSlotRecoveryScope
      key={`${workspacePaneHostScopeKey(props.document.scope)}:${props.document.id}`}
    >
      <WorkspacePaneHostTree {...props} />
    </RequiredSlotRecoveryScope>
  );
}
