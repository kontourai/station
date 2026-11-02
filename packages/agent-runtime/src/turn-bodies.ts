import type { DatabaseSync } from 'node:sqlite';
import { deflateSync, inflateSync } from 'node:zlib';
import { z } from 'zod';
import { hash } from './encoding.js';
import {
  agentBodyRefs,
  decodeAgentBody,
  encodeAgentBody,
} from './turn-body-codec.js';
import { agentStatement } from './turn-statements.js';
import { agentWire, readAgentWire } from './turn-wire.js';

export const bodyDefinitions = [
  'CREATE TABLE agent_steps_bodies(digest TEXT PRIMARY KEY, wire TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0)) STRICT',
  "CREATE TRIGGER agent_steps_bodies_no_update BEFORE UPDATE ON agent_steps_bodies BEGIN SELECT RAISE(ABORT,'immutable agent body'); END",
  "CREATE TRIGGER agent_steps_bodies_no_delete BEFORE DELETE ON agent_steps_bodies BEGIN SELECT RAISE(ABORT,'immutable agent body'); END",
] as const;
export const bodyChunkDefinitions = [
  'CREATE TABLE agent_steps_body_chunks(digest TEXT PRIMARY KEY, wire TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0)) STRICT',
  "CREATE TRIGGER agent_steps_body_chunks_no_update BEFORE UPDATE ON agent_steps_body_chunks BEGIN SELECT RAISE(ABORT,'immutable agent chunk'); END",
  "CREATE TRIGGER agent_steps_body_chunks_no_delete BEFORE DELETE ON agent_steps_body_chunks BEGIN SELECT RAISE(ABORT,'immutable agent chunk'); END",
] as const;
export const bodyNodeDefinitions = [
  'CREATE TABLE agent_steps_body_nodes(digest TEXT PRIMARY KEY, wire TEXT NOT NULL, refs TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0)) STRICT, WITHOUT ROWID',
  "CREATE TRIGGER agent_steps_body_nodes_no_update BEFORE UPDATE ON agent_steps_body_nodes BEGIN SELECT RAISE(ABORT,'immutable agent node'); END",
  "CREATE TRIGGER agent_steps_body_nodes_no_delete BEFORE DELETE ON agent_steps_body_nodes WHEN EXISTS(SELECT 1 FROM agent_steps_bodies b,json_each(b.wire,'$.chunks') c WHERE c.value=OLD.digest) OR EXISTS(SELECT 1 FROM agent_steps_body_nodes n,json_each(n.refs) r WHERE r.value=OLD.digest) BEGIN SELECT RAISE(ABORT,'immutable agent node'); END",
];
const knownNodes = new WeakMap<DatabaseSync, Set<string>>();
export function readAgentBodyNode(database: DatabaseSync, digest: string) {
  const row = agentStatement(
    database,
    'SELECT wire,refs,byte_length FROM agent_steps_body_nodes WHERE digest=?',
  ).get(digest);
  if (!row || typeof row.wire !== 'string' || typeof row.refs !== 'string')
    throw new Error('DURABLE_AGENT_BODY_DAMAGED');
  let wire = row.wire;
  if (wire.startsWith('~'))
    wire = inflateSync(Buffer.from(wire.slice(1), 'base64'), {
      maxOutputLength: 128 * 1024,
    }).toString('utf8');
  else if (wire.startsWith('{"version":"agent-node/1"'))
    wire = inflateSync(Buffer.from(JSON.parse(wire).payload, 'base64'), {
      maxOutputLength: 128 * 1024,
    }).toString('utf8');
  if (Buffer.byteLength(wire) !== row.byte_length || hash(wire) !== digest)
    throw new Error('DURABLE_AGENT_BODY_DAMAGED');
  const refs = agentBodyRefs(JSON.parse(wire));
  if (JSON.stringify(refs) !== row.refs)
    throw new Error('DURABLE_AGENT_BODY_DAMAGED');
  return { wire, refs };
}
function putNode(database: DatabaseSync, wire: string, refs: string[]) {
  const digest = hash(wire);
  let known = knownNodes.get(database);
  if (!known) {
    known = new Set();
    knownNodes.set(database, known);
  }
  if (known.has(digest)) return digest;
  const compressed = `~${deflateSync(wire).toString('base64')}`;
  const stored = compressed.length < wire.length ? compressed : wire;
  const inserted = agentStatement(
    database,
    'INSERT INTO agent_steps_body_nodes VALUES(?,?,?,?) ON CONFLICT(digest) DO NOTHING',
  ).run(digest, stored, JSON.stringify(refs), Buffer.byteLength(wire));
  if (
    inserted.changes !== 1 &&
    readAgentBodyNode(database, digest).wire !== wire
  )
    throw new Error('DURABLE_AGENT_BODY_DAMAGED');
  if (known.size >= 8192) known.delete(known.values().next().value!);
  known.add(digest);
  return digest;
}
const CHUNK_UNITS = 16 * 1024;
const chunkedSchema = z
  .object({
    version: z.literal('agent-body/2'),
    codeUnits: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
    chunks: z
      .array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
      .min(1)
      .max(2048),
  })
  .strict();
