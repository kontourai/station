export const TASK_ROOM_WORK_VERSION = 'station.task-room-work/v1' as const;

export const TASK_ROOM_CONTEXT_VERSION =
  'station.task-room-context/v1' as const;
export interface TaskRoomContextReference {
  version: typeof TASK_ROOM_CONTEXT_VERSION;
  digest: string;
}
export interface TaskRoomContextSnapshot extends TaskRoomContextReference {
  title: string;
  description: string;
  documentRevision: string;
  text: string;
}

export interface TaskRoomWorkInput {
  operationId: string;
  agentId: string;
  prompt: string;
  context?: TaskRoomContextReference;
}

export interface TaskRoomWorkRecord {
  version: typeof TASK_ROOM_WORK_VERSION;
  taskId: string;
  projectId: string;
  taskCreatedAt: string;
  operationId: string;
  // A server-issued Task-scoped display identity, not an account or grant.
  requesterId: string;
  agentId: string;
  prompt: string;
  sessionId: string;
  createdAt: string;
  state: 'starting' | 'dispatched' | 'indeterminate' | 'refused';
  context?: TaskRoomContextSnapshot;
}

export type TaskRoomWorkList =
  | {
      kind: 'available';
      records: TaskRoomWorkRecord[];
      context?: TaskRoomContextSnapshot | null;
      contextVersion?: typeof TASK_ROOM_CONTEXT_VERSION;
    }
  | { kind: 'refused' };

export type TaskRoomWorkOutcome =
  | { kind: 'recorded'; record: TaskRoomWorkRecord; replayed: boolean }
  | {
      kind: 'refused';
      reason: 'access' | 'conflict' | 'capacity' | 'input' | 'context';
    };
