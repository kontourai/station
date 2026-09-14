import { WORKSPACE_AGENTS_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-agents-pane';
import {
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import { WORKSPACE_DEVICE_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-device-pane';
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-file-preview';
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { WORKSPACE_PULL_REQUEST_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-pull-request-pane';
import { getBuiltinWorkspacePaneRenderer } from './builtinWorkspacePaneRegistry';

/**
 * The descriptors a region host renders through the built-in registry
 * (#2047): the coding panes, and since #2049 the two instance-keyed panes a
 * chat link opens — one pull request, one file preview — by descriptor id,
 * and since #2050 the Agents pane, and since #1969 the Device pane. Chat and Activity are not here — their renderers are handed to `RegionPaneHost` by its caller so the
 * host chunk imports neither render graph — and neither is anything the
 * pane inventory does not name (`REGION_SURFACE_PANES`; an instance reaches
 * this component only after that inventory admitted it).
 */
const REGION_BUILTIN_DESCRIPTORS: ReadonlyMap<string, WorkspacePaneDescriptor> =
  new Map(
    [
      WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
      WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
      WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
      WORKSPACE_PULL_REQUEST_PANE_DESCRIPTOR,
      WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
      WORKSPACE_AGENTS_PANE_DESCRIPTOR,
      WORKSPACE_DEVICE_PANE_DESCRIPTOR,
    ].map((descriptor) => [descriptor.id, descriptor]),
  );

/**
 * A docked built-in pane rendered through `getBuiltinWorkspacePaneRenderer`
 * — the same renderer the coding layout mounts it with, given the region's
 * project-bound instance (no layout binding; `builtinWorkspacePaneRegistry`
 * treats one as optional since #2047). Loaded behind `RegionPaneHost`'s
 * lazy boundary, so the registry's render graph joins the host only when a
 * region actually holds one of these.
 *
 * Throws for an instance with no renderer rather than rendering nothing —
 * the boundary reports it — the way the host treats an Activity pane it was
 * given no renderer for: every input here is a code-owned built-in, so a
 * miss is a build defect, not a runtime condition.
 */
export function RegionBuiltinPane({
  instance,
}: {
  instance: WorkspacePaneInstance;
}) {
  const descriptor = REGION_BUILTIN_DESCRIPTORS.get(instance.descriptorId);
  const Pane = descriptor
    ? getBuiltinWorkspacePaneRenderer(descriptor, instance)
    : null;
  if (!descriptor || !Pane)
    throw new Error(
      `Region host has no built-in renderer for "${instance.descriptorId}"`,
    );
  return (
    <div className="dock-slot__body">
      <Pane descriptor={descriptor} instance={instance} />
    </div>
  );
}
