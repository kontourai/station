import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_ACTIVITY_PANE_DESCRIPTOR_ID = 'pane:builtin:activity';
export const WORKSPACE_ACTIVITY_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-activity';
export const WORKSPACE_ACTIVITY_PANE_RENDERER_NAME = 'workspace-activity';
export const WORKSPACE_ACTIVITY_PANE_SOURCE_ID = 'builtin:workspace-activity';
export const WORKSPACE_ACTIVITY_PANE_INSTANCE_ID = 'workspace-activity';

function descriptor(value: unknown): WorkspacePaneDescriptor {
  const parsed = parseWorkspacePaneDescriptor(value);
  if (!parsed) throw new Error('Invalid built-in Activity Workspace Pane');
  return parsed;
}

/**
 * Activity, declared as a Workspace Pane.
 *
 * "Activity" here is the SESSIONS surface — `SessionsView`: every session on
 * this host, including read-only attached external-engine ones. A proposed
 * "what happened while I was away" feed is a different product surface with
 * its own issue; it is not this pane and must not be folded into it.
 *
 * The two load-bearing declarations mirror Home's, for the same reasons:
 *
 * - **A requirement-free default mode.** The sessions list aggregates every
 *   Project's sessions and belongs to no single one — it is projectless by
 *   nature. Declaring `project: true` would make Activity permanently
 *   unavailable in every host that places it.
 * - **`docked` placement only.** Station #928 retired Activity's standalone
 *   placement: `/activity` no longer mounts anything (it redirects to the
 *   surface's canonical deep link), so the shell's dock region is the only
 *   host that places this pane. Declaring `standalone` — worse, PREFERRING
 *   it — would name a placement no host in this build supplies.
 *   `primary`/`secondary` stay excluded for their own reason: a Project host
 *   must not place a Project-less aggregate of every host session beside the
 *   work it is scoped to. The Developer archive tab embeds the renderer
 *   directly rather than through a region, so it neither needs nor
 *   contradicts an entry here.
 *
 * `provenance.origin: 'builtin'` is what the contract's parser uses to refuse
 * a `pluginId` here (`parseProvenance`), so a contributed Activity can never
 * arrive wearing this attribution — it must declare its own.
 */
export const WORKSPACE_ACTIVITY_PANE_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR_ID,
  name: 'Activity',
  description: 'Watch and talk to AI sessions across this host.',
  rendererId: WORKSPACE_ACTIVITY_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_ACTIVITY_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['docked'],
    preferredRegion: 'docked',
  },
  modes: [{ id: 'default' }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

function instance(value: unknown): WorkspacePaneInstance {
  const parsed = parseWorkspacePaneInstance(value);
  if (!parsed)
    throw new Error('Invalid built-in Activity Workspace Pane instance');
  return parsed;
}

/**
 * Activity's single placed occurrence.
 *
 * A constant rather than a factory because there is exactly one Activity per
 * Station and it binds no Project — there is no identity to parameterize it
 * with. A routed session id is PRESENTATION state of the placement that
 * delivered it (which row is selected), not pane identity, so it never
 * appears here. `sourceId` still records which contribution placed it, so a
 * contributed Activity occurrence is distinguishable from this one by data
 * rather than by inference.
 */
export const WORKSPACE_ACTIVITY_PANE_INSTANCE = instance({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  descriptorId: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR_ID,
  instanceId: WORKSPACE_ACTIVITY_PANE_INSTANCE_ID,
  stateKey: WORKSPACE_ACTIVITY_PANE_INSTANCE_ID,
  boundContext: { sourceId: WORKSPACE_ACTIVITY_PANE_SOURCE_ID },
});

export function isCanonicalWorkspaceActivityPaneInstance(
  candidate: WorkspacePaneInstance,
): boolean {
  return (
    candidate.descriptorId === WORKSPACE_ACTIVITY_PANE_DESCRIPTOR_ID &&
    candidate.instanceId === WORKSPACE_ACTIVITY_PANE_INSTANCE_ID &&
    candidate.stateKey === WORKSPACE_ACTIVITY_PANE_INSTANCE_ID &&
    candidate.boundContext?.sourceId === WORKSPACE_ACTIVITY_PANE_SOURCE_ID &&
    candidate.boundContext.projectId === undefined &&
    candidate.boundContext.taskId === undefined &&
    candidate.boundContext.sessionId === undefined &&
    candidate.boundContext.runId === undefined &&
    candidate.boundContext.workspaceId === undefined &&
    candidate.boundContext.contribution === undefined &&
    Object.keys(candidate.boundContext).length === 1
  );
}
