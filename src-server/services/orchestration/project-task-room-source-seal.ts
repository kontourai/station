import type { ProjectTaskRoomCheckpoint } from '@kontourai/station-contracts/project-task-room';

/** Private source-side barrier. This receipt grants no target authority. */
export interface ProjectTaskRoomSourceSeal {
  operationId: string;
  sourceHomeRef: string;
  targetHomeRef: string;
  checkpoint: ProjectTaskRoomCheckpoint;
}

interface SealDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: string[]): unknown;
    run(...values: string[]): unknown;
  };
}

/** Both room workers install and consult the same table in their shared DB. */
export function initializeProjectTaskRoomSourceSeals(db: SealDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS project_task_room_source_seals (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL,
    operation_id TEXT NOT NULL, source_home_ref TEXT NOT NULL,
    target_home_ref TEXT NOT NULL, checkpoint_json TEXT NOT NULL,
    PRIMARY KEY(project_id, task_id)
  )`);
}

export function readProjectTaskRoomSourceSeal(
  db: SealDatabase,
  scope: { projectId: string; taskId: string },
): unknown {
  return db
    .prepare(`SELECT operation_id AS operationId,
    source_home_ref AS sourceHomeRef, target_home_ref AS targetHomeRef,
    checkpoint_json AS checkpointJson FROM project_task_room_source_seals
    WHERE project_id=? AND task_id=?`)
    .get(scope.projectId, scope.taskId);
}

/** Caller holds BEGIN IMMEDIATE; there is deliberately no unseal operation. */
export function persistProjectTaskRoomSourceSeal(
  db: SealDatabase,
  scope: { projectId: string; taskId: string },
  seal: ProjectTaskRoomSourceSeal,
): void {
  db.prepare(`INSERT INTO project_task_room_source_seals
    (project_id,task_id,operation_id,source_home_ref,target_home_ref,checkpoint_json)
    VALUES(?,?,?,?,?,?)`).run(
    scope.projectId,
    scope.taskId,
    seal.operationId,
    seal.sourceHomeRef,
    seal.targetHomeRef,
    JSON.stringify(seal.checkpoint),
  );
}
