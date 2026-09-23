import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

/**
 * The built-in "Plugin preview" Workspace Pane (epic #2323 S3): shows the
 * draft plugin built from this Project's folder, and runs one of its panes
 * only when the viewing person explicitly chooses to. The descriptor grants
 * nothing; the draft's code never runs because this pane was opened.
 */

export const WORKSPACE_PLUGIN_DRAFT_PANE_DESCRIPTOR_ID =
  'pane:builtin:workspace-preview:plugin-draft';
export const WORKSPACE_PLUGIN_DRAFT_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-plugin-draft';
export const WORKSPACE_PLUGIN_DRAFT_PANE_RENDERER_NAME =
  'workspace-plugin-draft';
export const WORKSPACE_PLUGIN_DRAFT_PANE_SOURCE_ID =
  'builtin:workspace-plugin-draft';
export const WORKSPACE_PLUGIN_DRAFT_PANE_INSTANCE_ID = 'workspace-plugin-draft';

const parsedDescriptor = parseWorkspacePaneDescriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_PLUGIN_DRAFT_PANE_DESCRIPTOR_ID,
  name: 'Plugin preview',
  description:
    'Preview the plugin being written in this Project’s folder, without installing it.',
  rendererId: WORKSPACE_PLUGIN_DRAFT_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_PLUGIN_DRAFT_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['primary', 'secondary', 'standalone'],
    preferredRegion: 'secondary',
  },
  modes: [{ id: 'default', contextRequirement: { project: true } }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

if (!parsedDescriptor) {
  throw new Error('Canonical Plugin preview pane descriptor must be valid');
}

export const WORKSPACE_PLUGIN_DRAFT_PANE_DESCRIPTOR: WorkspacePaneDescriptor =
  parsedDescriptor;

/** The one Project-bound occurrence of the Plugin preview pane. */
export function createWorkspacePluginDraftPaneInstance(
  projectId: string,
): WorkspacePaneInstance | null {
  if (!projectId || projectId !== projectId.trim()) return null;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_PLUGIN_DRAFT_PANE_DESCRIPTOR_ID,
    instanceId: WORKSPACE_PLUGIN_DRAFT_PANE_INSTANCE_ID,
    stateKey: WORKSPACE_PLUGIN_DRAFT_PANE_INSTANCE_ID,
    boundContext: {
      projectId,
      workspaceId: projectId,
      sourceId: WORKSPACE_PLUGIN_DRAFT_PANE_SOURCE_ID,
    },
  });
}

export function isCanonicalWorkspacePluginDraftPaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  const context = instance.boundContext;
  return (
    instance.descriptorId === WORKSPACE_PLUGIN_DRAFT_PANE_DESCRIPTOR_ID &&
    instance.instanceId === WORKSPACE_PLUGIN_DRAFT_PANE_INSTANCE_ID &&
    instance.stateKey === WORKSPACE_PLUGIN_DRAFT_PANE_INSTANCE_ID &&
    typeof context?.projectId === 'string' &&
    context.projectId.length > 0 &&
    context.projectId === context.projectId.trim() &&
    context.workspaceId === context.projectId &&
    context.sourceId === WORKSPACE_PLUGIN_DRAFT_PANE_SOURCE_ID &&
    context.taskId === undefined &&
    context.sessionId === undefined &&
    context.runId === undefined &&
    (context.layoutId === undefined ||
      (typeof context.layoutId === 'string' &&
        context.layoutId.length > 0 &&
        context.layoutId === context.layoutId.trim()))
  );
}
