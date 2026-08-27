import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';

export const WORKSPACE_BOARD_PANE_DESCRIPTOR_ID = 'pane:builtin:board';
export const WORKSPACE_BOARD_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-board';
export const WORKSPACE_BOARD_PANE_RENDERER_NAME = 'workspace-board';
export const WORKSPACE_BOARD_PANE_SOURCE_ID = 'builtin:workspace-board';

const parsed = parseWorkspacePaneDescriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_BOARD_PANE_DESCRIPTOR_ID,
  name: 'Board',
  description: 'Builder work in flight for this Project, by flow stage.',
  rendererId: WORKSPACE_BOARD_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_BOARD_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['standalone'],
    preferredRegion: 'standalone',
  },
  /**
   * The Board is Project-scoped by declaration, not by habit (epic
   * station#4142 M4a): its one mode requires a `project` context, so the
   * ambient dock's admission derivation
   * (`workspacePaneModesSatisfiableBy` over the ambient scope's empty
   * suppliable set) refuses it without this package ever being asked.
   * The dockable set stays `{chat, home, activity}` — see
   * `__tests__/workspace-board-pane.test.ts` for the explicit negative
   * proof.
   */
  modes: [{ id: 'default', contextRequirement: { project: true } }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});
if (!parsed) throw new Error('Canonical Board Workspace Pane must be valid');

/**
 * The Board, declared as a Workspace Pane (epic station#4142 M4a — the Board
 * becomes a first-party package on published contracts;
 * `docs/design/pane-or-shell.md` Runtime tiers, tier 2).
 *
 * This module deliberately imports nothing but
 * `@kontourai/station-contracts` and stays React-free: the host's canonical
 * admission table (`builtinWorkspacePaneCanonical.ts`) loads it eagerly on
 * every renderer-selection path, while the Board's component chunk stays
 * behind the registry's lazy boundary.
 *
 * `provenance.origin: 'builtin'` is what the contract's parser uses to refuse
 * a `pluginId` here (`parseProvenance`), so a contributed Board can never
 * arrive wearing this attribution — it must declare its own.
 */
export const WORKSPACE_BOARD_PANE_DESCRIPTOR: WorkspacePaneDescriptor = parsed;

/**
 * The Board's one placed occurrence per Project. A factory rather than a
 * constant (Home/Activity's shape) because the Board binds the Project whose
 * Builder runs it shows — the identity is parameterized, exactly like the
 * spatial Work Board's (`createWorkspaceSpatialBoardPaneInstance`).
 */
export function createWorkspaceBoardPaneInstance(
  projectId: string,
): WorkspacePaneInstance | null {
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_BOARD_PANE_DESCRIPTOR_ID,
    instanceId: `workspace-board:${projectId}`,
    stateKey: `workspace-board:${projectId}`,
    boundContext: {
      projectId,
      sourceId: WORKSPACE_BOARD_PANE_SOURCE_ID,
    },
  });
}

export function isCanonicalWorkspaceBoardPaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  const projectId = instance.boundContext?.projectId;
  if (!projectId) return false;
  const expected = createWorkspaceBoardPaneInstance(projectId);
  return (
    !!expected &&
    instance.descriptorId === expected.descriptorId &&
    instance.instanceId === expected.instanceId &&
    instance.stateKey === expected.stateKey &&
    instance.boundContext?.sourceId === WORKSPACE_BOARD_PANE_SOURCE_ID &&
    instance.boundContext.projectId === projectId &&
    Object.keys(instance.boundContext).length === 2
  );
}

export function isCanonicalWorkspaceBoardDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return (
    descriptor.id === WORKSPACE_BOARD_PANE_DESCRIPTOR.id &&
    descriptor.rendererId === WORKSPACE_BOARD_PANE_DESCRIPTOR.rendererId &&
    descriptor.renderer.kind === 'builtin-component' &&
    descriptor.renderer.name === WORKSPACE_BOARD_PANE_RENDERER_NAME &&
    descriptor.provenance.origin === 'builtin'
  );
}
