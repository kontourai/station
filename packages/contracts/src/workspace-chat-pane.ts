import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_CHAT_PANE_DESCRIPTOR_ID = 'pane:builtin:chat';
export const WORKSPACE_CHAT_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-chat';
export const WORKSPACE_CHAT_PANE_RENDERER_NAME = 'workspace-chat';
export const WORKSPACE_CHAT_PANE_SOURCE_ID = 'builtin:workspace-chat';
export const WORKSPACE_CHAT_PANE_INSTANCE_ID = 'workspace-chat';

function descriptor(value: unknown): WorkspacePaneDescriptor {
  const parsed = parseWorkspacePaneDescriptor(value);
  if (!parsed) throw new Error('Invalid built-in Chat Workspace Pane');
  return parsed;
}

/**
 * Chat reads the current conversation from Station's existing session domain.
 * A conversation MAY be projectless (station#3970), so the shell-owned dock
 * must not invent a Project binding merely to place this pane — and a Project
 * layout that genuinely has one keeps it. Both occurrences are canonical; the
 * dock's is the projectless one and the layout's is bound.
 */
export const WORKSPACE_CHAT_PANE_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_CHAT_PANE_DESCRIPTOR_ID,
  name: 'Chat',
  description: 'Continue a conversation in the dock or full-screen.',
  rendererId: WORKSPACE_CHAT_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_CHAT_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['primary', 'standalone', 'docked'],
    preferredRegion: 'primary',
  },
  modes: [{ id: 'default' }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

/**
 * One occurrence, two honest shapes. Called with a Project id it issues the
 * Project-bound occurrence a layout places; called with nothing it issues the
 * shell's projectless one. It never fabricates a Project to satisfy a caller
 * that does not have one, and it never drops a Project a caller does have.
 */
export function createWorkspaceChatPaneInstance(
  projectId?: string,
): WorkspacePaneInstance | null {
  if (projectId !== undefined && (!projectId || projectId !== projectId.trim()))
    return null;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_CHAT_PANE_DESCRIPTOR.id,
    instanceId: WORKSPACE_CHAT_PANE_INSTANCE_ID,
    stateKey: WORKSPACE_CHAT_PANE_INSTANCE_ID,
    boundContext: {
      ...(projectId === undefined ? {} : { projectId }),
      sourceId: WORKSPACE_CHAT_PANE_SOURCE_ID,
    },
  });
}

/**
 * Canonical in either shape. `projectId` is the ONLY optional member: present
 * it must be a non-blank trimmed id, absent it means the shell's projectless
 * occurrence. Every other context member stays forbidden, and the key count is
 * pinned so a member added to the type without a decision here is rejected
 * rather than silently accepted.
 */
export function isCanonicalWorkspaceChatPaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  const context = instance.boundContext;
  if (
    instance.descriptorId !== WORKSPACE_CHAT_PANE_DESCRIPTOR.id ||
    instance.instanceId !== WORKSPACE_CHAT_PANE_INSTANCE_ID ||
    instance.stateKey !== WORKSPACE_CHAT_PANE_INSTANCE_ID ||
    context?.sourceId !== WORKSPACE_CHAT_PANE_SOURCE_ID ||
    context.workspaceId !== undefined ||
    context.taskId !== undefined ||
    context.sessionId !== undefined ||
    context.runId !== undefined ||
    context.layoutId !== undefined
  )
    return false;
  if (context.projectId === undefined) return Object.keys(context).length === 1;
  return (
    typeof context.projectId === 'string' &&
    context.projectId.length > 0 &&
    context.projectId === context.projectId.trim() &&
    Object.keys(context).length === 2
  );
}
