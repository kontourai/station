import type { DatabaseSync } from 'node:sqlite';
import { hash } from './encoding.js';
import { readAgentWire } from './turn-wire.js';

export const bodyDefinitions = [
  'CREATE TABLE agent_steps_bodies(digest TEXT PRIMARY KEY, wire TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0)) STRICT',
  "CREATE TRIGGER agent_steps_bodies_no_update BEFORE UPDATE ON agent_steps_bodies BEGIN SELECT RAISE(ABORT,'immutable agent body'); END",
  "CREATE TRIGGER agent_steps_bodies_no_delete BEFORE DELETE ON agent_steps_bodies BEGIN SELECT RAISE(ABORT,'immutable agent body'); END",
] as const;
const caches = new WeakMap<DatabaseSync, Map<string, string>>();
export function clearAgentBodies(database: DatabaseSync) {
  caches.delete(database);
}
function cache(database: DatabaseSync) {
  let values = caches.get(database);
  if (!values) {
    values = new Map();
    caches.set(database, values);
  }
  return values;
}
export function readAgentBody(database: DatabaseSync, digest: string): string {
  const values = cache(database);
  const known = values.get(digest);
  if (known !== undefined) return known;
  const row = database
    .prepare('SELECT wire,byte_length FROM agent_steps_bodies WHERE digest=?')
    .get(digest);
  if (
    !row ||
    typeof row.wire !== 'string' ||
    Buffer.byteLength(row.wire) !== row.byte_length ||
    hash(row.wire) !== digest
  )
    throw new Error('DURABLE_AGENT_BODY_DAMAGED');
  readAgentWire(row.wire);
  while (values.size >= 128) values.delete(values.keys().next().value!);
  values.set(digest, row.wire);
  return row.wire;
}
export function putAgentBody(database: DatabaseSync, wire: string): string {
  const digest = hash(wire);
  const values = cache(database);
  if (values.get(digest) === wire) return digest;
  readAgentWire(wire);
  database
    .prepare(
      'INSERT INTO agent_steps_bodies VALUES(?,?,?) ON CONFLICT(digest) DO NOTHING',
    )
    .run(digest, wire, Buffer.byteLength(wire));
  if (readAgentBody(database, digest) !== wire)
    throw new Error('DURABLE_AGENT_BODY_DAMAGED');
  return digest;
}
