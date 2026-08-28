import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  type WorkspacePaneAvailability as PaneAvailability,
  resolveWorkspacePaneAvailability,
  type WorkspacePaneAvailabilityInput,
} from '@kontourai/station-contracts/workspace-pane-availability';
import { useProjectWorkspacePanesQuery } from '@kontourai/station-sdk/workspace-pane';
import { useMemo, useSyncExternalStore } from 'react';
import { isDistinctFrameOrigin } from '../components/mcp-ui/MCPToolUIFrame';
import { useConfig } from '../contexts/ConfigContext';
import { pluginRegistry } from '../core/PluginRegistry';
import {
  type PlatformProfile,
  usePlatformProfile,
} from '../platform/PlatformProfileContext';
import {
  adaptWorkspacePaneAvailabilityInput,
  useWorkspacePaneAvailabilityFacts,
  type WorkspacePaneAvailabilityFacts,
} from './workspacePaneAvailabilityAdapters';
import type { WorkspacePaneAvailabilityCatalogEntry } from './workspacePaneAvailabilityPresentation';
import { selectClientWorkspacePaneRenderer } from './workspacePaneRendererSelection';

type CatalogAvailabilityEntry = {
  descriptorId: WorkspacePaneDescriptor['id'];
  instanceId?: WorkspacePaneInstance['instanceId'];
/** Server-owned, bounded availability facts; the host adds its renderer fact. */
  input?: WorkspacePaneAvailabilityInput;
  availability: PaneAvailability;
};

type WorkspacePaneCatalogSnapshot = {
/** Canonical Project identity issued by the catalog route. */
  projectId: string;
  descriptors: readonly WorkspacePaneDescriptor[];
  instances: readonly WorkspacePaneInstance[];
/** Optional only while an older server/SDK pair is in flight. */
  availability?: readonly CatalogAvailabilityEntry[];
};

export type ClientWorkspacePaneRendererPresence =
  | 'present'
  | 'missing'
  | 'unknown';

export interface ResolvedWorkspacePaneCatalogEntry
  extends WorkspacePaneAvailabilityCatalogEntry {
  descriptor: WorkspacePaneDescriptor;
/** Absent for a known descriptor which has not yet been placed. */
  instance?: WorkspacePaneInstance;
/**
* Client-side component registration, deliberately separate from the
* resolver result. Presence here never proves the renderer executed.
*/
  clientRendererPresence: ClientWorkspacePaneRendererPresence;
/** Exact declared renderer selected from host facts; absent when none qualify. */
  selectedRenderer?: Extract<
    ReturnType<typeof selectClientWorkspacePaneRenderer>,
    { state: 'selected' }
  >['candidate'];
}

export interface ResolvedWorkspacePaneCatalog {
/** Absent only while an older server has not issued a canonical identity. */
  projectId?: string;
  entries: readonly ResolvedWorkspacePaneCatalogEntry[];
/** A display fact for responsive presentation, never a capability verdict. */
  platform: Pick<PlatformProfile, 'target' | 'isMobile' | 'isDesktop'>;
  rendererGate: 'remote-isolation' | null;
}

export function rendererGateFromPluginRegistryLoadStatus(status: {
  failure?: string;
}): 'remote-isolation' | null {
  return status.failure === 'remote-isolation' ? 'remote-isolation' : null;
}

/**
 * The direct-pane host registry is the authoritative UI fact for this batch.
 * Layout-only, plugin, and MCP branches stay fail-closed until their host
 * adapters register an actual single-slot renderer.
 */
export function clientWorkspacePaneRendererPresence(
  descriptor: WorkspacePaneDescriptor,
  mcpAppsEnabled = true,
): ClientWorkspacePaneRendererPresence {
  return selectClientWorkspacePaneRenderer(descriptor, { mcpAppsEnabled })
    .state === 'selected'
    ? 'present'
    : 'missing';
}

function unavailableUntilCatalogIsResolved(): PaneAvailability {
  return {
    state: 'unsupported',
    reason: { code: 'rollout-unknown', source: 'product-rollout' },
    action: { type: 'learn-more', code: 'view-rollout' },
  };
}

/**
 * Re-runs the shared resolver with one host-owned fact. Server input is kept
 * intact, so unknown/required host and deployment capability facts remain
 * fail-closed instead of being replaced by a UI availability shortcut.
 */
