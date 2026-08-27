import type { WorkspaceHomeRoleGrant } from '@kontourai/station-contracts/workspace-home-role';
import { workspaceHomeRoleGrantCoversProjection } from '@kontourai/station-contracts/workspace-home-role';
import { Component, type ReactNode, useSyncExternalStore } from 'react';
import { Button } from '../../components/Button';
import { pluginRegistry } from '../../core/PluginRegistry';
import { WorkspacePaneStandardDataView } from '../../workspace-panes/WorkspacePaneStandardDataView';
import {
  resolveClientTrustedPluginLayout,
  selectClientWorkspacePaneRenderer,
} from '../../workspace-panes/workspacePaneRendererSelection';
import {
  describeWorkspaceHomeProjectionField,
  WORKSPACE_HOME_PROJECTION_FIELDS,
} from './home-role-projection';

/**
 * Mounts the Workspace Pane the Home role grant names, above the built-in
 * floor (station#3122 stage 3). The grant this receives is server-derived —
 * `HomeView` mounts this component only for a `granted` status the server
 * re-checked against the live installation, reparsed fail-closed on the
 * client — so nothing browser-writable ever reaches this file as authority.
 *
 * The launcher constraints this file exists to keep:
 *
 * - **The built-in Home is un-removable.** Every path out of this component
 *   that is not the granted Pane rendering successfully lands on
 *   `builtinHome` — with a truthful reason where there is a failure to
 *   explain, silently while the plugin inventory is still loading.
 * - **A broken granted Home must be recoverable — including one that breaks
 *   during SELECTION.** `RouteViewBoundary` above this route catches and
 *   offers Reload, and a reload re-enters the same failure; an eager deref
 *   during catalog resolution has already blanked the whole app once
 *   (`workspacePaneRendererSelection.ts`). So renderer selection AND
 *   resolution run INSIDE `HomeRoleRecoveryBoundary` (a React boundary
 *   cannot catch throws from the component constructing it), and the
 *   fallback is the built-in Home plus the actual failure text — never a
 *   blank root, never a reload loop.
 * - **Which tiers may render here is decided at two sites, deliberately.**
 *   `isWorkspaceHomeRoleEligibleDescriptor` (enforced when the grant is
 *   created AND re-enforced on every parse) is one; this host's offered
 *   capability set (no sandboxed hosts enabled) is the other. They are
 *   independent checks that must agree — defence in depth, not a single
 *   line to flip.
 */
export interface HomeRolePaneProps {
  grant: WorkspaceHomeRoleGrant;
  /** The un-removable floor: rendered whenever the granted Pane is not. */
  builtinHome: ReactNode;
  /** Revocation, wired to the server store; returning to the built-in is its whole effect. */
  onRevoke: () => void;
}

/**
 * Bounded description of an arbitrary thrown value. Every derivation is
 * guarded: an adversarial throw value (a getter that throws on `name`, a
 * `toString` that throws) must not be able to break recovery inside the
 * recovery path.
 */
function describeThrow(error: unknown): string {
  let message: string;
  try {
    message =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  } catch {
    return 'It failed with a value that cannot be described.';
  }
  if (typeof message !== 'string') {
    return 'It failed with a value that cannot be described.';
  }
  const trimmed = message.trim();
  const bounded = trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  return bounded.length > 0 ? bounded : 'It failed without a message.';
}

class HomeRoleRecoveryBoundary extends Component<
  {
    children: ReactNode;
    fallback: (failure: string, retry: () => void) => ReactNode;
  },
  { failure: string | null }
> {
  state: { failure: string | null } = { failure: null };

  static getDerivedStateFromError(error: unknown): { failure: string } {
    return { failure: describeThrow(error) };
  }

  componentDidCatch(error: unknown): void {
    // The user-facing explanation is the fallback's job; this keeps the full
    // error reachable for someone debugging the plugin.
    console.error('Granted Home Workspace Pane failed to render:', error);
  }

  retry = (): void => {
    this.setState({ failure: null });
  };

  render(): ReactNode {
    if (this.state.failure !== null) {
      return this.props.fallback(this.state.failure, this.retry);
    }
    return this.props.children;
  }
}

