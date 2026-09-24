import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_AGENTS_PANE_DESCRIPTOR_ID =
  'pane:builtin:workspace-agents';
export const WORKSPACE_AGENTS_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-agents';
export const WORKSPACE_AGENTS_PANE_RENDERER_NAME = 'workspace-agents';
export const WORKSPACE_AGENTS_PANE_SOURCE_ID = 'builtin:workspace-agents';
export const WORKSPACE_AGENTS_PANE_INSTANCE_ID = 'workspace-agents';

function descriptor(value: unknown): WorkspacePaneDescriptor {
  const parsed = parseWorkspacePaneDescriptor(value);
  if (!parsed) throw new Error('Invalid built-in Agents Workspace Pane');
  return parsed;
}

/**
 * Agents, declared as a Workspace Pane (#2050).
 *
 * The work the conversation on screen set running — its tool calls, its
 * delegated sessions and its engine subagents — or, in its "All" scope
 * (#2459), every conversation's child work, including a delegate started
 * from the CLI with no chat open. Child work renders from the
 * provider-neutral child-work contract, so it reads the same whatever engine
 * reported it; tool calls keep the sheet's row. Which scope it shows is
 * display state, not pane identity.
 *
 * Two declarations carry the design, both Activity's for Activity's reasons:
 *
 * - **A requirement-free default mode.** The list is keyed by the ACTIVE
 *   CONVERSATION, which is navigation state rather than pane identity — the
 *   same fact that keeps a routed session id out of Activity's instance.
 *   Declaring `project: true` would bind an occurrence to a Project the list
 *   does not read.
 * - **`docked` placement only.** A conversation's background work belongs
 *   beside that conversation; there is no route that mounts it, and a
 *   Project host must not place a list scoped to whichever chat happens to be
 *   open.
 */
export const WORKSPACE_AGENTS_PANE_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_AGENTS_PANE_DESCRIPTOR_ID,
  name: 'Agents',
  description: 'Watch the agent work your conversations set running.',
  rendererId: WORKSPACE_AGENTS_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_AGENTS_PANE_RENDERER_NAME,
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
    throw new Error('Invalid built-in Agents Workspace Pane instance');
  return parsed;
}

/**
 * The Agents pane's single placed occurrence — a constant for the same reason
 * Activity's is: one per Station, binding nothing. Which conversation's work
 * it shows is what the pane READS, not what it IS.
 */
export const WORKSPACE_AGENTS_PANE_INSTANCE = instance({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  descriptorId: WORKSPACE_AGENTS_PANE_DESCRIPTOR_ID,
  instanceId: WORKSPACE_AGENTS_PANE_INSTANCE_ID,
  stateKey: WORKSPACE_AGENTS_PANE_INSTANCE_ID,
  boundContext: { sourceId: WORKSPACE_AGENTS_PANE_SOURCE_ID },
});

export function isCanonicalWorkspaceAgentsPaneInstance(
  candidate: WorkspacePaneInstance,
): boolean {
  return (
    candidate.descriptorId === WORKSPACE_AGENTS_PANE_DESCRIPTOR_ID &&
    candidate.instanceId === WORKSPACE_AGENTS_PANE_INSTANCE_ID &&
    candidate.stateKey === WORKSPACE_AGENTS_PANE_INSTANCE_ID &&
    candidate.boundContext?.sourceId === WORKSPACE_AGENTS_PANE_SOURCE_ID &&
    candidate.boundContext.projectId === undefined &&
    candidate.boundContext.taskId === undefined &&
    candidate.boundContext.sessionId === undefined &&
    candidate.boundContext.runId === undefined &&
    candidate.boundContext.workspaceId === undefined &&
    candidate.boundContext.contribution === undefined &&
    Object.keys(candidate.boundContext).length === 1
  );
}