export function resolveWorkspacePaneCatalogPresentation(
  snapshot: WorkspacePaneCatalogSnapshot | undefined,
  profile: PlatformProfile,
  facts?: WorkspacePaneAvailabilityFacts,
  mcpAppsEnabled = true,
  pluginFramesEnabled = false,
  rendererGate: 'remote-isolation' | null = null,
): ResolvedWorkspacePaneCatalog {
  const availabilityByDescriptor = new Map<
    WorkspacePaneDescriptor['id'],
    {
      descriptor?: CatalogAvailabilityEntry;
      instances: Map<
        WorkspacePaneInstance['instanceId'],
        CatalogAvailabilityEntry
      >;
    }
  >();
  for (const entry of snapshot?.availability ?? []) {
    const entries = availabilityByDescriptor.get(entry.descriptorId) ?? {
      instances: new Map<
        WorkspacePaneInstance['instanceId'],
        CatalogAvailabilityEntry
      >(),
    };
    if (entry.instanceId === undefined) {
      entries.descriptor = entry;
    } else {
      entries.instances.set(entry.instanceId, entry);
    }
    availabilityByDescriptor.set(entry.descriptorId, entries);
  }
  const instancesByDescriptor = new Map<
    WorkspacePaneDescriptor['id'],
    WorkspacePaneInstance[]
  >();
  for (const instance of snapshot?.instances ?? []) {
    const instances = instancesByDescriptor.get(instance.descriptorId) ?? [];
    instances.push(instance);
    instancesByDescriptor.set(instance.descriptorId, instances);
  }

  const resolveEntry = (
    descriptor: WorkspacePaneDescriptor,
    instance?: WorkspacePaneInstance,
  ): ResolvedWorkspacePaneCatalogEntry => {
    const rendererSelection = selectClientWorkspacePaneRenderer(descriptor, {
      mcpAppsEnabled,
      pluginFramesEnabled,
      instance,
    });
    const clientRendererPresence =
      rendererSelection.state === 'selected' ? 'present' : 'missing';
    const projections = availabilityByDescriptor.get(descriptor.id);
    const projection = instance
      ? (projections?.instances.get(instance.instanceId) ??
        projections?.descriptor)
      : projections?.descriptor;
    const availability = projection?.input
      ? resolveWorkspacePaneAvailability(
          {
            ...adaptWorkspacePaneAvailabilityInput(
              projection.input,
              facts ?? {},
            ),
            renderer: clientRendererPresence,
          },
          descriptor.modes[0].contextRequirement,
        )
      : unavailableUntilCatalogIsResolved();
    return {
      descriptor,
      ...(instance ? { instance } : {}),
      availability,
// Remote isolation can only explain a renderer absence when this
// descriptor is POSITIVELY plugin-hosted. "Not in the builtin registry"
// is not that claim — mcp-tool-ui and standard-data renderers are also
// absent from it, and enabling extensions repairs none of them (sol
 // of archive#2640).
      ...(rendererGate && descriptor.renderer.kind === 'plugin-component'
        ? { rendererGate }
        : {}),
      clientRendererPresence,
      ...(rendererSelection.state === 'selected'
        ? { selectedRenderer: rendererSelection.candidate }
        : {}),
    };
  };

  return {
    ...(snapshot?.projectId ? { projectId: snapshot.projectId } : {}),
    entries: (snapshot?.descriptors ?? []).flatMap((descriptor) => {
      const instances = instancesByDescriptor.get(descriptor.id) ?? [];
      return instances.length > 0
        ? instances.map((instance) => resolveEntry(descriptor, instance))
        : [resolveEntry(descriptor)];
    }),
    platform: {
      target: profile.target,
      isMobile: profile.isMobile,
      isDesktop: profile.isDesktop,
    },
    rendererGate,
  };
}

/** One resolved-catalog seam for Project, add menu, palette, and direct URL. */
export function useResolvedWorkspacePaneCatalog(projectSlug: string) {
  const query = useProjectWorkspacePanesQuery(projectSlug, {
    enabled: Boolean(projectSlug),
  });
  const profile = usePlatformProfile();
  const config = useConfig();
// The registry is populated asynchronously after the pane catalog may have
// resolved. Its settled load status is the notification boundary that makes
// newly registered (including isolated remote) layouts selectable.
  const pluginRegistryLoadStatus = useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getLoadStatus,
  );
  const facts = useWorkspacePaneAvailabilityFacts();
  const catalog = useMemo(() => {
// Read the snapshot in the calculation as well as subscribing above:
// its identity is the registry-change invalidation for this projection.
    void pluginRegistryLoadStatus;
    return resolveWorkspacePaneCatalogPresentation(
      query.data as WorkspacePaneCatalogSnapshot | undefined,
      profile,
      facts,
      config?.mcpUiHost !== false,
      isDistinctFrameOrigin(config?.pluginFrameOrigin),
      rendererGateFromPluginRegistryLoadStatus(pluginRegistryLoadStatus),
    );
  }, [
    config?.mcpUiHost,
    config?.pluginFrameOrigin,
    facts,
    pluginRegistryLoadStatus,
    profile,
    query.data,
  ]);

  return { ...query, ...catalog };
}
