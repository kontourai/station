import type { DatabaseSync } from 'node:sqlite';

export const changeDefinitions = [
  "CREATE TABLE agent_steps_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('effect','approval')), id TEXT NOT NULL) STRICT",
  'CREATE INDEX agent_steps_changes_turn ON agent_steps_changes(turn_id,seq)',
  "CREATE TRIGGER agent_steps_changes_no_update BEFORE UPDATE ON agent_steps_changes BEGIN SELECT RAISE(ABORT,'immutable agent change'); END",
  "CREATE TRIGGER agent_steps_changes_no_delete BEFORE DELETE ON agent_steps_changes BEGIN SELECT RAISE(ABORT,'immutable agent change'); END",
  ...(['effect', 'approval'] as const).flatMap((kind) => {
    const table =
      kind === 'effect' ? 'agent_steps_effects' : 'agent_steps_approvals';
    return [
      `CREATE TRIGGER agent_steps_track_${kind}_insert AFTER INSERT ON ${table} BEGIN INSERT INTO agent_steps_changes(turn_id,kind,id) VALUES(NEW.turn_id,'${kind}',NEW.id); END`,
      `CREATE TRIGGER agent_steps_track_${kind}_update AFTER UPDATE ON ${table} WHEN NEW.record IS NOT OLD.record OR NEW.turn_id IS NOT OLD.turn_id OR NEW.id IS NOT OLD.id${kind === 'approval' ? ' OR NEW.tool_id IS NOT OLD.tool_id' : ''} BEGIN INSERT INTO agent_steps_changes(turn_id,kind,id) VALUES(NEW.turn_id,'${kind}',NEW.id); INSERT INTO agent_steps_changes(turn_id,kind,id) SELECT OLD.turn_id,'${kind}',OLD.id WHERE NEW.turn_id IS NOT OLD.turn_id OR NEW.id IS NOT OLD.id; END`,
      `CREATE TRIGGER agent_steps_track_${kind}_delete AFTER DELETE ON ${table} BEGIN INSERT INTO agent_steps_changes(turn_id,kind,id) VALUES(OLD.turn_id,'${kind}',OLD.id); END`,
    ];
  }),
] as const;
export function agentChangeCursor(database: DatabaseSync): number {
  const cursor =
    database.prepare('SELECT max(seq) AS n FROM agent_steps_changes').get()
      ?.n ?? 0;
  if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error('DURABLE_AGENT_CHANGE_DAMAGED');
  return cursor;
}
