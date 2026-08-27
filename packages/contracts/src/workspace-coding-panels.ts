import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID =
  'pane:builtin:coding:file-browser';
export const WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-coding-file-browser';
export const WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_NAME =
  'workspace-coding-file-browser';
export const WORKSPACE_CODING_FILE_BROWSER_PANE_SOURCE_ID =
  'builtin:workspace-coding-file-browser';
export const WORKSPACE_CODING_FILE_BROWSER_PANE_INSTANCE_ID =
  'workspace-coding-file-browser';

export const WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID =
  'pane:builtin:coding:diff';
export const WORKSPACE_CODING_DIFF_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-coding-diff';
export const WORKSPACE_CODING_DIFF_PANE_RENDERER_NAME = 'workspace-coding-diff';
export const WORKSPACE_CODING_DIFF_PANE_SOURCE_ID =
  'builtin:workspace-coding-diff';
export const WORKSPACE_CODING_DIFF_PANE_INSTANCE_ID = 'workspace-coding-diff';

export const WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID =
  'pane:builtin:coding:terminal';
export const WORKSPACE_CODING_TERMINAL_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-coding-terminal';
export const WORKSPACE_CODING_TERMINAL_PANE_RENDERER_NAME =
  'workspace-coding-terminal';
export const WORKSPACE_CODING_TERMINAL_PANE_SOURCE_ID =
  'builtin:workspace-coding-terminal';
export const WORKSPACE_CODING_TERMINAL_PANE_INSTANCE_ID =
  'workspace-coding-terminal';

function descriptor(value: unknown): WorkspacePaneDescriptor {
  const parsed = parseWorkspacePaneDescriptor(value);
  if (!parsed) throw new Error('Invalid built-in coding Workspace Pane');
  return parsed;
}

export const WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
  name: 'Files',
  description: 'Browse and act on files in the Project workspace.',
  rendererId: WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['primary', 'secondary', 'standalone'],
    preferredRegion: 'primary',
  },
  modes: [
    {
      id: 'default',
      contextRequirement: { project: true, source: true, workspace: true },
    },
  ],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

export const WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID,
  name: 'Diff',
  description: 'Review the current Git diff and its inline comments.',
  rendererId: WORKSPACE_CODING_DIFF_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_CODING_DIFF_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['primary', 'secondary', 'standalone'],
    preferredRegion: 'primary',
  },
  modes: [
    {
      id: 'default',
      contextRequirement: { project: true, source: true, workspace: true },
    },
  ],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

export const WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID,
  name: 'Terminal',
  description: 'Run and inspect terminal tabs in the Project workspace.',
  rendererId: WORKSPACE_CODING_TERMINAL_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_CODING_TERMINAL_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['primary', 'secondary', 'standalone'],
    preferredRegion: 'secondary',
  },
  modes: [
    {
      id: 'default',
      contextRequirement: { project: true, source: true, workspace: true },
    },
  ],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

function fixedCodingPaneInstance(
  projectId: string,
  descriptorId: string,
  instanceId: string,
  sourceId: string,
): WorkspacePaneInstance | null {
  if (!projectId || projectId !== projectId.trim()) return null;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId,
    instanceId,
    stateKey: instanceId,
    boundContext: { projectId, sourceId },
  });
}

export function createWorkspaceCodingFileBrowserPaneInstance(
  projectId: string,
): WorkspacePaneInstance | null {
  if (!projectId || projectId !== projectId.trim()) return null;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR.id,
    instanceId: WORKSPACE_CODING_FILE_BROWSER_PANE_INSTANCE_ID,
    stateKey: WORKSPACE_CODING_FILE_BROWSER_PANE_INSTANCE_ID,
    boundContext: {
      projectId,
      workspaceId: projectId,
      sourceId: WORKSPACE_CODING_FILE_BROWSER_PANE_SOURCE_ID,
    },
  });
}

export function createWorkspaceCodingDiffPaneInstance(
  projectId: string,
): WorkspacePaneInstance | null {
  if (!projectId || projectId !== projectId.trim()) return null;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR.id,
    instanceId: WORKSPACE_CODING_DIFF_PANE_INSTANCE_ID,
    stateKey: WORKSPACE_CODING_DIFF_PANE_INSTANCE_ID,
    boundContext: {
      projectId,
      workspaceId: projectId,
      sourceId: WORKSPACE_CODING_DIFF_PANE_SOURCE_ID,
    },
  });
}

export function createWorkspaceCodingTerminalPaneInstance(
  projectId: string,
): WorkspacePaneInstance | null {
  return fixedCodingPaneInstance(
    projectId,
    WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR.id,
    WORKSPACE_CODING_TERMINAL_PANE_INSTANCE_ID,
    WORKSPACE_CODING_TERMINAL_PANE_SOURCE_ID,
  );
}

function isCanonicalFixedCodingPaneInstance(
  instance: WorkspacePaneInstance,
  descriptorId: string,
  instanceId: string,
  sourceId: string,
): boolean {
  const context = instance.boundContext;
  return (
    instance.descriptorId === descriptorId &&
    instance.instanceId === instanceId &&
    instance.stateKey === instanceId &&
    isCanonicalProjectContext(context) &&
    context.sourceId === sourceId &&
    (context.workspaceId === undefined ||
      context.workspaceId === context.projectId) &&
    context.taskId === undefined &&
    context.sessionId === undefined &&
    context.runId === undefined &&
    Object.keys(context).length ===
      (context.workspaceId === undefined ? 2 : 3) +
        (context.layoutId === undefined ? 0 : 1)
  );
}

function isCanonicalProjectContext(
  context: WorkspacePaneInstance['boundContext'],
): context is NonNullable<WorkspacePaneInstance['boundContext']> {
  return (
    typeof context?.projectId === 'string' &&
    context.projectId.length > 0 &&
    context.projectId === context.projectId.trim() &&
    (context.layoutId === undefined ||
      (typeof context.layoutId === 'string' &&
        context.layoutId.length > 0 &&
        context.layoutId === context.layoutId.trim()))
  );
}

export function isCanonicalWorkspaceCodingFileBrowserPaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  return isCanonicalFixedCodingPaneInstance(
    instance,
    WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR.id,
    WORKSPACE_CODING_FILE_BROWSER_PANE_INSTANCE_ID,
    WORKSPACE_CODING_FILE_BROWSER_PANE_SOURCE_ID,
  );
}

export function isCanonicalWorkspaceCodingDiffPaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  return isCanonicalFixedCodingPaneInstance(
    instance,
    WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR.id,
    WORKSPACE_CODING_DIFF_PANE_INSTANCE_ID,
    WORKSPACE_CODING_DIFF_PANE_SOURCE_ID,
  );
}

export function isCanonicalWorkspaceCodingTerminalPaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  return isCanonicalFixedCodingPaneInstance(
    instance,
    WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR.id,
    WORKSPACE_CODING_TERMINAL_PANE_INSTANCE_ID,
    WORKSPACE_CODING_TERMINAL_PANE_SOURCE_ID,
  );
}
