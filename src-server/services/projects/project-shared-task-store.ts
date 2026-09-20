import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';

export interface ProjectSharedTaskAdmission {
  shareId: string;
  scope: ProjectMembershipScope;
  taskId: string;
  taskCreatedAt: string;
  sharedAt: string;
  sharedBy: string;
}
export class ProjectSharedTaskRefusal extends Error {
  constructor(readonly code: 'conflict' | 'not-found' | 'unavailable') {
    super(`Project shared Task ${code}.`);
  }
}
export class ProjectSharedTaskStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS project_shared_tasks (share_id TEXT PRIMARY KEY, station_id TEXT NOT NULL, local_project_id TEXT NOT NULL, local_project_slug TEXT NOT NULL, portable_project_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, task_created_at TEXT NOT NULL, shared_at TEXT NOT NULL, shared_by TEXT NOT NULL) STRICT;`,
    );
  }
  share(input: Omit<ProjectSharedTaskAdmission, 'shareId' | 'sharedAt'>) {
    const existing = this.admission(input.taskId);
    if (existing) {
      if (sameAdmission(existing, input)) return existing;
      throw new ProjectSharedTaskRefusal('conflict');
    }
    const record: ProjectSharedTaskAdmission = {
      ...structuredClone(input),
      shareId: randomUUID(),
      sharedAt: new Date(this.now()).toISOString(),
    };
    try {
      this.db
        .prepare('INSERT INTO project_shared_tasks VALUES (?,?,?,?,?,?,?,?,?)')
        .run(
          record.shareId,
          record.scope.stationId,
          record.scope.localProjectId,
          record.scope.localProjectSlug,
          record.scope.portableProjectId,
          record.taskId,
          record.taskCreatedAt,
          record.sharedAt,
          record.sharedBy,
        );
      return structuredClone(record);
    } catch {
      throw new ProjectSharedTaskRefusal('unavailable');
    }
  }
  unshare(taskId: string, expectedShareId: string): void {
    const result = this.db
      .prepare(
        'DELETE FROM project_shared_tasks WHERE task_id=? AND share_id=?',
      )
      .run(taskId, expectedShareId);
    if (result.changes !== 1) throw new ProjectSharedTaskRefusal('conflict');
  }
  admission(taskId: string): ProjectSharedTaskAdmission | undefined {
    const row = this.db
      .prepare('SELECT * FROM project_shared_tasks WHERE task_id=?')
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? parse(row) : undefined;
  }
  list(scope: ProjectMembershipScope): ProjectSharedTaskAdmission[] {
    return [
      ...this.db
        .prepare(
          'SELECT * FROM project_shared_tasks WHERE station_id=? AND local_project_id=? AND local_project_slug=? AND portable_project_id=? ORDER BY task_id',
        )
        .iterate(
          scope.stationId,
          scope.localProjectId,
          scope.localProjectSlug,
          scope.portableProjectId,
        ),
    ].map((row) => parse(row as Record<string, unknown>));
  }
}
function parse(row: Record<string, unknown>): ProjectSharedTaskAdmission {
  const keys = [
    'share_id',
    'station_id',
    'local_project_id',
    'local_project_slug',
    'portable_project_id',
    'task_id',
    'task_created_at',
    'shared_at',
    'shared_by',
  ];
  if (keys.some((key) => typeof row[key] !== 'string' || !(row[key] as string)))
    throw new ProjectSharedTaskRefusal('unavailable');
  return {
    shareId: row.share_id as string,
    scope: {
      stationId: row.station_id as string,
      localProjectId: row.local_project_id as string,
      localProjectSlug: row.local_project_slug as string,
      portableProjectId: row.portable_project_id as string,
    },
    taskId: row.task_id as string,
    taskCreatedAt: row.task_created_at as string,
    sharedAt: row.shared_at as string,
    sharedBy: row.shared_by as string,
  };
}
function sameAdmission(
  left: ProjectSharedTaskAdmission,
  right: Omit<ProjectSharedTaskAdmission, 'shareId' | 'sharedAt'>,
) {
  return (
    left.taskId === right.taskId &&
    left.taskCreatedAt === right.taskCreatedAt &&
    left.sharedBy === right.sharedBy &&
    Object.keys(left.scope).every(
      (key) =>
        left.scope[key as keyof ProjectMembershipScope] ===
        right.scope[key as keyof ProjectMembershipScope],
    )
  );
}
