import type { LayoutCatalogContribution } from '@kontourai/station-contracts/layout';
import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type { StationKitRegistryEntry } from '../kits/kit-observability-host.js';

export interface PortableKitWorkspacePane {
  descriptor: WorkspacePaneDescriptor;
  instance: WorkspacePaneInstance;
  enabled: boolean;
}

function packageVersion(packageRef: string): string | null {
  const lastAt = packageRef.lastIndexOf('@');
  if (lastAt <= 0 || lastAt === packageRef.length - 1) return null;
  const version = packageRef.slice(lastAt + 1);
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    ? version
    : null;
}

/**
 * Adapts the existing Kit observability lifecycle record into inert portable
 * pane declarations. No Kit code, MCP resource, or action is invoked here.
 */
export function portableKitWorkspacePanes(
  entries: readonly StationKitRegistryEntry[],
  projectId: string,
): PortableKitWorkspacePane[] {
  return entries.flatMap((entry) => {
    const packageRef = entry.contribution.spec.package_ref;
    const version = packageVersion(packageRef);
    if (!version) return [];
    const contribution: LayoutCatalogContribution = {
      id: `kit:${entry.contributionRef}`,
      version,
      sourceIdentity: {
        id: entry.contributionRef,
        kind: 'local',
        source: packageRef,
      },
      provenance: { origin: 'plugin', pluginId: entry.contributionRef },
    };
    return entry.experience.standardViews.flatMap((view) => {
      const encodedRef = encodeURIComponent(entry.contributionRef);
      const encodedView = encodeURIComponent(view.id);
      const descriptor = parseWorkspacePaneDescriptor({
        version: '1.0',
        id: `pane:plugin%3A${encodedRef}:portable:${encodedView}`,
        name: view.projection,
        description: `Read-only ${view.projection} projection from ${entry.contributionRef}.`,
        rendererId: `renderer:plugin%3A${encodedRef}:standard-data:${encodedView}`,
        renderer: {
          kind: 'standard-data',
          view: {
            id: view.id,
            projection: view.projection,
            schemaRef: view.schemaRef,
            readOnly: true,
            contribution,
            incarnation: entry.incarnation,
          },
        },
        placement: { supportedRegions: ['primary', 'secondary', 'standalone'] },
        modes: [{ id: 'default', contextRequirement: { project: true } }],
        provenance: contribution.provenance,
        lifecycle: { stage: 'stable' },
      });
      if (!descriptor) return [];
      const instance = parseWorkspacePaneInstance({
        version: '1.0',
        descriptorId: descriptor.id,
        instanceId: `instance:kit:${projectId}:${encodedRef}:${encodedView}:${entry.incarnation}`,
        stateKey: `state:kit:${projectId}:${encodedRef}:${encodedView}:${entry.incarnation}`,
        boundContext: { projectId, contribution },
      });
      return instance
        ? [{ descriptor, instance, enabled: entry.lifecycle === 'installed' }]
        : [];
    });
  });
}
