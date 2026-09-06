import type { ProjectTaskRoomCheckpoint } from '@kontourai/station-contracts/project-task-room';

/** Private source-side barrier. This receipt grants no target authority. */
export interface ProjectTaskRoomSourceSeal {
  operationId: string;
  sourceHomeRef: string;
  targetHomeRef: string;
  checkpoint: ProjectTaskRoomCheckpoint;
  workingStateDigest: string;
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
  db.exec(`CREATE TABLE IF NOT EXISTS project_task_room_seal_state (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL, working_state_digest TEXT NOT NULL,
    PRIMARY KEY(project_id,task_id)
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
      const kind =
        prior.project_id !== input.projectId || prior.task_id !== input.taskId
          ? 'conflict'
          : readProjectTaskRoomSourceSeal(db, input)
            ? 'unavailable'
            : 'bound';
      db.exec('ROLLBACK');
      return { kind };
    }
    if (
      readProjectTaskRoomSourceSeal(db, input) ||
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
    .prepare(`SELECT
    CASE WHEN length(CAST(operation_id AS BLOB)) <= 1024 THEN operation_id END AS operationId,
    CASE WHEN length(CAST(source_home_ref AS BLOB)) <= 1024 THEN source_home_ref END AS sourceHomeRef,
    CASE WHEN length(CAST(target_home_ref AS BLOB)) <= 1024 THEN target_home_ref END AS targetHomeRef,
    CASE WHEN length(CAST(checkpoint_json AS BLOB)) <= 4096 THEN checkpoint_json END AS checkpointJson
    , (SELECT CASE WHEN length(working_state_digest)=64 THEN working_state_digest END
       FROM project_task_room_seal_state d WHERE d.project_id=s.project_id AND d.task_id=s.task_id) AS workingStateDigest
    FROM project_task_room_source_seals s
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
  db.prepare(
    'INSERT INTO project_task_room_seal_state(project_id,task_id,working_state_digest) VALUES(?,?,?)',
  ).run(scope.projectId, scope.taskId, seal.workingStateDigest);
}
