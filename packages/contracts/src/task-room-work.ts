export const TASK_ROOM_WORK_VERSION = 'station.task-room-work/v1' as const;

export interface TaskRoomWorkInput {
  operationId: string;
  agentId: string;
  prompt: string;
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
}

export type TaskRoomWorkList =
  | { kind: 'available'; records: TaskRoomWorkRecord[] }
  | { kind: 'refused' };

export type TaskRoomWorkOutcome =
  | { kind: 'recorded'; record: TaskRoomWorkRecord; replayed: boolean }
  | { kind: 'refused'; reason: 'access' | 'conflict' | 'capacity' | 'input' };
