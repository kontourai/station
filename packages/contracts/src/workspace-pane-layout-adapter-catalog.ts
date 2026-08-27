import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  type WorkspacePaneDescriptor,
  type WorkspacePaneDescriptorId,
  type WorkspacePaneInstance,
  type WorkspacePaneInstanceId,
} from './workspace-pane.js';
import { paneAdaptationFromLayoutTab } from './workspace-pane-layout-adapter-adaptation.js';
import {
  cloneData,
  deepFreeze,
  isNonEmptyTrimmedString,
  isPlainObject,
  normalizeContext,
  structurallyEqual,
} from './workspace-pane-layout-adapter-helpers.js';
import type {
  WorkspacePaneCatalog,
  WorkspacePaneCatalogInput,
  WorkspacePaneLayoutAdapterContext,
  WorkspacePaneLayoutDefinitionInput,
  WorkspacePaneLayoutTabAdaptation,
} from './workspace-pane-layout-adapter-types.js';

/** Enumerates one supplied layout in declared tab order, failing closed. */
export function enumerateLayoutDefinitionPanes(
  layout: unknown,
  context: WorkspacePaneLayoutAdapterContext,
): WorkspacePaneLayoutTabAdaptation[] | null {
  if (!isPlainObject(layout)) return null;
  if (!Array.isArray(layout.tabs)) return null;
  if (!normalizeContext(context)) return null;

  let requiredProviders: readonly string[] | undefined;
  if (layout.requiredProviders !== undefined) {
    if (
      !Array.isArray(layout.requiredProviders) ||
      !layout.requiredProviders.every(isNonEmptyTrimmedString)
    )
      return null;
    requiredProviders = [...layout.requiredProviders];
  }

  const adaptations: WorkspacePaneLayoutTabAdaptation[] = [];
  const seenTabIds = new Set<string>();
  for (const [index, tab] of (layout.tabs as unknown[]).entries()) {
    const adaptation = paneAdaptationFromLayoutTab(tab, context, {
      order: index,
      requiredProviders,
    });
    if (!adaptation) return null;
    if (seenTabIds.has(adaptation.retainedLayoutTab.id)) return null;
    seenTabIds.add(adaptation.retainedLayoutTab.id);
    adaptations.push(adaptation);
  }
  return adaptations;
}

/** Enumerates supplied layouts in supplied-layout then declared-tab order. */
export function enumerateLayoutPanes(
  inputs: Iterable<WorkspacePaneLayoutDefinitionInput>,
): WorkspacePaneLayoutTabAdaptation[] | null {
  const adaptations: WorkspacePaneLayoutTabAdaptation[] = [];
  for (const input of inputs) {
    if (!isPlainObject(input)) return null;
    const enumerated = enumerateLayoutDefinitionPanes(
      input.layout,
      input.context as WorkspacePaneLayoutAdapterContext,
    );
    if (!enumerated) return null;
    adaptations.push(...enumerated);
  }
  return adaptations;
}