function HomeRoleFallback({
  grant,
  reason,
  onRetry,
  onRevoke,
  builtinHome,
}: {
  grant: WorkspaceHomeRoleGrant;
  reason: string;
  onRetry?: () => void;
  onRevoke: () => void;
  builtinHome: ReactNode;
}) {
  return (
    <>
      <div className="home-role-fallback" role="status">
        <p className="home-role-fallback__reason">
          Station is showing the built-in Home. The Workspace Pane “
          {grant.descriptor.name}” from plugin{' '}
          {grant.descriptor.provenance.pluginId} could not render: {reason}
        </p>
        <div className="home-role-fallback__actions">
          {onRetry && <Button onClick={onRetry}>Try again</Button>}
          <Button onClick={onRevoke}>Keep the built-in Home</Button>
        </div>
      </div>
      {builtinHome}
    </>
  );
}

function HomeRoleBar({
  grant,
  onRevoke,
}: {
  grant: WorkspaceHomeRoleGrant;
  onRevoke: () => void;
}) {
  return (
    <div className="home-role-bar">
      <span className="home-role-bar__provenance">
        Home is provided by “{grant.descriptor.name}” from plugin{' '}
        {grant.descriptor.provenance.pluginId}.
      </span>
      <Button onClick={onRevoke}>Use built-in Home</Button>
    </div>
  );
}

/**
 * Renderer selection, resolution, and the granted mount. Runs INSIDE
 * `HomeRoleRecoveryBoundary` so a throw during selection or resolution — the
 * exact class that once blanked the app from the catalog path — lands on the
 * built-in floor with the real failure text instead of escaping to
 * `RouteViewBoundary`'s reload loop.
 */
function GrantedHomeSelection({
  grant,
  builtinHome,
  onRevoke,
}: HomeRolePaneProps) {
  // Selection consults the live plugin registry; its settled load status is
  // the notification boundary that turns a just-loaded bundle into a
  // selectable renderer (same seam as `useResolvedWorkspacePaneCatalog`).
  const loadStatus = useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getLoadStatus,
  );

  // No sandboxed host capabilities are offered at Home — the second of the
  // two tier-decision sites (see the module docblock).
  const selection = selectClientWorkspacePaneRenderer(grant.descriptor, {
    mcpAppsEnabled: false,
    instance: grant.instance,
  });

  if (selection.state !== 'selected') {
    if (loadStatus.state === 'loading') {
      // The inventory has not settled; "missing" would be a claim nothing
      // has derived yet. The floor renders, quietly, and the settled status
      // re-renders this component.
      return <>{builtinHome}</>;
    }
    return (
      <HomeRoleFallback
        grant={grant}
        reason={unavailableReason(grant, loadStatus)}
        onRevoke={onRevoke}
        builtinHome={builtinHome}
      />
    );
  }

  const candidate = selection.candidate;

  if (candidate.renderer.kind === 'standard-data') {
    // The descriptor's declared degradation rung: inert, read-only data in
    // place of a plugin renderer that failed to LOAD. It must not outlive
    // the grant — the rung's own selection check compares two STORED
    // snapshots, so it is additionally gated here on the client's live
    // registry still evidencing the granted plugin: either its loaded
    // manifest at the approved version, or this generation's inventory
    // having listed it and its bundle having failed (the case the rung
    // exists for). An uninstalled or version-bumped plugin satisfies
    // neither, so the floor renders instead. (The server already derives
    // `lapsed` for uninstall/version change; this closes the staleness
    // window between that derivation and this render.)
    const pluginId = grant.descriptor.provenance.pluginId;
    const approvedVersion = grant.instance.boundContext?.contribution?.version;
    const liveManifest =
      pluginId !== undefined
        ? pluginRegistry.getLayoutManifest(pluginId)
        : null;
    const installLive =
      pluginId !== undefined &&
      ((liveManifest !== null &&
        approvedVersion !== undefined &&
        liveManifest.version === approvedVersion) ||
        (loadStatus.failure === 'bundle-load-failure' &&
          loadStatus.failedPluginNames.includes(pluginId)));
    if (!installLive) {
      if (loadStatus.state === 'loading') {
        return <>{builtinHome}</>;
      }
      return (
        <HomeRoleFallback
          grant={grant}
          reason={unavailableReason(grant, loadStatus)}
          onRevoke={onRevoke}
          builtinHome={builtinHome}
        />
      );
    }
    return (
      <>
        <HomeRoleBar grant={grant} onRevoke={onRevoke} />
        <WorkspacePaneStandardDataView
          renderer={candidate.renderer}
          instance={grant.instance}
        />
      </>
    );
  }

  if (candidate.renderer.kind !== 'plugin-component') {
    // Unreachable under this host's capability set (no sandboxed hosts, and
    // builtin candidates require canonical builtin declarations); kept as a
    // fail-closed landing on the floor rather than a throw.
    return (
      <HomeRoleFallback
        grant={grant}
        reason="Its declared renderer is not one the Home role admits."
        onRevoke={onRevoke}
        builtinHome={builtinHome}
      />
    );
  }

  const TrustedLayout = resolveClientTrustedPluginLayout(
    grant.descriptor,
    candidate,
    grant.instance,
  );
  if (!TrustedLayout) {
    return (
      <HomeRoleFallback
        grant={grant}
        reason="Its plugin’s current registration no longer matches the approved Pane."
        onRevoke={onRevoke}
        builtinHome={builtinHome}
      />
    );
  }

  return (
    <>
      <HomeRoleBar grant={grant} onRevoke={onRevoke} />
      <TrustedLayout />
    </>
  );
}

