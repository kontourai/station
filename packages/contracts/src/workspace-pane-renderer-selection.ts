import type {
  WorkspacePaneAlternativeRenderer,
  WorkspacePaneDescriptor,
  WorkspacePaneProvenance,
  WorkspacePaneRendererCapability,
  WorkspacePaneRendererId,
  WorkspacePaneRendererRef,
} from './workspace-pane.js';

export interface WorkspacePaneRendererCandidate {
  source: 'primary' | 'alternative';
  rendererId?: WorkspacePaneRendererId;
  renderer: WorkspacePaneRendererRef;
  /** The descriptor contributor remains stable across renderer selection. */
  contributorProvenance: WorkspacePaneProvenance;
  /** Present only when the selected alternative declared independent attribution. */
  rendererProvenance?: WorkspacePaneProvenance;
  requiredCapabilities: readonly WorkspacePaneRendererCapability[];
}

export interface WorkspacePaneRendererSelectionOptions {
  capabilities: Iterable<WorkspacePaneRendererCapability>;
  isRendererPresent(candidate: WorkspacePaneRendererCandidate): boolean;
}

export type WorkspacePaneRendererSelection =
  | { state: 'selected'; candidate: WorkspacePaneRendererCandidate }
  | { state: 'unavailable' };

function implicitCapabilities(
  renderer: WorkspacePaneRendererRef,
): readonly WorkspacePaneRendererCapability[] {
  switch (renderer.kind) {
    case 'plugin-component':
      return ['trusted-plugin-react'];
    case 'mcp-tool-ui':
      return ['sandboxed-mcp-app'];
    case 'standard-data':
      return [];
    case 'builtin-component':
      return [];
  }
}

function candidateFor(
  descriptor: WorkspacePaneDescriptor,
  source: WorkspacePaneRendererCandidate['source'],
  alternative?: WorkspacePaneAlternativeRenderer,
): WorkspacePaneRendererCandidate {
  const renderer = alternative?.renderer ?? descriptor.renderer;
  const declared =
    alternative?.requiredCapabilities ??
    descriptor.requiredRendererCapabilities ??
    [];
  return {
    source,
    ...(source === 'primary' ? { rendererId: descriptor.rendererId } : {}),
    ...(alternative?.rendererId ? { rendererId: alternative.rendererId } : {}),
    renderer,
    contributorProvenance: descriptor.provenance,
    ...(alternative?.provenance
      ? { rendererProvenance: alternative.provenance }
      : {}),
    requiredCapabilities: [
      ...new Set([...implicitCapabilities(renderer), ...declared]),
    ],
  };
}

/**
 * Selects only a declared renderer whose host capability requirements and
 * exact renderer presence have both been proven. It never loads code, calls
 * MCP, or derives contributor identity from a renderer reference.
 */
export function selectWorkspacePaneRenderer(
  descriptor: WorkspacePaneDescriptor,
  options: WorkspacePaneRendererSelectionOptions,
): WorkspacePaneRendererSelection {
  const supported = new Set(options.capabilities);
  const candidates = [
    candidateFor(descriptor, 'primary'),
    ...(descriptor.alternativeRenderer
      ? [
          candidateFor(
            descriptor,
            'alternative',
            descriptor.alternativeRenderer,
          ),
        ]
      : []),
  ];
  for (const candidate of candidates) {
    if (
      candidate.requiredCapabilities.every((capability) =>
        supported.has(capability),
      ) &&
      options.isRendererPresent(candidate)
    ) {
      return { state: 'selected', candidate };
    }
  }
  return { state: 'unavailable' };
}
