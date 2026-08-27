import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import type { WorkspaceHomeRoleStatus } from '@kontourai/station-contracts/workspace-home-role';
import { lazy, Suspense } from 'react';
import { Button } from '../components/Button';
import { FirstRunHomeChapter } from '../components/first-run/FirstRunHomeChapter';
import { StarterInspectionCards } from '../components/home/StarterInspectionCards';
import { StarterScheduledCheckCard } from '../components/home/StarterScheduledCheckCard';
import { StarterWorkCard } from '../components/home/StarterWorkCard';
import { ErrorState, SkeletonList } from '../components/state';
import { useConfig } from '../contexts/ConfigContext';
import type { NavigationView } from '../types';
import { WorkspacePaneAwayState } from '../workspace-panes/WorkspacePaneAwayState';
import {
  isAmbientDockOccupant,
  useWorkspacePaneDockAction,
} from '../workspace-panes/WorkspacePaneDockContext';
import { selectClientWorkspacePaneRenderer } from '../workspace-panes/workspacePaneRendererSelection';
import {
  HomeWorkspacePane,
  HomeWorkspacePaneBindingProvider,
} from './home/HomeWorkspacePane';
import { useHomeViewModel } from './home/useHomeViewModel';
import {
  useRevokeWorkspaceHomeRole,
  useWorkspaceHomeRoleStatus,
} from './home/useWorkspaceHomeRole';
import './HomeView.css';

// Lazy for the same reason `getBuiltinWorkspacePaneRenderer` is not imported
// here: the granted path exists only after an explicit grant, so the root
// route without one must not download its chunk.
const HomeRolePane = lazy(() =>
  import('./home/HomeRolePane').then((module) => ({
    default: module.HomeRolePane,
  })),
);

/**
 * Home's host.
 *
 * Owns the shared model and mounts whichever renderer the Workspace Pane
 * selector admits for this build's fixed Home descriptor (station#3122 stage
 * 2). That descriptor's primary renderer is the built-in component. The
 * built-in renders because `selectClientWorkspacePaneRenderer` selected it,
 * not because this file directly mounts a surface.
 *
 * Stage 3 (the Home role) reaches this host through exactly one seam: the
 * SERVER-derived `WorkspaceHomeRoleStatus` read through
 * `useWorkspaceHomeRoleStatus`. Nothing browser-writable participates —
 * same-origin plugin code can neither write the grant record (it lives
 * server-side; the grant channel itself awaits a distinct-origin consent
 * surface and has no production writer on this build) nor forge the
 * status this render trusts (the SDK reparses it fail-closed through the
 * contract). This file still never chooses between Home descriptors — with
 * no grant there is one, and with a grant the choice was the user's
 * explicit act, held by the role, not the host. `HomeRolePane` owns
 * granted-Pane selection, its recovery boundary (which falls back to the
 * built-in with a truthful reason — `RouteViewBoundary`'s Reload would
 * re-enter the failure), and every other fall back to the floor. A `lapsed`
 * status — the plugin uninstalled, changed version, or changed bytes since
 * approval — renders the floor plus the derived reason, never the granted
 * code and never any of its degradation rungs. For the BUILT-IN descriptor
 * there is still deliberately no fallback when selection refuses: rendering
 * Home anyway would make the selection above decorative.
 *
 * station#3122's six-variant experiment concluded before this: the owner ran
 * them and picked, so the variant registry, selector store, switcher and
 * variant error boundary are gone and `HomeSurface` absorbed the two blocks
 * the winner contributed. That registry was a rival seam with no provenance,
 * capability gating or security kind; this is the Pane system instead.
 */
