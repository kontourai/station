import { types as utilTypes } from 'node:util';
import type {
  LayoutCatalogItem,
  ResolvedCatalogLayout,
} from '@kontourai/station-contracts/distribution';
import type { LayoutTab } from '@kontourai/station-contracts/layout';
import {
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { isRegisteredBuiltinWorkspacePaneRendererName } from '@kontourai/station-contracts/workspace-pane-builtin-renderers';
import {
  createWorkspacePaneCatalog,
  createWorkspacePaneCatalogFromAdaptations,
  enumerateLayoutPanes,
} from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import type { StationKitRegistryEntry } from '../kits/kit-observability-host.js';
import type { DistributionCatalogReadView } from '../plugins/distribution-profile-service.js';
import { portableKitWorkspacePanes } from './portable-kit-workspace-panes.js';
import {
  resolveWorkspacePaneCatalogAvailability,
  type WorkspacePaneCatalogAvailabilityCandidate,
  type WorkspacePaneCatalogAvailabilityEntry,
  type WorkspacePaneCatalogAvailabilityOptions,
} from './workspace-pane-availability-resolver.js';
import {
  KNOWN_WORKSPACE_PANE_DECLARATIONS,
  knownWorkspacePaneInstances,
  mergeKnownWorkspacePaneDescriptors,
} from './workspace-pane-known-declarations.js';

/** Serializable, read-only projection returned to React and SDK callers. */
export interface WorkspacePaneCatalogSnapshot {
  version: '1.0';
  /** Canonical Project identity; the route slug is only an address. */
  projectId: string;
  /** Current known source contributions, including disabled entries. */
  contributions: readonly WorkspacePaneCatalogContribution[];
  descriptors: readonly WorkspacePaneDescriptor[];
  instances: readonly WorkspacePaneInstance[];
  availability: readonly WorkspacePaneCatalogAvailabilityEntry[];
}

type WorkspacePaneCatalogContribution = LayoutCatalogItem & {
  /** Display-only lifecycle explanation; never execution authorization. */
  disabledReason?: 'Disabled by distribution policy or lifecycle override';
};

/**
 * Node-only ingestion boundary for catalog/plugin declarations. Contracts and
 * the SDK deliberately remain browser-bundleable, where JavaScript has no
 * way to identify every Proxy without invoking arbitrary meta traps. Reject
 * those values here, before portable Pane parsing or adapter reflection.
 */
function hasSafeCatalogIngressData(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (utilTypes.isProxy(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (
      (Array.isArray(value) && prototype !== Array.prototype) ||
      (!Array.isArray(value) &&
        prototype !== Object.prototype &&
        prototype !== null)
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every(
      (descriptor) =>
        descriptor.get === undefined &&
        descriptor.set === undefined &&
        hasSafeCatalogIngressData(descriptor.value, seen),
    );
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

function assertSafeCatalogIngressData(value: unknown): void {
  if (!hasSafeCatalogIngressData(value)) {
    throw new Error('Workspace Pane catalog contains unsafe ingress data');
  }
}

function tabsForCurrentLayout(resolved: ResolvedCatalogLayout): LayoutTab[] {
  if (resolved.definition.tabs.length > 0) return [...resolved.definition.tabs];
  // Built-ins are current Layout catalog entries but predate LayoutTab
  // persistence. Describe their existing renderer generically from catalog
  // data; no renderer is loaded or executed here.
  if (resolved.item.source !== 'builtin') return [];
  // archive#3798: the synthesised renderer name is the layout's `type`, and
  // not every builtin layout HAS a Pane renderer — `session-board` and
  // `tasks` are reached as routes and never appear in the build's renderer
  // inventory. Synthesising a tab for them advertised a Pane whose renderer
  // cannot exist, which the client resolver could only explain as
  // "Temporarily unavailable / The pane renderer is currently unavailable":
  // a transient sentence, with a Retry that can never help, for a permanent
  // structural fact. The verdict is derived from the registered renderer set
  // rather than a layout name, so a renderer added later needs no edit here.
  // Contributing no tab is the shape archive#3778 already chose for a Pane
  // whose subject does not exist: no descriptor, no instance, no availability
  // entry, while the layout stays a listed contribution.
  if (!isRegisteredBuiltinWorkspacePaneRendererName(resolved.definition.type)) {
    return [];
  }
  return [
    {
      id: resolved.definition.slug,
      label: resolved.definition.name,
      component: {
        kind: 'builtin-component',
        name: resolved.definition.type,
      },
    },
  ];
}

/**
 * Reads today's built-in and known plugin layouts into the host-neutral Pane
 * contract. Disabled contributions remain visible with their lifecycle/policy
 * record so a host can explain them, but this never authorizes application or
 * renderer execution.
 */
interface WorkspacePaneCatalogLayoutOffer {
  /**
   * Whether this project offers the layout as a Pane at all (archive#3778).
   *
   * Distinct from availability on purpose: availability explains a Pane that
   * exists, and there is no honest availability sentence for a Pane whose
   * subject does not exist here. The Board is the case — its nav entry and its
   * route both derive existence from `OperatingStateService.hasBuilderRun`,
   * and the Pane catalogue used to advertise a 'Session Board' card anyway,
   * blaming a renderer that is "temporarily unavailable" on a project that
   * simply has no Builder run. Returning false omits the descriptor and its
   * instance, exactly as the nav omits its entry.
   */
  offersLayout?: (layout: { slug: string; type: string }) => boolean;
}

export function readCurrentWorkspacePaneCatalog(
  layoutCatalog: DistributionCatalogReadView,
  projectId: string,
  availabilityOptions?: WorkspacePaneCatalogAvailabilityOptions,
  portableKits: readonly StationKitRegistryEntry[] = [],
  layoutOffer: WorkspacePaneCatalogLayoutOffer = {},
): WorkspacePaneCatalogSnapshot {
  const inputs = [];
  const contributions: WorkspacePaneCatalogContribution[] = [];
  const listedLayouts = layoutCatalog.listLayouts();
  const allDirectPluginPanes =
    layoutCatalog.listPluginWorkspacePaneContributions?.() ?? [];
  assertSafeCatalogIngressData(listedLayouts);
  assertSafeCatalogIngressData(allDirectPluginPanes);
  /**
   * Per-principal plugin visibility (#2067), applied as ABSENCE at the source.
   *
   * This catalogue IS an enumeration of the instance's installed plugins: a
   * contribution carries the plugin's name, version, on-disk `plugins/<name>`
   * source and lifecycle state. Filtering only the availability array would
   * leave every one of those facts in the same response that claims the
   * caller may not see the plugin — which is precisely what
   * `packages/contracts/src/workspace-pane-availability.ts` promises the
   * refusal withholds. So a plugin outside the caller's projection is dropped
   * before it becomes a contribution, a descriptor, an instance, or an
   * availability entry, exactly as `GET /api/plugins` drops it from the list
   * and for the same reason.
   *
   * ## One path, and the other one is NOT implemented here
   *
   * This is DISCOVERY — "what could I add?" — and absence is the whole
   * answer. The REFERENCE case (a layout that already names a pane the
   * viewer cannot see, which should render a placeholder rather than a blank
   * region) is issue #2067's second acceptance criterion and is NOT
   * satisfied on this branch. See the note on
   * `WorkspacePaneAvailabilityInput.pluginVisibility` for why it was removed
   * rather than shipped a third time, and what a real implementation needs.
   */
  const hidesPlugin = (pluginId: string | undefined): boolean =>
    pluginId !== undefined &&
    availabilityOptions?.canSeePlugin !== undefined &&
    !availabilityOptions.canSeePlugin(pluginId);
  const directPluginPanes = allDirectPluginPanes.filter(
    (entry) =>
      // The manifest loader REFUSES a manifest whose pane provenance names
      // anything but the manifest's own name
      // (`plugin-manifest-loader.ts:396-398`), so this id is the same string
      // `GET /api/plugins` reports and the same string an operator grants.
      //
      // And a directory whose name diverges from `manifest.name` cannot
      // produce a colliding id either: `plugin-catalog-installation.ts:45`
      // returns null for that pair, so the plugin yields no catalog
      // installation at all and is invisible to this catalogue for EVERYONE,
      // the operator included. There is no collision to hunt here.
      !hidesPlugin(entry.descriptor.provenance.pluginId),
  );
  for (const item of listedLayouts) {
    if (
      item.lifecycle.state !== 'installed' &&
      item.lifecycle.state !== 'disabled'
    )
      continue;
    // #2067, same absence: a layout contributed by a plugin this caller
    // cannot see never becomes a listed contribution. Its provenance is the
    // installed plugin's own catalog identity, which the adapter requires to
    // equal the descriptor provenance it derives
    // (`contributionMatchesDescriptorProvenance`), so one check covers the
    // contribution row and every Pane the layout adapts into.
    if (
      item.contribution.provenance.origin === 'plugin' &&
      hidesPlugin(item.contribution.provenance.pluginId)
    )
      continue;
    // This descriptor resolver is intentionally non-authorizing. It may read
    // a declared layout but never applies it, loads a renderer, or executes a
    // plugin/MCP contribution.
    const resolved: ResolvedCatalogLayout = layoutCatalog.resolveForCatalog(
      item.id,
    );
    assertSafeCatalogIngressData(resolved);
    const contribution: WorkspacePaneCatalogContribution = {
      ...resolved.item,
      sourceIdentity: { ...resolved.item.sourceIdentity },
      contribution: {
        ...resolved.item.contribution,
        sourceIdentity: { ...resolved.item.contribution.sourceIdentity },
        provenance: { ...resolved.item.contribution.provenance },
      },
      lifecycle: { ...resolved.item.lifecycle },
      policy: { ...resolved.item.policy },
    };
    if (resolved.item.lifecycle.state === 'disabled') {
      contribution.disabledReason =
        'Disabled by distribution policy or lifecycle override';
    }
    contributions.push(contribution);
    // The layout stays a listed contribution — it IS installed — but it
    // contributes no Pane when this project does not offer it.
    if (
      layoutOffer.offersLayout &&
      !layoutOffer.offersLayout({
        slug: resolved.definition.slug,
        type: resolved.definition.type,
      })
    ) {
      continue;
    }
    const tabs = tabsForCurrentLayout(resolved);
    if (!tabs.length) continue;
    inputs.push({
      layout: { ...resolved.definition, tabs },
      context: {
        layoutSlug: resolved.definition.slug,
        instanceScope: `project:${projectId}:source:${item.id}`,
        pluginId: resolved.pluginName,
        contribution: resolved.item.contribution,
        modeContextRequirement: {
          project: true as const,
          source: true as const,
        },
        boundContext: { projectId, sourceId: item.id },
      },
    });
  }
  const adaptations = enumerateLayoutPanes(inputs);
  if (!adaptations) {
    throw new Error(
      'Current layout catalog contains an invalid Pane adaptation',
    );
  }
  const layoutPaneCatalog =
    createWorkspacePaneCatalogFromAdaptations(adaptations);
  const portablePanes = portableKitWorkspacePanes(portableKits, projectId);
  const portableEnabledByInstanceId = new Map(
    portablePanes.map((pane) => [pane.instance.instanceId, pane.enabled]),
  );
  const descriptorCatalog = mergeKnownWorkspacePaneDescriptors([
    ...layoutPaneCatalog.listDescriptors(),
    ...directPluginPanes.map(({ descriptor }) => descriptor),
    ...portablePanes.map((pane) => pane.descriptor),
  ]);
  // archive#3543: every direct plugin declaration receives one server-issued,
  // Project-bound occurrence, exactly as the legacy bridge and portable kits
  // do — a descriptor without an instance can never bind a renderer. The
  // bound contribution is the distribution service's on-disk installation
  // record. The client trust check (`isBoundTrustedPluginCandidate`) treats it
  // and the descriptor's provenance as a consistency check, failing closed on
  // divergence from tampering, manual relocation, or a corrupted inventory.
  // The supported installer derives both names from `manifest.name`, so this
  // does not establish independently controlled identity. An entry without
  // that record (an older catalog source) issues nothing.
  const directPluginPaneInstances = directPluginPanes.flatMap((entry) => {
    if (!entry.contribution) return [];
    const instance = parseWorkspacePaneInstance({
      version: WORKSPACE_PANE_CONTRACT_VERSION,
      descriptorId: entry.descriptor.id,
      instanceId: `instance:plugin:${projectId}:${entry.id}`,
      stateKey: `state:plugin:${projectId}:${entry.id}`,
      boundContext: { projectId, contribution: entry.contribution },
    });
    return instance ? [instance] : [];
  });
  const catalog = createWorkspacePaneCatalog({
    descriptors: descriptorCatalog.listDescriptors(),
    instances: [
      ...layoutPaneCatalog.listInstances(),
      ...directPluginPaneInstances,
      ...portablePanes.map((pane) => pane.instance),
      ...knownWorkspacePaneInstances(projectId),
    ],
  });
  const descriptors = catalog.listDescriptors();
  const instances = catalog.listInstances();
  const contributionsById = new Map(
    contributions.map((entry) => [entry.id, entry]),
  );
  const directContributionByDescriptorId = new Map(
    directPluginPanes.map((entry) => [entry.descriptor.id, entry]),
  );
  const knownDeclarationsByDescriptorId = new Map(
    KNOWN_WORKSPACE_PANE_DECLARATIONS.map((declaration) => [
      declaration.descriptor.id,
      declaration,
    ]),
  );
  /**
   * #2067, the Kit exemption.
   *
   * A portable Kit pane carries `origin: 'plugin'` with `pluginId` set to the
   * Kit's contribution ref (`portable-kit-workspace-panes.ts`), because the
   * provenance union has no Kit origin to name. That ref is NOT an installed
   * plugin: it has no `plugins/<name>` directory, it never appears in
   * `GET /api/plugins`, and an operator has no way to grant it. Handing it to
   * the projection unchanged would hide every Kit pane from every
   * non-operator permanently, with no grantable name — a silent behaviour
   * change for panes this slice was never about.
   *
   * So the projection is consulted only for ids this catalogue built from an
   * INSTALLED PLUGIN. Kit visibility is a real question and a separate one;
   * it belongs to the Kit lifecycle record, not to the plugin grant record.
   */
  const installedPluginIds = new Set<string>([
    ...allDirectPluginPanes.flatMap((entry) =>
      entry.descriptor.provenance.origin === 'plugin' &&
      entry.descriptor.provenance.pluginId !== undefined
        ? [entry.descriptor.provenance.pluginId]
        : [],
    ),
    ...listedLayouts.flatMap((item) =>
      item.contribution.provenance.origin === 'plugin' &&
      item.contribution.provenance.pluginId !== undefined
        ? [item.contribution.provenance.pluginId]
        : [],
    ),
  ]);
  const catalogAvailabilityOptions: WorkspacePaneCatalogAvailabilityOptions =
    availabilityOptions?.canSeePlugin
      ? {
          ...availabilityOptions,
          canSeePlugin: (pluginId) =>
            installedPluginIds.has(pluginId)
              ? availabilityOptions.canSeePlugin!(pluginId)
              : undefined,
        }
      : (availabilityOptions ?? {});
  return {
    version: '1.0',
    projectId,
    contributions,
    descriptors,
    instances,
    availability: resolveWorkspacePaneCatalogAvailability(
      descriptors.flatMap(
        (descriptor): WorkspacePaneCatalogAvailabilityCandidate[] => {
          const descriptorInstances = catalog.listInstances(descriptor.id);
          const knownDeclaration = knownDeclarationsByDescriptorId.get(
            descriptor.id,
          );
          if (descriptorInstances.length === 0) {
            return [
              {
                descriptor,
                ...(directContributionByDescriptorId.has(descriptor.id)
                  ? {
                      contribution: directContributionByDescriptorId.get(
                        descriptor.id,
                      ),
                    }
                  : {}),
                ...(knownDeclaration
                  ? { availabilityInput: knownDeclaration.availabilityInput }
                  : {}),
              },
            ];
          }
          return descriptorInstances.map((instance) => ({
            descriptor,
            instance,
            contribution:
              directContributionByDescriptorId.get(descriptor.id) ??
              (instance.boundContext?.contribution
                ? (contributionsById.get(
                    instance.boundContext.contribution.id,
                  ) ??
                  (portableEnabledByInstanceId.has(instance.instanceId)
                    ? {
                        id: instance.boundContext.contribution.id,
                        enabled:
                          portableEnabledByInstanceId.get(
                            instance.instanceId,
                          ) === true,
                      }
                    : undefined))
                : undefined),
            ...(knownDeclaration
              ? { availabilityInput: knownDeclaration.availabilityInput }
              : {}),
          }));
        },
      ),
      catalogAvailabilityOptions,
    ),
  };
}
