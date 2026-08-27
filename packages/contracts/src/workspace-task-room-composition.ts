import {
  instantiateWorkspaceComposition,
  WORKSPACE_COMPOSITION_SPEC_VERSION,
} from './workspace-composition.js';
import type { WorkspacePaneHostDocumentV1 } from './workspace-pane-host.js';
import {
  createTaskRoomWorkspacePaneInstances,
  WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR,
  WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
} from './workspace-task-room.js';

export interface TaskRoomCompositionResult {
  document: WorkspacePaneHostDocumentV1 | null;
  degradedCapabilities: string[];
  reason?:
    | 'invalid-task-context'
    | 'document-read-unavailable'
    | 'admission-failed';
}

/** Public #2950 composition contract: a Task needs document read; live/write degrade. */
export function composeTaskRoomWorkspace(input: {
  projectId: string;
  taskId: string;
  layoutId: string;
  capabilities: {
    documentRead: boolean;
    documentWrite: boolean;
    roomRead: boolean;
    roomLive: boolean;
  };
}): TaskRoomCompositionResult {
  const instances = createTaskRoomWorkspacePaneInstances(
    input.projectId,
    input.taskId,
  );
  if (!instances || !input.layoutId || input.layoutId !== input.layoutId.trim())
    return {
      document: null,
      degradedCapabilities: [],
      reason: 'invalid-task-context',
    };
  const result = instantiateWorkspaceComposition({
    spec: {
      version: WORKSPACE_COMPOSITION_SPEC_VERSION,
      id: 'project-task-room',
      name: 'Project Task room',
      requiredCapabilities: [
        { id: 'room.document.read', context: 'task', grant: 'required' },
      ],
      optionalCapabilities: [
        { id: 'room.document.write', context: 'task', grant: 'required' },
        { id: 'room.history.read', context: 'task', grant: 'required' },
        { id: 'room.live', context: 'task', grant: 'required' },
      ],
      panes: [
        {
          role: 'content',
          instance: instances[0],
          requiredCapabilities: ['room.document.read'],
          optionalCapabilities: [],
          placement: {
            region: 'primary',
            order: 0,
            splitOrientation: 'vertical',
          },
        },
        {
          role: 'auxiliary',
          instance: instances[1],
          requiredCapabilities: [],
          optionalCapabilities: ['room.history.read'],
          placement: {
            region: 'secondary',
            order: 0,
            splitOrientation: 'vertical',
          },
        },
      ],
    },
    scope: {
      kind: 'task',
      projectId: input.projectId,
      taskId: input.taskId,
      layoutId: input.layoutId,
    },
    descriptors: [
      WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
      WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR,
    ],
    admittedInstances: instances,
    capabilityStates: [
      {
        id: 'room.document.read',
        context: 'task',
        available: input.capabilities.documentRead,
        granted: input.capabilities.documentRead,
      },
      {
        id: 'room.document.write',
        context: 'task',
        available: input.capabilities.documentWrite,
        granted: input.capabilities.documentWrite,
      },
      {
        id: 'room.history.read',
        context: 'task',
        available: input.capabilities.roomRead,
        granted: input.capabilities.roomRead,
      },
      {
        id: 'room.live',
        context: 'task',
        available: input.capabilities.roomLive,
        granted: input.capabilities.roomLive,
      },
    ],
  });
  return {
    document: result.document,
    degradedCapabilities: result.degradedCapabilities,
    ...(result.failure
      ? {
          reason:
            result.failure.code === 'required-capability-unavailable'
              ? ('document-read-unavailable' as const)
              : ('admission-failed' as const),
        }
      : {}),
  };
}