export function HomeView({
  continuation,
  onNavigate,
}: {
  continuation: Extract<
    NavigationView,
    { type: 'layout' } | { type: 'project' }
  > | null;
  onNavigate: (view: NavigationView) => void;
}) {
  const model = useHomeViewModel(onNavigate);
  const config = useConfig();
  const selection = selectClientWorkspacePaneRenderer(
    WORKSPACE_HOME_PANE_DESCRIPTOR,
    {
      mcpAppsEnabled: config?.mcpUiHost !== false,
      instance: WORKSPACE_HOME_PANE_INSTANCE,
    },
  );
  // The built-in is mounted directly rather than looked up through
  // `getBuiltinWorkspacePaneRenderer`, and only that lookup is skipped —
  // the authorization above is the shared one. The registry's component
  // table statically reaches Chat, the Coding panels, Flow and the evidence
  // inspectors (~800kB of chunk, measured), which the root route must not
  // download to render Home. `HomeWorkspacePane` is registered there under
  // the same renderer name, and a test pins that the registry resolves
  // Home's descriptor so the two cannot silently diverge.
  const builtinSelected =
    selection.state === 'selected' &&
    selection.candidate.source === 'primary' &&
    selection.candidate.renderer.kind === 'builtin-component';

  // While Home's canonical occurrence occupies the ambient dock, this route
  // renders the away state instead of a second live copy of the pane
  // (station#4090 M5; M2 disclosed the co-mount this replaces). The
  // derivation is the host's own published occupant state through
  // `isAmbientDockOccupant` — never a route-local flag — so choosing another
  // dock occupant clears this state without any route-side bookkeeping.
  const dock = useWorkspacePaneDockAction();
  const paneAway = isAmbientDockOccupant(dock, WORKSPACE_HOME_PANE_INSTANCE);

  // The un-removable floor (station#3122 stage 3): built once, used by both
  // branches below, so the granted path can only ever ADD a Pane above it —
  // there is no code path where a grant makes the built-in unreachable.
  const builtinHome = paneAway ? (
    <WorkspacePaneAwayState paneName={WORKSPACE_HOME_PANE_DESCRIPTOR.name} />
  ) : builtinSelected ? (
    <HomeWorkspacePaneBindingProvider
      binding={{ model, continuation, onNavigate }}
    >
      <HomeWorkspacePane
        descriptor={WORKSPACE_HOME_PANE_DESCRIPTOR}
        instance={WORKSPACE_HOME_PANE_INSTANCE}
      />
    </HomeWorkspacePaneBindingProvider>
  ) : (
    <ErrorState
      title="Home is unavailable"
      description="This build registers no renderer that Home’s declaration admits."
    />
  );

  // The Home role (stage 3). Absent, unresolved, or unreadable — the floor
  // states — this render is the stage-2 one. Granted, `HomeRolePane` owns
  // mounting the granted Pane, its recovery boundary, and every fall back
  // to the floor. Lapsed, the floor renders with the server-derived reason.
  const status = useWorkspaceHomeRoleStatus();
  const revoke = useRevokeWorkspaceHomeRole();

  return (
    // The shell owns the `main` landmark (`App.tsx`'s `#station-main`), so a
    // route renders a `section` inside it. Two `main` elements on one page is
    // not a stronger signal than one — it is an ambiguous landmark list and a
    // skip target that means two different things.
    <section className="home-view" aria-label="Home">
      {/* Home is where the guided first run lives (UX audit RT-02/SHELL-12).
          Mounted HERE rather than in `DeferredAppOverlays` on purpose: a
          surface that renders only inside this route cannot follow the user
          across routes, and cannot render on a page it has nothing to do
          with. It renders nothing at all unless this home's durable
          `firstRun` fact says it is on the table. Route chrome, not a Home
          renderer: it stays above BOTH the built-in and a granted Home. */}
      <FirstRunHomeChapter />
      {/* Starter Work is a post-onboarding offer.  It reads the same durable
          first-run decision as the chapter; a cached/default browser flag
          cannot make a real Task offer appear before setup is complete. */}
      {config?.firstRun?.status === 'completed' && (
        <>
          <StarterWorkCard />
          <StarterInspectionCards />
          <StarterScheduledCheckCard />
        </>
      )}
      {status?.state === 'granted' ? (
        <Suspense fallback={<SkeletonList count={1} label="Loading Home" />}>
          <HomeRolePane
            grant={status.grant}
            builtinHome={builtinHome}
            onRevoke={revoke}
          />
        </Suspense>
      ) : status?.state === 'lapsed' ? (
        <>
          <HomeRoleLapsedNotice status={status} onRevoke={revoke} />
          {builtinHome}
        </>
      ) : (
        builtinHome
      )}
    </section>
  );
}

const HOME_ROLE_LAPSE_EXPLANATIONS: Record<
  Extract<WorkspaceHomeRoleStatus, { state: 'lapsed' }>['reason'],
  string
> = {
  'plugin-missing': 'its plugin is no longer installed.',
  'pane-missing': 'its plugin no longer provides that pane.',
  'pane-disabled': 'its pane is disabled by distribution policy.',
  'version-changed':
    'its plugin’s installed version is not the one that was approved.',
  'code-changed': 'its plugin’s installed code changed since it was approved.',
};

/**
 * The floor's explanation for a grant the server derived as no longer
 * standing. Deliberately eager (not part of the lazy role chunk): it is a
 * few lines, and the state it explains is exactly one where the role chunk
 * must NOT be needed to render Home truthfully.
 */
function HomeRoleLapsedNotice({
  status,
  onRevoke,
}: {
  status: Extract<WorkspaceHomeRoleStatus, { state: 'lapsed' }>;
  onRevoke: () => void;
}) {
  return (
    <div className="home-role-fallback" role="status">
      <p className="home-role-fallback__reason">
        Station is showing the built-in Home. The Workspace Pane “
        {status.paneName}” from plugin {status.pluginId} no longer holds the
        Home role: {HOME_ROLE_LAPSE_EXPLANATIONS[status.reason]} Granting the
        Home role again would renew the approval.
      </p>
      <div className="home-role-fallback__actions">
        <Button onClick={onRevoke}>Keep the built-in Home</Button>
      </div>
    </div>
  );
}