const knownChunks = new WeakMap<DatabaseSync, Set<string>>();
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
  knownChunks.delete(database);
  knownNodes.delete(database);
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
export function readAgentBodyChunk(
  database: DatabaseSync,
  digest: string,
): string {
  const row = agentStatement(
    database,
    'SELECT wire,byte_length FROM agent_steps_body_chunks WHERE digest=?',
  ).get(digest);
  if (!row || typeof row.wire !== 'string')
    throw new Error('DURABLE_AGENT_CHUNK_DAMAGED');
  let wire = row.wire;
  if (wire.startsWith('{')) {
    const packed = z
      .object({ version: z.literal('agent-text/1'), payload: z.string() })
      .strict()
      .parse(JSON.parse(wire));
    wire = inflateSync(Buffer.from(packed.payload, 'base64'), {
      maxOutputLength: 128 * 1024,
    }).toString('utf8');
  }
  if (Buffer.byteLength(wire) !== row.byte_length || hash(wire) !== digest)
    throw new Error('DURABLE_AGENT_CHUNK_DAMAGED');
  const value = readAgentWire(wire);
  if (typeof value !== 'string' || !value.length || value.length > CHUNK_UNITS)
    throw new Error('DURABLE_AGENT_CHUNK_DAMAGED');
  return value;
}
function putChunk(database: DatabaseSync, value: string): string {
  const encoded = agentWire(value);
  const digest = hash(encoded);
  let known = knownChunks.get(database);
  if (!known) {
    known = new Set();
    knownChunks.set(database, known);
  }
  if (known.has(digest)) return digest;
  const packed = JSON.stringify({
    version: 'agent-text/1',
    payload: deflateSync(encoded).toString('base64'),
  });
  const stored =
    packed.length < encoded.length &&
    agentStatement(
      database,
      'SELECT writer_format FROM agent_steps_meta WHERE id=1',
    ).get()?.writer_format === 'agent-steps/11'
      ? packed
      : encoded;
  const inserted = agentStatement(
    database,
    'INSERT INTO agent_steps_body_chunks VALUES(?,?,?) ON CONFLICT(digest) DO NOTHING',
  ).run(digest, stored, Buffer.byteLength(encoded));
  if (inserted.changes !== 1 && readAgentBodyChunk(database, digest) !== value)
    throw new Error('DURABLE_AGENT_CHUNK_DAMAGED');
  if (known.size >= 4096) known.delete(known.values().next().value!);
  known.add(digest);
  return digest;
}
export function readAgentBody(database: DatabaseSync, digest: string): string {
  const known = knownBody(database, digest);
  if (known !== undefined) return known;
  const row = agentStatement(
    database,
    'SELECT wire,byte_length FROM agent_steps_bodies WHERE digest=?',
  ).get(digest);
  if (!row || typeof row.wire !== 'string')
    throw new Error('DURABLE_AGENT_BODY_DAMAGED');
  let wire = row.wire;
  if (wire.startsWith('{') && JSON.parse(wire).version === 'agent-body/3') {
    wire = decodeAgentBody(
      wire,
      (ref) => readAgentBodyChunk(database, ref),
      (ref) => readAgentBodyNode(database, ref),
    );
  } else if (wire.startsWith('{')) {
    const descriptor = chunkedSchema.parse(JSON.parse(wire));
    if (
      descriptor.chunks.length !== Math.ceil(descriptor.codeUnits / CHUNK_UNITS)
    )
      throw new Error('DURABLE_AGENT_BODY_DAMAGED');
    const pieces = descriptor.chunks.map((ref, index) => {
      const piece = readAgentBodyChunk(database, ref);
      const size = Math.min(
        CHUNK_UNITS,
        descriptor.codeUnits - index * CHUNK_UNITS,
      );
      if (piece.length !== size) throw new Error('DURABLE_AGENT_CHUNK_DAMAGED');
      return piece;
    });
    wire = pieces.join('');
  }
  if (Buffer.byteLength(wire) !== row.byte_length || hash(wire) !== digest)
    throw new Error('DURABLE_AGENT_BODY_DAMAGED');
  readAgentWire(wire);
  rememberBody(database, digest, wire);
  return wire;
}
export function putAgentBody(database: DatabaseSync, wire: string): string {
  const known = cache(database).wires.get(wire);
  if (known !== undefined) {
    knownBody(database, known);
    return known;
  }
  const digest = hash(wire);
  readAgentWire(wire);
  const compact =
    agentStatement(
      database,
      'SELECT writer_format FROM agent_steps_meta WHERE id=1',
    ).get()?.writer_format === 'agent-steps/11';
  let stored = wire;
  if (compact)
    stored = encodeAgentBody(
      wire,
      (value) => putChunk(database, value),
      (value, refs) => putNode(database, value, refs),
    );
  else if (
    wire.length > CHUNK_UNITS &&
    agentStatement(
      database,
      "SELECT 1 FROM main.sqlite_schema WHERE name='agent_steps_body_chunks'",
    ).get()
  ) {
    const chunks: string[] = [];
    for (let offset = 0; offset < wire.length; offset += CHUNK_UNITS)
      chunks.push(putChunk(database, wire.slice(offset, offset + CHUNK_UNITS)));
    stored = JSON.stringify({
      version: 'agent-body/2',
      codeUnits: wire.length,
      chunks,
    });
  }
  const inserted = agentStatement(
    database,
    'INSERT INTO agent_steps_bodies VALUES(?,?,?) ON CONFLICT(digest) DO NOTHING',
  ).run(digest, stored, Buffer.byteLength(wire));
  if (inserted.changes === 1) rememberBody(database, digest, wire);
  else if (readAgentBody(database, digest) !== wire)
    throw new Error('DURABLE_AGENT_BODY_DAMAGED');
  return digest;
}
