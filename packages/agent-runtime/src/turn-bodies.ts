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
  {
    values: Map<string, { wire: string; size: number }>;
    wires: Map<string, string>;
    size: number;
  }
>();
export function clearAgentBodies(database: DatabaseSync) {
  caches.delete(database);
}
function cache(database: DatabaseSync) {
  let state = caches.get(database);
  if (!state) {
    state = { values: new Map(), wires: new Map(), size: 0 };
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
function rememberBody(database: DatabaseSync, digest: string, wire: string) {
  const state = cache(database);
  const size = wire.length * 2 + 256;
  if (size > CACHE_BYTES) return;
  while (
    state.values.size &&
    (state.size + size > CACHE_BYTES || state.values.size >= 4096)
  ) {
    const oldest = state.values.keys().next().value!;
    const value = state.values.get(oldest)!;
    state.size -= value.size;
    state.wires.delete(value.wire);
    state.values.delete(oldest);
  }
  state.values.set(digest, { wire, size });
  state.wires.set(wire, digest);
  state.size += size;
}
export function agentBodyReference(
  database: DatabaseSync,
  wire: string,
): string {
  return cache(database).wires.get(wire) ?? hash(wire);
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
  rememberBody(database, digest, row.wire);
  return row.wire;
}
export function putAgentBody(database: DatabaseSync, wire: string): string {
  const state = cache(database);
  const known = state.wires.get(wire);
  if (known !== undefined) {
    knownBody(database, known);
    return known;
  }
  const digest = hash(wire);
  readAgentWire(wire);
  const inserted = database
    .prepare(
      'INSERT INTO agent_steps_bodies VALUES(?,?,?) ON CONFLICT(digest) DO NOTHING',
    )
    .run(digest, wire, Buffer.byteLength(wire));
  if (inserted.changes === 1) rememberBody(database, digest, wire);
  else if (readAgentBody(database, digest) !== wire)
    throw new Error('DURABLE_AGENT_BODY_DAMAGED');
  return digest;
}
