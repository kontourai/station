import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
  WorkspacePaneRendererCandidate,
} from '@kontourai/station-contracts';
import { withWorkspacePaneInstanceLayoutBinding } from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneAvailabilityAction } from '@kontourai/station-contracts/workspace-pane-availability';
import { useProjectLayoutQuery } from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { ErrorState, SkeletonList } from '../components/state';
import { useConfig } from '../contexts/ConfigContext';
import { useNavigation } from '../contexts/NavigationContext';
import { LayoutRenderer } from '../layouts';
import { getBuiltinWorkspacePaneRenderer } from './builtinWorkspacePaneRegistry';
import { trackMcpAppDisplayModeDecision } from './mcpAppDisplayModeTelemetry';
import { PluginWorkspacePaneSDKBoundary } from './PluginWorkspacePaneSDKBoundary';
import { useResolvedWorkspacePaneCatalog } from './resolvedWorkspacePaneCatalog';
import { WorkspacePaneAvailabilityList } from './WorkspacePaneAvailabilityList';
import { WorkspacePaneFrame } from './WorkspacePaneFrame';
import { WorkspacePaneStandardDataView } from './WorkspacePaneStandardDataView';
import type { WorkspacePaneAvailabilityCatalogEntry } from './workspacePaneAvailabilityPresentation';
import { workspacePaneRequiresLayoutIdentity } from './workspacePaneDirectRoute';
import { isWorkspacePaneInstanceOwnedByProject } from './workspacePaneHostAdmission';
import {
  resolveClientTrustedPluginLayout,
  selectClientWorkspacePaneRenderer,
} from './workspacePaneRendererSelection';

type McpResourceFailure = {
  descriptorId: string;
  instanceId: string;
  ref: string;
  fingerprint: string;
};

/**
 * A terminal MCP fact applies only to the declaration that made its complete
 * presentation set eligible. Include the complete normalized descriptor (the
 * renderer ref and versioned identity live there), the selected renderer, and
 * the placed contribution snapshot. The standard-data alternative's
 * contribution and incarnation remain inside the descriptor, so a lifecycle
 * replacement cannot consume a result from its predecessor.
 */
function mcpResolutionFingerprint(
  descriptor: WorkspacePaneDescriptor | undefined,
  candidate: WorkspacePaneRendererCandidate | undefined,
  instance: WorkspacePaneInstance | undefined,
): string | undefined {
  if (candidate?.renderer.kind !== 'mcp-tool-ui' || !instance) return undefined;
  return JSON.stringify({
    descriptor,
    renderer: candidate,
    contribution: instance.boundContext?.contribution,
  });
}

function declaredStandardDataAlternative(
  candidate: WorkspacePaneRendererCandidate | undefined,
): WorkspacePaneRendererCandidate | undefined {
  return candidate?.source === 'alternative' &&
    candidate.renderer.kind === 'standard-data'
    ? candidate
    : undefined;
}

