import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR_ID =
  'pane:builtin:task-room-editor';
export const WORKSPACE_TASK_ROOM_EDITOR_RENDERER_NAME = 'task-room-editor';
export const WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR_ID =
  'pane:builtin:task-room-chat';
export const WORKSPACE_TASK_ROOM_CHAT_RENDERER_NAME = 'workspace-chat';

function descriptor(value: unknown): WorkspacePaneDescriptor {
  const parsed = parseWorkspacePaneDescriptor(value);
  if (!parsed) throw new Error('Invalid built-in Task room Workspace Pane');
  return parsed;
}

export const WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR_ID,
  name: 'Task document',
  description: 'The Project and Task-bound collaborative document.',
  rendererId: 'renderer:builtin:builtin-component:task-room-editor',
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_TASK_ROOM_EDITOR_RENDERER_NAME,
  },
  placement: { supportedRegions: ['primary'], preferredRegion: 'primary' },
  modes: [{ id: 'default', contextRequirement: { project: true, task: true } }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});
export const WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR_ID,
  name: 'Task conversation',
  description: 'Durable Project and Task room conversation history.',
  rendererId: 'renderer:builtin:builtin-component:workspace-chat',
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_TASK_ROOM_CHAT_RENDERER_NAME,
  },
  placement: { supportedRegions: ['secondary'], preferredRegion: 'secondary' },
  modes: [{ id: 'default', contextRequirement: { project: true, task: true } }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

export function createTaskRoomWorkspacePaneInstances(
  projectId: string,
  taskId: string,
): readonly WorkspacePaneInstance[] | null {
  if (
    !projectId ||
    projectId !== projectId.trim() ||
    !taskId ||
    taskId !== taskId.trim()
  )
    return null;
  const context = { projectId, taskId, sourceId: 'builtin:project-task-room' };
  const editor = parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR_ID,
    instanceId: `task-room-editor:${taskId}`,
    stateKey: `task-room-editor:${taskId}`,
    boundContext: context,
  });
  const chat = parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR_ID,
    instanceId: `task-room-chat:${taskId}`,
    stateKey: `task-room-chat:${taskId}`,
    boundContext: context,
  });
  return editor && chat ? [editor, chat] : null;
}

export function isCanonicalTaskRoomWorkspacePaneInstance(
  projectId: string,
  taskId: string,
  instance: WorkspacePaneInstance,
): boolean {
  const instances = createTaskRoomWorkspacePaneInstances(projectId, taskId);
  return Boolean(
    instances?.some(
      (expected) =>
        expected.descriptorId === instance.descriptorId &&
        expected.instanceId === instance.instanceId &&
        expected.stateKey === instance.stateKey &&
        JSON.stringify(expected.boundContext) ===
          JSON.stringify(instance.boundContext),
    ),
  );
}