export function HomeRolePane({
  grant,
  builtinHome,
  onRevoke,
}: HomeRolePaneProps) {
  // A widened projection is a NEW grant. The stored field list is what the
  // approval covered; naming exactly the fields it did not is what makes
  // this message derived rather than asserted. Pure data comparison — safe
  // outside the boundary.
  if (
    !workspaceHomeRoleGrantCoversProjection(
      grant,
      WORKSPACE_HOME_PROJECTION_FIELDS,
    )
  ) {
    const unapproved = WORKSPACE_HOME_PROJECTION_FIELDS.filter(
      (field) => !grant.projectionFields.includes(field),
    ).map(describeWorkspaceHomeProjectionField);
    return (
      <HomeRoleFallback
        grant={grant}
        reason={`Home now carries information the approval did not cover (${unapproved.join(
          '; ',
        )}). Granting the Home role again would cover it.`}
        onRevoke={onRevoke}
        builtinHome={builtinHome}
      />
    );
  }

  return (
    <HomeRoleRecoveryBoundary
      fallback={(failure, retry) => (
        <HomeRoleFallback
          grant={grant}
          reason={`It failed while rendering (${failure}).`}
          onRetry={retry}
          onRevoke={onRevoke}
          builtinHome={builtinHome}
        />
      )}
    >
      <GrantedHomeSelection
        grant={grant}
        builtinHome={builtinHome}
        onRevoke={onRevoke}
      />
    </HomeRoleRecoveryBoundary>
  );
}

function unavailableReason(
  grant: WorkspaceHomeRoleGrant,
  loadStatus: ReturnType<typeof pluginRegistry.getLoadStatus>,
): string {
  const pluginId = grant.descriptor.provenance.pluginId;
  if (loadStatus.failure === 'remote-isolation') {
    return 'Extensions from this remote Station are disabled, so its code is not loaded.';
  }
  if (loadStatus.failure === 'registry-unavailable') {
    return 'Station could not read the installed plugin inventory.';
  }
  if (
    loadStatus.failure === 'bundle-load-failure' &&
    pluginId !== undefined &&
    loadStatus.failedPluginNames.includes(pluginId)
  ) {
    return 'Its plugin’s code failed to load.';
  }
  return 'Its plugin is not installed, or its installed version no longer matches what was approved.';
}