function compareDescriptors(
  a: WorkspacePaneDescriptor,
  b: WorkspacePaneDescriptor,
): number {
  const orderA = a.placement.order;
  const orderB = b.placement.order;
  if (orderA !== orderB) {
    if (orderA === undefined) return 1;
    if (orderB === undefined) return -1;
    return orderA - orderB;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareInstances(
  a: WorkspacePaneInstance,
  b: WorkspacePaneInstance,
): number {
  if (a.descriptorId !== b.descriptorId) {
    return a.descriptorId < b.descriptorId ? -1 : 1;
  }
  return a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0;
}

function collectDescriptors(
  descriptors: Iterable<WorkspacePaneDescriptor>,
): Map<string, WorkspacePaneDescriptor> {
  const byDescriptorId = new Map<string, WorkspacePaneDescriptor>();
  for (const rawDescriptor of descriptors) {
    const descriptor = parseWorkspacePaneDescriptor(rawDescriptor);
    if (!descriptor) {
      throw new TypeError('Invalid workspace pane descriptor in catalog');
    }
    const existing = byDescriptorId.get(descriptor.id);
    if (existing) {
      // One descriptor can have multiple independent placements. Repeated
      // adaptations are valid only when their data and security/provenance
      // class are identical; instances remain distinct below.
      if (structurallyEqual(existing, descriptor)) continue;
      throw new TypeError(
        `Duplicate workspace pane descriptor id in catalog: ${descriptor.id}`,
      );
    }
    // The contract parser above reconstructs every known field into a fresh,
    // validated value. A generic whole-record clone would count descriptor
    // wrappers against the already-validated MCP initialArguments budget.
    byDescriptorId.set(descriptor.id, deepFreeze(descriptor));
  }
  return byDescriptorId;
}

function collectInstances(
  rawInstances: Iterable<WorkspacePaneInstance>,
  descriptors: ReadonlyMap<string, WorkspacePaneDescriptor>,
): Map<string, WorkspacePaneInstance> {
  const byInstanceId = new Map<string, WorkspacePaneInstance>();
  const byStateKey = new Set<string>();
  for (const rawInstance of rawInstances) {
    const instance = parseWorkspacePaneInstance(rawInstance);
    if (!instance) {
      throw new TypeError('Invalid workspace pane instance in catalog');
    }
    if (byInstanceId.has(instance.instanceId)) {
      throw new TypeError(
        `Duplicate workspace pane instance id in catalog: ${instance.instanceId}`,
      );
    }
    if (byStateKey.has(instance.stateKey)) {
      throw new TypeError(
        `Duplicate workspace pane instance state key in catalog: ${instance.stateKey}`,
      );
    }
    if (!descriptors.has(instance.descriptorId)) {
      throw new TypeError(
        `WorkspacePane instance ${instance.instanceId} references unknown descriptor: ${instance.descriptorId}`,
      );
    }
    byInstanceId.set(instance.instanceId, deepFreeze(cloneData(instance)));
    byStateKey.add(instance.stateKey);
  }
  return byInstanceId;
}

function buildCatalog(
  byDescriptorId: Map<string, WorkspacePaneDescriptor>,
  byInstanceId: Map<string, WorkspacePaneInstance>,
): WorkspacePaneCatalog {
  const descriptors = Object.freeze(
    [...byDescriptorId.values()].sort(compareDescriptors),
  );
  const instances = Object.freeze(
    [...byInstanceId.values()].sort(compareInstances),
  );
  return Object.freeze({
    size: descriptors.length,
    instanceCount: instances.length,
    get: (id: WorkspacePaneDescriptorId | string) => byDescriptorId.get(id),
    getDescriptor: (id: WorkspacePaneDescriptorId | string) =>
      byDescriptorId.get(id),
    has: (id: WorkspacePaneDescriptorId | string) => byDescriptorId.has(id),
    list: () => descriptors,
    listDescriptors: () => descriptors,
    getInstance: (id: WorkspacePaneInstanceId | string) => byInstanceId.get(id),
    listInstances: (descriptorId?: WorkspacePaneDescriptorId | string) =>
      descriptorId === undefined
        ? instances
        : Object.freeze(
            instances.filter(
              (instance) => instance.descriptorId === descriptorId,
            ),
          ),
  });
}

/** Builds the deterministic, frozen catalog without availability side effects. */
export function createWorkspacePaneCatalog(
  input: WorkspacePaneCatalogInput,
): WorkspacePaneCatalog {
  const descriptors = collectDescriptors(input.descriptors);
  const instances = collectInstances(input.instances ?? [], descriptors);
  return buildCatalog(descriptors, instances);
}

/** Builds the same catalog from an iterable of adaptation records. */
export function createWorkspacePaneCatalogFromAdaptations(
  adaptations: Iterable<WorkspacePaneLayoutTabAdaptation>,
): WorkspacePaneCatalog {
  const entries = [...adaptations];
  return createWorkspacePaneCatalog({
    descriptors: entries.map((entry) => entry.descriptor),
    instances: entries.map((entry) => entry.instance),
  });
}
