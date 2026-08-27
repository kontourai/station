import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_HOME_PANE_DESCRIPTOR_ID = 'pane:builtin:home';
export const WORKSPACE_HOME_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-home';
export const WORKSPACE_HOME_PANE_RENDERER_NAME = 'workspace-home';
export const WORKSPACE_HOME_PANE_SOURCE_ID = 'builtin:workspace-home';
export const WORKSPACE_HOME_PANE_INSTANCE_ID = 'workspace-home';

function descriptor(value: unknown): WorkspacePaneDescriptor {
  const parsed = parseWorkspacePaneDescriptor(value);
  if (!parsed) throw new Error('Invalid built-in Home Workspace Pane');
  return parsed;
}

/**
 * Home, declared as a Workspace Pane (station#3122 stage 2).
 *
 * Two declarations here are load-bearing and deliberate:
 *
 * - **A requirement-free default mode.** Every other builtin Pane binds a Project;
 *   Home aggregates all of them and belongs to no single one. Declaring
 *   `project: true` would make Home permanently unavailable outside a
 *   Project, which is the only place it is ever shown.
 * - **`standalone` and `docked` placements only.** Home occupies a whole
 *   route (`/` is its standalone placement), and the shell's ambient dock
 *   slot admits its canonical occurrence (`admitsAmbientDockInstance`), so
 *   the declaration says so — a region set that omitted `docked` while the
 *   dock renders Home would be a label contradicting a derivation. It is
 *   not a region inside a Layout: admitting it to `primary`/`secondary`
 *   would let a Project host place a second, Project-less aggregate of
 *   every Project beside the work it is scoped to.
 *
 * `provenance.origin: 'builtin'` is what the contract's parser uses to refuse
 * a `pluginId` here (`parseProvenance`), so a contributed Home can never
 * arrive wearing this attribution — it must declare its own.
 */
export const WORKSPACE_HOME_PANE_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_HOME_PANE_DESCRIPTOR_ID,
  name: 'Home',
  description: 'Start something focused or continue where you left off.',
  rendererId: WORKSPACE_HOME_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_HOME_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['standalone', 'docked'],
    preferredRegion: 'standalone',
  },
  modes: [{ id: 'default' }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

function instance(value: unknown): WorkspacePaneInstance {
  const parsed = parseWorkspacePaneInstance(value);
  if (!parsed) throw new Error('Invalid built-in Home Workspace Pane instance');
  return parsed;
}

/**
 * Home's single placed occurrence.
 *
 * A constant rather than a factory because there is exactly one Home per
 * Station and it binds no Project — there is no identity to parameterize it
 * with. `sourceId` still records which contribution placed it, so a
 * contributed Home occurrence is distinguishable from this one by data
 * rather than by inference.
 */
export const WORKSPACE_HOME_PANE_INSTANCE = instance({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  descriptorId: WORKSPACE_HOME_PANE_DESCRIPTOR_ID,
  instanceId: WORKSPACE_HOME_PANE_INSTANCE_ID,
  stateKey: WORKSPACE_HOME_PANE_INSTANCE_ID,
  boundContext: { sourceId: WORKSPACE_HOME_PANE_SOURCE_ID },
});

export function isCanonicalWorkspaceHomePaneInstance(
  candidate: WorkspacePaneInstance,
): boolean {
  return (
    candidate.descriptorId === WORKSPACE_HOME_PANE_DESCRIPTOR_ID &&
    candidate.instanceId === WORKSPACE_HOME_PANE_INSTANCE_ID &&
    candidate.stateKey === WORKSPACE_HOME_PANE_INSTANCE_ID &&
    candidate.boundContext?.sourceId === WORKSPACE_HOME_PANE_SOURCE_ID &&
    candidate.boundContext.projectId === undefined &&
    candidate.boundContext.taskId === undefined &&
    candidate.boundContext.sessionId === undefined &&
    candidate.boundContext.runId === undefined &&
    candidate.boundContext.workspaceId === undefined &&
    candidate.boundContext.contribution === undefined &&
    Object.keys(candidate.boundContext).length === 1
  );
}
