import { ConsoleBoardPane } from '@kontourai/station-board-pane';
import { isCanonicalWorkspaceBoardPaneInstance } from '@kontourai/station-board-pane/workspace-board-pane';
import { usePageHeader } from '../../components/page-frame';
import type { BuiltinWorkspacePaneProps } from '../../workspace-panes/builtinWorkspacePaneRegistry';
import { useInProcessWorkspacePaneHost } from '../../workspace-panes/inProcessPaneHost';
import { useWorkspacePaneBoundIdentity } from '../../workspace-panes/useWorkspacePaneBoundIdentity';
import { WorkspacePaneBindingUnavailable } from '../../workspace-panes/WorkspacePaneBindingUnavailable';
import '../page-layout.css';

/**
 * D8's redirect notice and banner id live with the in-process host adapter
 * now (`workspace-panes/inProcessPaneHost.tsx` — the shell half of
 * `presentUnavailable('no-builder-run')`); re-exported here so this
 * mounter's unit test and the durable E2E keep naming the one sentence.
 */
export {
  BOARD_UNAVAILABLE_BANNER_ID,
  BOARD_UNAVAILABLE_NOTICE,
} from '../../workspace-panes/inProcessPaneHost';

/**
 * The built-in Board Workspace Pane renderer — the ONE mounter of the Board
 * surface (`@kontourai/station-board-pane`'s `ConsoleBoardPane`), pinned by
 * `__tests__/board-surface-single-mounter.test.ts`. Every placement (the
 * `project-session-board` route and the `session-board` layout adapter, both
 * through `ConsoleBoardView`) reaches the surface through this renderer and
 * its canonical-occurrence check, so the pre-pane route/surface split cannot
 * silently re-form (epic station#4142 M4a, M3's pattern).
 *
 * Unlike Home and Activity, the Board BINDS a Project — its occurrence
 * carries `boundContext.projectId` and its one declared mode requires a
 * `project` context — so this renderer resolves that captured identity
 * through `useWorkspacePaneBoundIdentity`, the same derivation every other
 * Project-bound built-in uses, never route state.
 *
 * This file is also where the shell meets the package: the Board consumes
 * published contracts only, and its host is the pane-host contract
 * (station#4201, `docs/design/pane-host-contract.md` step 2) — built by the
 * shared in-process adapter from the shell's real capabilities, not
 * assembled member-by-member here. One mounter means one supplier; the
 * adapter means one mapping, shared with every future in-process pane. The
 * confirm chrome renders HERE, beside the pane, because the shell shows its
 * own modal on the pane's behalf — the pane only ever sees
 * `host.confirm(...)`'s promise.
 *
 * D8's route guard lives across the seam deliberately: the DERIVATION (the
 * server knows no Builder run) fires inside the pane, from the published
 * availability query, as `presentUnavailable('no-builder-run')`; the shell
 * half — the one notice on the banner stack (which outlives this pane's
 * unmount, exactly what a redirect notice needs) and the leave for the
 * project page — is the adapter's.
 */
export function BoardWorkspacePane({ instance }: BuiltinWorkspacePaneProps) {
  const identity = useWorkspacePaneBoundIdentity(instance, false);
  const project = identity.state === 'resolved' ? identity.project : null;
  const projectSlug = project?.slug;
  // 4-HOME-016: the board's own header sat under the notice stack with the
  // page's padding reset to 0 by `.page--full`. The frame owns both now.
  usePageHeader(project ? { title: 'Board', subtitle: project.name } : null);

  // Derived from the SAME expressions the early returns below branch on, so
  // the host's notion of "the pane is on screen" cannot drift from whether
  // this component actually renders it and its `confirmChrome`.
  const instanceIsCanonical = isCanonicalWorkspaceBoardPaneInstance(instance);
  const { host, confirmChrome } = useInProcessWorkspacePaneHost({
    projectSlug,
    active: instanceIsCanonical && identity.state === 'resolved',
  });

  if (!instanceIsCanonical)
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  return (
    <>
      <ConsoleBoardPane projectSlug={identity.project.slug} host={host} />
      {confirmChrome}
    </>
  );
}
