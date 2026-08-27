/**
 * Public Workspace Pane compatibility facade.
 *
 * This stable subpath intentionally contains no adaptation mechanics. The
 * implementation is separated by responsibility so consumers retain this API
 * while clone/identity safety, adaptation persistence, and catalog enumeration
 * can evolve and be reviewed independently.
 */
export {
  layoutTabFromWorkspacePaneAdaptation,
  paneAdaptationFromLayoutTab,
  parseWorkspacePaneLayoutTabAdaptation,
} from './workspace-pane-layout-adapter-adaptation.js';
export {
  createWorkspacePaneCatalog,
  createWorkspacePaneCatalogFromAdaptations,
  enumerateLayoutDefinitionPanes,
  enumerateLayoutPanes,
} from './workspace-pane-layout-adapter-catalog.js';
export {
  type EnumerableLayoutDefinition,
  MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH,
  type WorkspacePaneCatalog,
  type WorkspacePaneCatalogInput,
  type WorkspacePaneLayoutAdapterContext,
  type WorkspacePaneLayoutDefinitionInput,
  type WorkspacePaneLayoutTabAdaptation,
  type WorkspacePaneLayoutTabAdapterOptions,
} from './workspace-pane-layout-adapter-types.js';
