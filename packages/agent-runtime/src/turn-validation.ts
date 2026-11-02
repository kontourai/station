import type { DatabaseSync } from 'node:sqlite';
import { readAgentApproval } from './turn-approvals.js';
import { clearAgentBodies } from './turn-bodies.js';
import { agentChangeCursor } from './turn-changes.js';
import { clearAgentEffects, readAgentEffect } from './turn-effects.js';
import { agentStatement } from './turn-statements.js';

type Observation = {
  data: string;
  schema: string;
  cursor: number;
  turns: Map<string, number>;
};
const observations = new WeakMap<DatabaseSync, Observation>();
function observation(database: DatabaseSync): Omit<Observation, 'turns'> {
  return {
    data: JSON.stringify([
      agentStatement(database, 'PRAGMA data_version').get()?.data_version,
      agentStatement(database, 'SELECT total_changes() AS n').get()?.n,
    ]),
    schema: JSON.stringify([
      agentStatement(database, 'PRAGMA schema_version').get()?.schema_version,
      agentStatement(database, 'PRAGMA temp.schema_version').get()
        ?.schema_version,
    ]),
    cursor: agentChangeCursor(database),
  };
}
export function invalidateAgentValidation(database: DatabaseSync) {
  observations.delete(database);
  clearAgentBodies(database);
  clearAgentEffects(database);
}
export function synchronizeAgentValidation(
  database: DatabaseSync,
  turnId?: string,
) {
  const previous = observations.get(database);
  const current = observation(database);
  if (!previous || previous.schema !== current.schema) {
    invalidateAgentValidation(database);
    return true;
  }
  if (current.cursor < previous.cursor)
    throw new Error('DURABLE_AGENT_CHANGE_DAMAGED');
  if (!turnId) return true;
  const cursor = previous.turns.get(turnId);
  if (cursor === undefined) return true;
  if (previous.data === current.data && cursor === current.cursor) return false;
  const changed = agentStatement(
    database,
    'SELECT kind,id FROM agent_steps_changes WHERE turn_id=? AND seq>? GROUP BY kind,id',
  ).all(turnId, cursor);
  for (const row of changed) {
    const id = String(row.id);
    if (row.kind === 'effect') {
      if (!readAgentEffect(database, turnId, id))
        throw new Error('DURABLE_AGENT_CHANGED_EFFECT_MISSING');
      const approval = agentStatement(
        database,
        'SELECT id FROM agent_steps_approvals WHERE turn_id=? AND tool_id=?',
      ).get(turnId, id);
      if (approval) readAgentApproval(database, turnId, String(approval.id));
    } else if (row.kind === 'approval') {
      if (!readAgentApproval(database, turnId, id))
        throw new Error('DURABLE_AGENT_CHANGED_APPROVAL_MISSING');
    } else throw new Error('DURABLE_AGENT_CHANGE_DAMAGED');
  }
  return false;
}
export function acceptAgentValidation(database: DatabaseSync, turnId?: string) {
  const current = observation(database);
  const turns = observations.get(database)?.turns ?? new Map<string, number>();
  if (turnId) {
    turns.delete(turnId);
    if (turns.size >= 256) turns.delete(turns.keys().next().value!);
    turns.set(turnId, current.cursor);
  }
  observations.set(database, { ...current, turns });
}
