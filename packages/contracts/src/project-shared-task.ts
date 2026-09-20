import type { ProjectMembershipScope } from './project-membership.js';
import type { TaskStatus } from './task-graph.js';

export const PROJECT_SHARED_TASK_VERSION =
  'station.shared-project-task/v1' as const;
export interface ProjectSharedTaskSummary {
  version: typeof PROJECT_SHARED_TASK_VERSION;
  project: ProjectMembershipScope;
  task: { id: string; title: string; status: TaskStatus; createdAt: string };
  shareId: string;
  sharedAt: string;
}
export interface ProjectSharedTaskHumanMessage {
  actor: { kind: 'human' | 'agent'; label: string };
  sequence: number;
  body: { kind: 'human-message'; text: string };
  digests: { proposal: string; checkpoint: string };
  integrity: 'L0';
}
export type ProjectSharedTaskHistory =
  | {
      kind: 'available';
      records: readonly ProjectSharedTaskHumanMessage[];
      checkpoint: {
        throughSeq: number;
        checkpointDigest: string;
        retainedAnchorSeq: number;
        retainedAnchorDigest: string;
      };
      hasMore: boolean;
      nextCursor?: string;
    }
  | { kind: 'gap' | 'stale' | 'invalid-cursor' | 'not-found' | 'unavailable' };
export type ProjectSharedTaskDocument =
  | {
      kind: 'snapshot';
      project: { id: string; slug: string };
      task: { id: string; createdAt: string };
      revision: string;
      text: string;
    }
  | { kind: 'not-found' | 'unavailable' };
