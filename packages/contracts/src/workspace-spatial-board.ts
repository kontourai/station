import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR_ID =
  'pane:builtin:workspace-spatial-board';
export const WORKSPACE_SPATIAL_BOARD_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-spatial-board';
export const WORKSPACE_SPATIAL_BOARD_PANE_RENDERER_NAME =
  'workspace-spatial-board';
export const WORKSPACE_SPATIAL_BOARD_PANE_SOURCE_ID =
  'builtin:workspace-spatial-board';

const parsed = parseWorkspacePaneDescriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR_ID,
  name: 'Work Board',
  description:
    'Arrange exact Station work references on a personal spatial board.',
  rendererId: WORKSPACE_SPATIAL_BOARD_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_SPATIAL_BOARD_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['primary', 'secondary', 'standalone'],
    preferredRegion: 'primary',
  },
  modes: [{ id: 'default', contextRequirement: { project: true } }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});
if (!parsed) throw new Error('Canonical spatial board Pane must be valid');
export const WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR = parsed;

export function createWorkspaceSpatialBoardPaneInstance(
  projectId: string,
): WorkspacePaneInstance | null {
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR_ID,
    instanceId: `workspace-spatial-board:${projectId}`,
    stateKey: `workspace-spatial-board:${projectId}`,
    boundContext: {
      projectId,
      sourceId: WORKSPACE_SPATIAL_BOARD_PANE_SOURCE_ID,
    },
  });
}

export function isCanonicalWorkspaceSpatialBoardPaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  const projectId = instance.boundContext?.projectId;
  if (!projectId) return false;
  const expected = createWorkspaceSpatialBoardPaneInstance(projectId);
  return (
    !!expected &&
    instance.descriptorId === expected.descriptorId &&
    instance.instanceId === expected.instanceId &&
    instance.stateKey === expected.stateKey &&
    instance.boundContext?.sourceId ===
      WORKSPACE_SPATIAL_BOARD_PANE_SOURCE_ID &&
    instance.boundContext.projectId === projectId &&
    Object.keys(instance.boundContext).length === 2
  );
}

export function isCanonicalWorkspaceSpatialBoardDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return (
    descriptor.id === WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR.id &&
    descriptor.rendererId ===
      WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR.rendererId &&
    descriptor.renderer.kind === 'builtin-component' &&
    descriptor.renderer.name === WORKSPACE_SPATIAL_BOARD_PANE_RENDERER_NAME &&
    descriptor.provenance.origin === 'builtin'
  );
}