export function WorkspacePaneRouteView({
  projectSlug,
  layoutSlug,
  descriptorId,
  instanceId,
}: {
  projectSlug: string;
  layoutSlug?: string;
  descriptorId: string;
  instanceId: string;
}) {
  const { navigate } = useNavigation();
  const config = useConfig();
  const catalog = useResolvedWorkspacePaneCatalog(projectSlug);
  const [mcpResourceFailure, setMcpResourceFailure] =
    useState<McpResourceFailure>();
  const entry = catalog.entries.find(
    (candidate) =>
      candidate.descriptor.id === descriptorId &&
      candidate.instance?.instanceId === instanceId,
  );
  const requiresSelectedLayout = entry
    ? workspacePaneRequiresLayoutIdentity(entry.descriptor)
    : false;
  const layoutQuery = useProjectLayoutQuery(projectSlug, layoutSlug ?? '', {
    enabled: requiresSelectedLayout && Boolean(layoutSlug),
  });
  const currentMcpResolutionFingerprint = mcpResolutionFingerprint(
    entry?.descriptor,
    entry?.selectedRenderer,
    entry?.instance,
  );

  useEffect(() => {
    setMcpResourceFailure((current) =>
      current?.fingerprint === currentMcpResolutionFingerprint
        ? current
        : undefined,
    );
  }, [currentMcpResolutionFingerprint]);

  const handleAction = (
    _entry: WorkspacePaneAvailabilityCatalogEntry,
    action: WorkspacePaneAvailabilityAction,
  ): string => {
    if (action.code === 'retry-availability-check') {
      void catalog.refetch();
      return 'Checking the current pane availability.';
    }
    if (action.code === 'enable-distribution') {
      navigate('/registry/layouts');
      return 'Opening the layout registry to review distribution.';
    }
    return 'This route can explain the requirement but cannot complete that step.';
  };

  const canExecuteAction = (
    _entry: WorkspacePaneAvailabilityCatalogEntry,
    action: WorkspacePaneAvailabilityAction,
  ) =>
    action.code === 'retry-availability-check' ||
    action.code === 'enable-distribution';

  if (catalog.isLoading && !entry) {
    return <SkeletonList count={1} label="Loading workspace pane" />;
  }
  if (catalog.isError) {
    return (
      <ErrorState
        title="Could not load workspace pane"
        description="Station could not read this Project’s pane catalog."
        action={
          <button type="button" onClick={() => void catalog.refetch()}>
            Retry
          </button>
        }
      />
    );
  }
  if (!entry) {
    return (
      <ErrorState
        title="Workspace pane not found"
        description="This Project doesn’t have that pane."
        action={
          <button
            type="button"
            onClick={() =>
              navigate(`/projects/${encodeURIComponent(projectSlug)}`)
            }
          >
            Back to Project
          </button>
        }
      />
    );
  }

  const matchingMcpResourceFailure =
    mcpResourceFailure?.descriptorId === entry.descriptor.id &&
    mcpResourceFailure.instanceId === entry.instance?.instanceId &&
    mcpResourceFailure.fingerprint === currentMcpResolutionFingerprint
      ? mcpResourceFailure
      : undefined;
  const asyncRendererSelection =
    matchingMcpResourceFailure && entry.instance
      ? selectClientWorkspacePaneRenderer(entry.descriptor, {
          mcpAppsEnabled: config?.mcpUiHost !== false,
          instance: entry.instance,
          unavailableMcpToolRefs: matchingMcpResourceFailure
            ? [matchingMcpResourceFailure.ref]
            : undefined,
        })
      : undefined;
  const selectedRenderer =
    declaredStandardDataAlternative(
      asyncRendererSelection?.state === 'selected'
        ? asyncRendererSelection.candidate
        : undefined,
    ) ?? entry.selectedRenderer;

  const handleMcpUiResolution = (resolution: {
    ref: string;
    status: 'missing_resource' | 'render_revoked';
  }) => {
    if (
      !entry.instance ||
      !currentMcpResolutionFingerprint ||
      selectedRenderer?.renderer.kind !== 'mcp-tool-ui' ||
      selectedRenderer.renderer.ref !== resolution.ref
    ) {
      return;
    }
    setMcpResourceFailure((current) => {
      const next = {
        descriptorId: entry.descriptor.id,
        instanceId: entry.instance!.instanceId,
        ref: resolution.ref,
        fingerprint: currentMcpResolutionFingerprint,
      };
      return current?.descriptorId === next.descriptorId &&
        current.instanceId === next.instanceId &&
        current.ref === next.ref &&
        current.fingerprint === next.fingerprint
        ? current
        : next;
    });
  };

  if (
    entry.availability.state === 'available' &&
    requiresSelectedLayout &&
    !layoutSlug
  ) {
    return (
      <ErrorState
        title="Workspace pane needs a selected layout"
        description="Open a Project layout to use this pane with its configured workspace."
        action={
          <button
            type="button"
            onClick={() =>
              navigate(`/projects/${encodeURIComponent(projectSlug)}`)
            }
          >
            Back to Project
          </button>
        }
      />
    );
  }

  if (
    entry.availability.state === 'available' &&
    entry.instance &&
    !isWorkspacePaneInstanceOwnedByProject(entry.instance, catalog.projectId)
  ) {
    return (
      <ErrorState
        title="Workspace pane unavailable"
        description="This pane belongs to a different Project."
      />
    );
  }

  if (requiresSelectedLayout && layoutSlug && layoutQuery.isLoading) {
    return <SkeletonList count={1} label="Opening this pane" />;
  }
  if (requiresSelectedLayout && layoutSlug && !layoutQuery.data) {
    return (
      <ErrorState
        title="Workspace pane unavailable"
        description="The selected layout no longer resolves for this Project."
      />
    );
  }
  const boundInstance =
    entry.instance && requiresSelectedLayout && layoutQuery.data
      ? withWorkspacePaneInstanceLayoutBinding(entry.instance, layoutQuery.data)
      : entry.instance;
  if (entry.instance && requiresSelectedLayout && !boundInstance) {
    return (
      <ErrorState
        title="Workspace pane unavailable"
        description="Station could not bind this pane to the selected layout."
      />
    );
  }

  if (
    entry.availability.state === 'available' &&
    selectedRenderer?.renderer.kind === 'standard-data' &&
    boundInstance
  ) {
    return (
      <section
        className="project-page project-page__workspace-pane-route"
        aria-label={entry.descriptor.name}
      >
        <div className="project-page__inner">
          <WorkspacePaneFrame
            instanceId={boundInstance.instanceId}
            paneName={entry.descriptor.name}
          >
            <WorkspacePaneStandardDataView
              renderer={selectedRenderer.renderer}
              instance={boundInstance}
            />
          </WorkspacePaneFrame>
        </div>
      </section>
    );
  }

  const Pane = getBuiltinWorkspacePaneRenderer(
    entry.descriptor,
    entry.instance,
  );
  if (
    entry.availability.state === 'available' &&
    Pane &&
    boundInstance &&
    catalog.projectId
  ) {
    return (
      <section
        className="project-page project-page__workspace-pane-route"
        aria-label={entry.descriptor.name}
      >
        <div className="project-page__inner">
          <WorkspacePaneFrame
            instanceId={boundInstance.instanceId}
            paneName={entry.descriptor.name}
          >
            <Pane descriptor={entry.descriptor} instance={boundInstance} />
          </WorkspacePaneFrame>
        </div>
      </section>
    );
  }

  const trustedPluginLayout =
    selectedRenderer?.renderer.kind === 'plugin-component' && entry.instance
      ? resolveClientTrustedPluginLayout(
          entry.descriptor,
          selectedRenderer,
          entry.instance,
        )
      : null;

  if (
    entry.availability.state === 'available' &&
    selectedRenderer &&
    boundInstance &&
    selectedRenderer.renderer.kind !== 'standard-data' &&
    (selectedRenderer.renderer.kind !== 'plugin-component' ||
      trustedPluginLayout !== null)
  ) {
    const selectedTab = {
      id: boundInstance.instanceId,
      label: entry.descriptor.name,
      description: entry.descriptor.description,
      component: selectedRenderer.renderer,
      actions: entry.descriptor.actions,
    };
    const paneLayout = {
      name: entry.descriptor.name,
      slug: boundInstance.instanceId,
      tabs: [selectedTab],
    };
    const renderer = (
      <LayoutRenderer
        componentId={selectedRenderer.renderer}
        trustedPluginLayout={trustedPluginLayout ?? undefined}
        layout={paneLayout}
        activeTab={selectedTab}
        activeTabId={selectedTab.id}
        onMcpUiResolution={handleMcpUiResolution}
        mcpUiResolutionIdentity={currentMcpResolutionFingerprint}
        mcpUiPaneIdentity={{
          descriptorId: boundInstance.descriptorId,
          instanceId: boundInstance.instanceId,
          stateKey: boundInstance.stateKey,
        }}
        onMcpUiDisplayModeDecision={trackMcpAppDisplayModeDecision}
      />
    );
    const owningPluginName =
      trustedPluginLayout &&
      boundInstance.boundContext?.contribution?.provenance.origin === 'plugin'
        ? boundInstance.boundContext.contribution.provenance.pluginId
        : undefined;
    if (trustedPluginLayout && (!owningPluginName || !catalog.projectSlug)) {
      return (
        <ErrorState
          title="Workspace pane unavailable"
          description="Station could not bind this plugin pane to its owning Project and plugin."
        />
      );
    }
    return (
      <section
        className="project-page project-page__workspace-pane-route"
        aria-label={entry.descriptor.name}
      >
        <div className="project-page__inner">
          <WorkspacePaneFrame
            instanceId={boundInstance.instanceId}
            paneName={entry.descriptor.name}
          >
            {trustedPluginLayout ? (
              // The server-issued catalog Project id matches this occurrence
              // above, and the slug comes from that same Project record. Reuse
              // the ONE SDK composition; do not create parallel authorities.
              <PluginWorkspacePaneSDKBoundary
                layout={paneLayout}
                projectSlug={catalog.projectSlug!}
                pluginName={owningPluginName!}
              >
                {renderer}
              </PluginWorkspacePaneSDKBoundary>
            ) : (
              renderer
            )}
          </WorkspacePaneFrame>
        </div>
      </section>
    );
  }

  if (entry.availability.state === 'available') {
    return (
      <ErrorState
        title="Workspace pane cannot mount"
        description="This pane is not registered by the current host build."
        action={
          <button
            type="button"
            onClick={() =>
              navigate(`/projects/${encodeURIComponent(projectSlug)}`)
            }
          >
            Back to Project
          </button>
        }
      />
    );
  }

  return (
    <section
      className="project-page project-page__workspace-pane-route"
      aria-labelledby="workspace-pane-route-title"
    >
      <div className="project-page__inner">
        <h2 id="workspace-pane-route-title">Workspace pane</h2>
        <p className="project-page__modal-description">
          This pane is not currently available to mount in this host.
        </p>
        <WorkspacePaneAvailabilityList
          entries={[entry]}
          aria-label="Workspace pane availability"
          onSelect={() => undefined}
          onAction={handleAction}
          canExecuteAction={canExecuteAction}
        />
      </div>
    </section>
  );
}
