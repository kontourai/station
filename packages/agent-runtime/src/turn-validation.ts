import type { DatabaseSync } from 'node:sqlite';
import { clearAgentBodies } from './turn-bodies.js';
import { clearAgentEffects } from './turn-effects.js';

const observations = new WeakMap<DatabaseSync, string>();
function observation(database: DatabaseSync) {
  return JSON.stringify([
    database.prepare('PRAGMA data_version').get()?.data_version,
    database.prepare('SELECT total_changes() AS n').get()?.n,
    database.prepare('PRAGMA schema_version').get()?.schema_version,
    database.prepare('PRAGMA temp.schema_version').get()?.schema_version,
  ]);
}
export function invalidateAgentValidation(database: DatabaseSync) {
  observations.delete(database);
  clearAgentBodies(database);
  clearAgentEffects(database);
}
export function synchronizeAgentValidation(database: DatabaseSync) {
  if (observations.get(database) === observation(database)) return false;
  invalidateAgentValidation(database);
  return true;
}
export function acceptAgentValidation(database: DatabaseSync) {
  observations.set(database, observation(database));
}
