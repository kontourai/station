import { createHash } from 'node:crypto';
import {
  TASK_ROOM_CONTEXT_VERSION,
  type TaskRoomContextSnapshot,
} from '@kontourai/station-contracts/task-room-work';

type Scope = { taskId: string; projectId: string; taskCreatedAt: string };
type TaskRoomContextSource = Pick<
  TaskRoomContextSnapshot,
  'title' | 'description' | 'documentRevision' | 'text'
>;
function validSource(value: unknown): value is TaskRoomContextSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.title === 'string' &&
    source.title.length > 0 &&
    source.title.length <= 512 &&
    typeof source.description === 'string' &&
    source.description.length <= 12000 &&
    typeof source.documentRevision === 'string' &&
    source.documentRevision.length > 0 &&
    source.documentRevision.length <= 256 &&
    typeof source.text === 'string' &&
    source.text.length <= 16000
  );
}
export function createTaskRoomContext(
  scope: Scope,
  source: TaskRoomContextSource,
): TaskRoomContextSnapshot | undefined {
  if (!validSource(source)) return undefined;
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        TASK_ROOM_CONTEXT_VERSION,
        scope.projectId,
        scope.taskId,
        scope.taskCreatedAt,
        source.title,
        source.description,
        source.documentRevision,
        source.text,
      ]),
    )
    .digest('hex');
  return Object.freeze({
    version: TASK_ROOM_CONTEXT_VERSION,
    digest,
    title: source.title,
    description: source.description,
    documentRevision: source.documentRevision,
    text: source.text,
  });
}
export function validTaskRoomContext(
  value: unknown,
  scope: Scope,
): value is TaskRoomContextSnapshot {
  if (!validSource(value)) return false;
  const row = value as TaskRoomContextSnapshot;
  return (
    Object.keys(row).length === 6 &&
    row.version === TASK_ROOM_CONTEXT_VERSION &&
    row.digest === createTaskRoomContext(scope, row)?.digest
  );
}
