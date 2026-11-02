import type { DatabaseSync } from 'node:sqlite';
import { hash } from './encoding.js';
import { readAgentWire } from './turn-wire.js';

export const bodyDefinitions = [
  'CREATE TABLE agent_steps_bodies(digest TEXT PRIMARY KEY, wire TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0)) STRICT',
  "CREATE TRIGGER agent_steps_bodies_no_update BEFORE UPDATE ON agent_steps_bodies BEGIN SELECT RAISE(ABORT,'immutable agent body'); END",
  "CREATE TRIGGER agent_steps_bodies_no_delete BEFORE DELETE ON agent_steps_bodies BEGIN SELECT RAISE(ABORT,'immutable agent body'); END",
] as const;
const CACHE_BYTES = 16 * 1024 * 1024;
const caches = new WeakMap<
  DatabaseSync,
  { values: Map<string, { wire: string; size: number }>; size: number }
>();
export function clearAgentBodies(database: DatabaseSync) {
  caches.delete(database);
}
function cache(database: DatabaseSync) {
  let state = caches.get(database);
  if (!state) {
    state = { values: new Map(), size: 0 };
    caches.set(database, state);
  }
  return state;
}
function knownBody(database: DatabaseSync, digest: string) {
  const { values } = cache(database);
  const known = values.get(digest);
  if (known) {
    values.delete(digest);
    values.set(digest, known);
  }
  return known?.wire;
}
export function readAgentBody(database: DatabaseSync, digest: string): string {
  const known = knownBody(database, digest);
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
  const state = cache(database);
  const size = row.wire.length * 2 + 256;
  if (size <= CACHE_BYTES) {
    while (
      state.values.size &&
      (state.size + size > CACHE_BYTES || state.values.size >= 4096)
    ) {
      const oldest = state.values.keys().next().value!;
      state.size -= state.values.get(oldest)!.size;
      state.values.delete(oldest);
    }
    state.values.set(digest, { wire: row.wire, size });
    state.size += size;
  }
  return row.wire;
}
export function putAgentBody(database: DatabaseSync, wire: string): string {
  const digest = hash(wire);
  if (knownBody(database, digest) === wire) return digest;
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
