import { createHash } from 'node:crypto';

/** One canonical Project/Task document identity shared by room and evidence. */
export function projectTaskRoomDocumentId(scope: {
  readonly projectId: string;
  readonly taskId: string;
}): string {
  return `project-task-document-v1:${createHash('sha256')
    .update(`${scope.projectId}\u0000${scope.taskId}`)
    .digest('hex')}`;
}

/** Exact durable proposal identity for the revision published by one edit. */
export function projectTaskRoomRevisionPublicationId(intentId: string): string {
  return `revision-publication:${intentId}`;
}
