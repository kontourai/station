import type { LayoutCatalogContribution } from './layout.js';
import type {
  WorkspacePaneBoundContext,
  WorkspacePaneContextRequirement,
  WorkspacePaneDescriptor,
  WorkspacePaneDescriptorId,
  WorkspacePaneInstance,
  WorkspacePaneInstanceId,
  WorkspacePaneLifecycle,
  WorkspacePaneRegion,
} from './workspace-pane.js';

/** Upper bound on one escaped segment in an adapter-minted identity. */
export const MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH = 128;

/**
 * Identity and provenance facts the baseline layout shape cannot carry. The
 * adapter receives them from its caller rather than guessing contributor data.
 */
export interface WorkspacePaneLayoutAdapterContext {
  layoutSlug: string;
  instanceScope?: string;
  /** Baseline single-placement shorthand. Prefer `supportedRegions`. */
  region?: WorkspacePaneRegion;
  supportedRegions?: readonly WorkspacePaneRegion[];
  preferredRegion?: WorkspacePaneRegion;
  lifecycle?: WorkspacePaneLifecycle;
  pluginId?: string;
  mcpServerId?: string;
  /** Default mode requirements; distinct from this occurrence's binding. */
  modeContextRequirement?: WorkspacePaneContextRequirement;
  /** Exact identities captured for this occurrence; never host-native state. */
  boundContext?: WorkspacePaneBoundContext;
  /** Exact catalog contributor/source snapshot for layout-derived panes. */
  contribution?: LayoutCatalogContribution;
  requiresProject?: boolean;
}

/** One adapted tab and the verbatim retained layout tab for lossless restore. */
export interface WorkspacePaneLayoutTabAdaptation {
  descriptor: WorkspacePaneDescriptor;
  instance: WorkspacePaneInstance;
  retainedLayoutTab: import('./layout.js').LayoutTab;
}

/** Per-tab facts supplied by its containing layout rather than the caller. */
export interface WorkspacePaneLayoutTabAdapterOptions {
  order?: number;
  requiredProviders?: readonly string[];
}

/** Narrowing of `LayoutDefinition` this module reads. */
export type EnumerableLayoutDefinition = Pick<
  import('./layout.js').LayoutDefinition,
  'tabs' | 'requiredProviders'
>;

/** One untrusted layout definition paired with its caller-supplied context. */
export interface WorkspacePaneLayoutDefinitionInput {
  layout: unknown;
  context: WorkspacePaneLayoutAdapterContext;
}

/** Read-only descriptor/instance view over an adapted layout collection. */
export interface WorkspacePaneCatalog {
  readonly size: number;
  readonly instanceCount: number;
  get(
    id: WorkspacePaneDescriptorId | string,
  ): WorkspacePaneDescriptor | undefined;
  getDescriptor(
    id: WorkspacePaneDescriptorId | string,
  ): WorkspacePaneDescriptor | undefined;
  has(id: WorkspacePaneDescriptorId | string): boolean;
  list(): readonly WorkspacePaneDescriptor[];
  listDescriptors(): readonly WorkspacePaneDescriptor[];
  getInstance(
    id: WorkspacePaneInstanceId | string,
  ): WorkspacePaneInstance | undefined;
  listInstances(
    descriptorId?: WorkspacePaneDescriptorId | string,
  ): readonly WorkspacePaneInstance[];
}

export interface WorkspacePaneCatalogInput {
  descriptors: Iterable<WorkspacePaneDescriptor>;
  instances?: Iterable<WorkspacePaneInstance>;
}
