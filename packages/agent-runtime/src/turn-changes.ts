import type { DatabaseSync } from 'node:sqlite';
import { agentStatement } from './turn-statements.js';

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
const compactDelete =
  "CREATE TRIGGER agent_steps_changes_no_delete BEFORE DELETE ON agent_steps_changes WHEN NOT EXISTS(SELECT 1 FROM agent_steps_changes newer WHERE newer.turn_id=OLD.turn_id AND newer.kind=OLD.kind AND newer.id=OLD.id AND newer.seq>OLD.seq) BEGIN SELECT RAISE(ABORT,'immutable latest agent change'); END";
const compactIndex =
  'CREATE INDEX agent_steps_changes_record ON agent_steps_changes(turn_id,kind,id,seq)';
const compactTrigger =
  'CREATE TRIGGER agent_steps_compact_changes AFTER INSERT ON agent_steps_changes BEGIN DELETE FROM agent_steps_changes WHERE turn_id=NEW.turn_id AND kind=NEW.kind AND id=NEW.id AND seq<NEW.seq; END';
export const compactChangeDefinitions = [
  ...changeDefinitions.map((sql) =>
    sql === changeDefinitions[3] ? compactDelete : sql,
  ),
  compactIndex,
  compactTrigger,
];
export function compactAgentChanges(database: DatabaseSync) {
  database.exec('DROP TRIGGER agent_steps_changes_no_delete');
  database.exec(compactDelete);
  database.exec(compactIndex);
  database.exec(compactTrigger);
  database.exec(
    'DELETE FROM agent_steps_changes WHERE EXISTS(SELECT 1 FROM agent_steps_changes newer WHERE newer.turn_id=agent_steps_changes.turn_id AND newer.kind=agent_steps_changes.kind AND newer.id=agent_steps_changes.id AND newer.seq>agent_steps_changes.seq)',
  );
}

export function agentChangeCursor(database: DatabaseSync): number {
  const cursor =
    agentStatement(
      database,
      'SELECT max(seq) AS n FROM agent_steps_changes',
    ).get()?.n ?? 0;
  if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error('DURABLE_AGENT_CHANGE_DAMAGED');
  return cursor;
}
