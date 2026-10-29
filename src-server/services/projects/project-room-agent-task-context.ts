import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import type { ProjectSharedTaskSummary } from '@kontourai/station-contracts/project-shared-task';
import { TASK_STATUSES } from '@kontourai/station-contracts/task-graph';
import { z } from 'zod/v3';
import type { ProjectSharedTaskReference } from './project-shared-task-service.js';

export const ROOM_TASK_CONTEXT_LIMITS = { items: 16, bytes: 4096 } as const;
export const roomTaskSnapshotSchema = z
  .object({
    version: z.literal(1),
    observedAt: z.string().datetime(),
    project: z
      .object({
        stationId: z.string().min(1).max(256),
        localProjectId: z.string().min(1).max(256),
        localProjectSlug: z.string().min(1).max(256),
        portableProjectId: z.string().min(1).max(256),
      })
      .strict(),
    coverage: z.enum([
      'shared_subset',
      'bounded_subset',
      'unavailable',
      'omitted_budget',
    ]),
    items: z
      .array(
        z
          .object({
            shareId: z.string().min(1).max(256),
            taskId: z.string().min(1).max(256),
            taskCreatedAt: z.string().min(1).max(64),
            title: z.string().min(1).max(240),
            status: z.enum(TASK_STATUSES),
          })
          .strict(),
      )
      .max(ROOM_TASK_CONTEXT_LIMITS.items),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      Buffer.byteLength(JSON.stringify(value)) >
        ROOM_TASK_CONTEXT_LIMITS.bytes ||
      (['unavailable', 'omitted_budget'].includes(value.coverage) &&
        value.items.length) ||
      new Set(value.items.map((item) => item.taskId)).size !==
        value.items.length
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid Room Task evidence',
      });
  });
export type RoomTaskSnapshot = z.infer<typeof roomTaskSnapshotSchema>;
export interface ProjectRoomTaskContext {
  capture(): Promise<readonly ProjectSharedTaskSummary[] | null>;
  refresh(snapshot: RoomTaskSnapshot): Promise<void>;
  assertCurrent(snapshot: RoomTaskSnapshot): void;
  withCurrent<T>(snapshot: RoomTaskSnapshot, operation: () => T): Promise<T>;
}
export function roomTaskReferences(
  snapshot: RoomTaskSnapshot,
): ProjectSharedTaskReference[] {
  return snapshot.items.map((item) => ({
    project: snapshot.project,
    shareId: item.shareId,
    task: {
      id: item.taskId,
      createdAt: item.taskCreatedAt,
    },
  }));
}
export function sameRoomTaskScope(
  a: ProjectMembershipScope,
  b: ProjectMembershipScope,
): boolean {
  return (
    a.stationId === b.stationId &&
    a.localProjectId === b.localProjectId &&
    a.localProjectSlug === b.localProjectSlug &&
    a.portableProjectId === b.portableProjectId
  );
}
