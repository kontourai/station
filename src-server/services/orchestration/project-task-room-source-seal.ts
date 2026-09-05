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
  db.exec(`CREATE TABLE IF NOT EXISTS project_task_room_execution_bindings (
    session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_room_execution_bindings_scope
    ON project_task_room_execution_bindings(project_id,task_id)`);
}

/** Server-only immutable association; metadata and slugs never create it. */
export function bindProjectTaskRoomExecution(
  db: SealDatabase,
  input: { projectId: string; taskId: string; sessionId: string },
): { kind: 'bound' | 'conflict' | 'unavailable' } {
  if (
    !Object.values(input).every(
      (value) =>
        typeof value === 'string' &&
        value.length > 0 &&
        Buffer.byteLength(value) <= 256,
    )
  )
    return { kind: 'unavailable' };
  try {
    db.exec('BEGIN IMMEDIATE');
    const prior = db
      .prepare(
        'SELECT project_id,task_id FROM project_task_room_execution_bindings WHERE session_id=?',
      )
      .get(input.sessionId) as
      | { project_id: string; task_id: string }
      | undefined;
    if (prior) {
      db.exec('ROLLBACK');
      return {
        kind:
          prior.project_id === input.projectId && prior.task_id === input.taskId
            ? 'bound'
            : 'conflict',
      };
    }
    if (
      readProjectTaskRoomSourceSeal(db, input) ||
      !db
        .prepare(
          'SELECT 1 FROM project_task_room_heads WHERE project_id=? AND task_id=?',
        )
        .get(input.projectId, input.taskId) ||
      db
        .prepare(
          'SELECT 1 FROM orchestration_turn_boundaries WHERE thread_id=? LIMIT 1',
        )
        .get(input.sessionId)
    ) {
      db.exec('ROLLBACK');
      return { kind: 'unavailable' };
    }
    db.prepare(
      'INSERT INTO project_task_room_execution_bindings(session_id,project_id,task_id) VALUES(?,?,?)',
    ).run(input.sessionId, input.projectId, input.taskId);
    db.exec('COMMIT');
    return { kind: 'bound' };
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {}
    return { kind: 'unavailable' };
  }
}

/** Called inside the existing durable provider-admission transaction. */
export function isProjectTaskRoomExecutionSealed(
  db: SealDatabase,
  sessionId: string,
): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM project_task_room_execution_bindings b
    INNER JOIN project_task_room_source_seals s ON s.project_id=b.project_id AND s.task_id=b.task_id
    WHERE b.session_id=?`)
      .get(sessionId),
  );
}

/** Reuses provider-boundary truth; no duplicate execution state machine. */
export function hasPendingProjectTaskRoomExecution(
  db: SealDatabase,
  scope: { projectId: string; taskId: string },
): boolean {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='orchestration_turn_boundaries'",
      )
      .get()
  )
    return false;
  return Boolean(
    db
      .prepare(`SELECT 1 FROM orchestration_turn_boundaries t
    INNER JOIN project_task_room_execution_bindings b ON b.session_id=t.thread_id
    WHERE b.project_id=? AND b.task_id=? LIMIT 1`)
      .get(scope.projectId, scope.taskId),
  );
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
