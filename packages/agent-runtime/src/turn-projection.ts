import type { DatabaseSync } from 'node:sqlite';
import { deflateSync, inflateSync } from 'node:zlib';
import { z } from 'zod';
import {
  canonical,
  fence,
  hash,
  RuntimeError,
  runKey,
  text,
} from './encoding.js';
import { agentStatement } from './turn-statements.js';
import type { Fence, RunKey } from './types.js';

const frameSchema = z
  .object({
    version: z.literal(1),
    id: text,
    position: z.number().int().nonnegative(),
    wire: z.string().max(32 * 1024 * 1024),
    digest: text,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type AgentFrame = z.infer<typeof frameSchema>;
export type FrameResult = {
  readonly kind: 'frame';
  readonly frame: AgentFrame;
};
export type FrameCommand = {
  readonly type: 'projectFrame';
  readonly key: RunKey;
  readonly expected: Fence;
  readonly id: string;
  readonly wire: string;
};
export const frameCommand = z
  .object({
    type: z.literal('projectFrame'),
    key: runKey,
    expected: fence,
    id: text,
    wire: z.string().max(32 * 1024 * 1024),
  })
  .strict();
export type FrameBatchCommand = {
  readonly type: 'projectFrameBatch';
  readonly key: RunKey;
  readonly expected: Fence;
  readonly frames: readonly { readonly id: string; readonly wire: string }[];
};
export const frameBatchCommand = z
  .object({
    type: z.literal('projectFrameBatch'),
    key: runKey,
    expected: fence,
    frames: z
      .array(z.object({ id: text, wire: z.string().max(64 * 1024) }).strict())
      .min(1)
      .max(1024)
      .refine(
        (frames) =>
          frames.reduce((n, frame) => n + Buffer.byteLength(frame.wire), 0) <=
          64 * 1024,
      )
      .refine(
        (frames) =>
          new Set(frames.map((frame) => frame.id)).size === frames.length,
      ),
  })
  .strict();
export type FrameBatchResult = {
  readonly kind: 'frames';
  readonly frames: AgentFrame[];
};
export const framesDefinition =
  'CREATE TABLE agent_steps_frames(turn_id TEXT NOT NULL REFERENCES agent_steps_turns(id), id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0), record TEXT NOT NULL, PRIMARY KEY(turn_id,id), UNIQUE(turn_id,position)) STRICT';
export const frameBlockDefinitions = [
  'CREATE TABLE agent_steps_frame_blocks(turn_id TEXT NOT NULL REFERENCES agent_steps_turns(id), position INTEGER NOT NULL CHECK(position>=0), last_position INTEGER NOT NULL CHECK(last_position>=position), group_id BLOB NOT NULL CHECK(length(group_id)>1), first_ordinal INTEGER NOT NULL, last_ordinal INTEGER NOT NULL, record BLOB NOT NULL, PRIMARY KEY(turn_id,position)) STRICT',
  'CREATE INDEX agent_steps_frame_block_ids ON agent_steps_frame_blocks(turn_id,group_id,first_ordinal,last_ordinal)',
];
function blockFormat(database: DatabaseSync) {
  return (
    agentStatement(
      database,
      "SELECT 1 FROM main.sqlite_schema WHERE name='agent_steps_frame_blocks'",
    ).get() !== undefined
  );
}
function frameAddress(id: string) {
  const boundary = id.lastIndexOf(':');
  const ordinal = Number(id.slice(boundary + 1));
  return boundary >= 0 &&
    Number.isSafeInteger(ordinal) &&
    ordinal >= 0 &&
    String(ordinal) === id.slice(boundary + 1)
    ? { group: `ordinal:${id.slice(0, boundary)}`, ordinal }
    : { group: `literal:${id}`, ordinal: 0 };
}
function storedFrameGroup(group: string): Buffer {
  const match = /^ordinal:([a-f0-9]{64})$/.exec(group);
  return match
    ? Buffer.concat([Buffer.from([1]), Buffer.from(match[1]!, 'hex')])
    : Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(group))]);
}
function logicalFrameGroup(value: unknown): string {
  if (!(value instanceof Uint8Array))
    throw new Error('DURABLE_AGENT_FRAME_DAMAGED');
  const bytes = Buffer.from(value);
  const group =
    bytes[0] === 1 && bytes.length === 33
      ? `ordinal:${bytes.subarray(1).toString('hex')}`
      : bytes[0] === 0
        ? JSON.parse(bytes.subarray(1).toString('utf8'))
        : undefined;
  if (typeof group !== 'string' || !storedFrameGroup(group).equals(bytes))
    throw new Error('DURABLE_AGENT_FRAME_DAMAGED');
  return group;
}
function parseBlock(row: Record<string, unknown>): AgentFrame[] {
  const group = logicalFrameGroup(row.group_id);
  if (!(row.record instanceof Uint8Array) || row.record.byteLength <= 32)
    throw new Error('DURABLE_AGENT_FRAME_DAMAGED');
  const record = Buffer.from(row.record);
  const envelope = {
    digest: `sha256:${record.subarray(0, 32).toString('hex')}`,
    payload: record.subarray(32),
  };
  const raw = z
    .object({
      at: z.iso.datetime(),
      wires: z
        .array(z.string().max(32 * 1024 * 1024))
        .min(1)
        .max(1024),
      times: z.array(z.iso.datetime()).max(1024).optional(),
      positions: z.array(z.number().int().nonnegative()).max(1024).optional(),
    })
    .strict()
    .parse(
      JSON.parse(
        inflateSync(envelope.payload, {
          maxOutputLength: 256 * 1024 * 1024,
        }).toString('utf8'),
      ),
    );
  if (
    hash(
      canonical([
        row.turn_id,
        row.position,
        row.last_position,
        group,
        row.first_ordinal,
        row.last_ordinal,
        raw,
      ]),
    ) !== envelope.digest ||
    (raw.times !== undefined && raw.times.length !== raw.wires.length) ||
    (raw.positions !== undefined &&
      (raw.positions.length !== raw.wires.length ||
        raw.positions[0] !== row.position ||
        raw.positions.some(
          (position, index, positions) =>
            index > 0 && position <= positions[index - 1]!,
        ))) ||
    Number(row.last_position) !==
      (raw.positions?.at(-1) ?? Number(row.position) + raw.wires.length - 1) ||
    Number(row.last_ordinal) !==
      Number(row.first_ordinal) + raw.wires.length - 1
  )
    throw new Error('DURABLE_AGENT_FRAME_DAMAGED');
  return raw.wires.map((wire, index) =>
    frameSchema.parse({
      version: 1,
      id: group.startsWith('ordinal:')
        ? `${group.slice(8)}:${Number(row.first_ordinal) + index}`
        : group.slice(8),
      position: raw.positions?.[index] ?? Number(row.position) + index,
      wire,
      digest: hash(wire),
      createdAt: raw.times?.[index] ?? raw.at,
    }),
  );
}
function putBlock(
  database: DatabaseSync,
  turnId: string,
  frames: AgentFrame[],
) {
  const incoming = frames[0]!;
  const incomingAddress = frameAddress(incoming.id);
  const previous = agentStatement(
    database,
    'SELECT * FROM agent_steps_frame_blocks WHERE turn_id=? AND group_id=? ORDER BY first_ordinal DESC LIMIT 1',
  ).get(turnId, storedFrameGroup(incomingAddress.group));
  let append =
    previous &&
    Number(previous.last_ordinal) + 1 === incomingAddress.ordinal &&
    Number(previous.last_ordinal) -
      Number(previous.first_ordinal) +
      1 +
      frames.length <=
      128;
  if (previous && append) {
    const prior = parseBlock(previous);
    if (
      [...prior, ...frames].reduce(
        (sum, frame) => sum + Buffer.byteLength(frame.wire),
        0,
      ) >
      64 * 1024
    )
      append = false;
    else frames = [...prior, ...frames];
  }
  const first = frames[0]!;
  const last = frames.at(-1)!;
  const address = frameAddress(first.id);
  const times = frames.map((frame) => frame.createdAt);
  const raw = {
    at: first.createdAt,
    wires: frames.map((frame) => frame.wire),
    ...(times.some((at) => at !== first.createdAt) ? { times } : {}),
    ...(frames.some((frame, index) => frame.position !== first.position + index)
      ? { positions: frames.map((frame) => frame.position) }
      : {}),
  };
  const digest = hash(
    canonical([
      turnId,
      first.position,
      last.position,
      address.group,
      address.ordinal,
      frameAddress(last.id).ordinal,
      raw,
    ]),
  );
  if (append) {
    const changed = agentStatement(
      database,
      'INSERT OR REPLACE INTO agent_steps_frame_blocks VALUES(?,?,?,?,?,?,?)',
    ).run(
      turnId,
      first.position,
      last.position,
      storedFrameGroup(address.group),
      address.ordinal,
      frameAddress(last.id).ordinal,
      Buffer.concat([
        Buffer.from(digest.slice(7), 'hex'),
        deflateSync(JSON.stringify(raw)),
      ]),
    );
    if (changed.changes !== 1) throw new Error('DURABLE_AGENT_FRAME_DAMAGED');
    return;
  }
  agentStatement(
    database,
    'INSERT INTO agent_steps_frame_blocks VALUES(?,?,?,?,?,?,?)',
  ).run(
    turnId,
    first.position,
    last.position,
    storedFrameGroup(address.group),
    address.ordinal,
    frameAddress(last.id).ordinal,
    Buffer.concat([
      Buffer.from(digest.slice(7), 'hex'),
      deflateSync(JSON.stringify(raw)),
    ]),
  );
}
function parseFrame(row: Record<string, unknown>): AgentFrame {
  const frame = frameSchema.parse(JSON.parse(String(row.record)));
  if (
    row.id !== frame.id ||
    row.position !== frame.position ||
    frame.digest !== hash(frame.wire) ||
    Buffer.byteLength(frame.wire) > 32 * 1024 * 1024
  )
    throw new Error('DURABLE_AGENT_FRAME_DAMAGED');
  return frame;
}
export function readAgentFrame(
  database: DatabaseSync,
  turnId: string,
  id: string,
) {
  if (!blockFormat(database)) {
    const row = agentStatement(
      database,
      'SELECT * FROM agent_steps_frames WHERE turn_id=? AND id=?',
    ).get(turnId, id);
    return row ? parseFrame(row) : undefined;
  }
  const address = frameAddress(id);
  const block = agentStatement(
    database,
    'SELECT * FROM agent_steps_frame_blocks WHERE turn_id=? AND group_id=? AND first_ordinal<=? ORDER BY first_ordinal DESC LIMIT 1',
  ).get(turnId, storedFrameGroup(address.group), address.ordinal);
  return block && Number(block.last_ordinal) >= address.ordinal
    ? parseBlock(block).find((frame) => frame.id === id)
    : undefined;
}
export function readAgentFrames(
  database: DatabaseSync,
  turnId: string,
): AgentFrame[] {
  const frames: AgentFrame[] = blockFormat(database)
    ? []
    : agentStatement(
        database,
        'SELECT * FROM agent_steps_frames WHERE turn_id=? ORDER BY position',
      )
        .all(turnId)
        .map(parseFrame);
  if (blockFormat(database)) {
    for (const row of agentStatement(
      database,
      'SELECT * FROM agent_steps_frame_blocks WHERE turn_id=? ORDER BY position',
    ).all(turnId))
      frames.push(...parseBlock(row));
    frames.sort((a, b) => a.position - b.position);
  }
  if (
    frames.length > 1_048_578 ||
    new Set(frames.map((frame) => frame.id)).size !== frames.length ||
    frames.some((frame, index) => frame.position !== index)
  )
    throw new Error('DURABLE_AGENT_FRAME_ORDER_DAMAGED');
  return frames;
}
export function projectAgentFrames(
  database: DatabaseSync,
  turnId: string,
  commands: readonly FrameCommand[],
  now: number,
): AgentFrame[] {
  const compact = blockFormat(database);
  let position = compact
    ? 0
    : Number(
        agentStatement(
          database,
          'SELECT max(position) AS n FROM agent_steps_frames WHERE turn_id=?',
        ).get(turnId)?.n ?? -1,
      ) + 1;
  if (compact)
    position = Math.max(
      position,
      Number(
        agentStatement(
          database,
          'SELECT max(last_position) AS n FROM agent_steps_frame_blocks WHERE turn_id=?',
        ).get(turnId)?.n ?? -1,
      ) + 1,
    );
  const result: AgentFrame[] = [];
  let pending: AgentFrame[] = [];
  const flush = () => {
    if (pending.length) putBlock(database, turnId, pending);
    pending = [];
  };
  for (const command of commands) {
    const existing = readAgentFrame(database, turnId, command.id);
    if (existing) {
      result.push(existing);
      continue;
    }
    const terminalError =
      command.wire.startsWith('data: {') &&
      (() => {
        try {
          return JSON.parse(command.wire.slice(6)).type === 'error';
        } catch {
          return false;
        }
      })();
    const limit =
      terminalError || command.wire === 'data: [DONE]\n\n'
        ? 1_048_578
        : 1_048_576;
    if (position >= limit || Buffer.byteLength(command.wire) > 32 * 1024 * 1024)
      throw new RuntimeError('DURABLE_AGENT_FRAME_CAPACITY');
    const frame = frameSchema.parse({
      version: 1,
      id: command.id,
      position: position++,
      wire: command.wire,
      digest: hash(command.wire),
      createdAt: new Date(now).toISOString(),
    });
    if (compact) {
      const previous = pending.at(-1);
      const address = frameAddress(frame.id);
      if (
        previous &&
        (frameAddress(previous.id).group !== address.group ||
          frameAddress(previous.id).ordinal + 1 !== address.ordinal ||
          pending.length === 128)
      )
        flush();
      pending.push(frame);
    } else
      agentStatement(
        database,
        'INSERT INTO agent_steps_frames VALUES(?,?,?,?)',
      ).run(turnId, frame.id, frame.position, canonical(frame));
    result.push(frame);
  }
  flush();
  return result;
}
export function projectAgentFrame(
  database: DatabaseSync,
  turnId: string,
  command: FrameCommand,
  now: number,
): FrameResult {
  return {
    kind: 'frame',
    frame: projectAgentFrames(database, turnId, [command], now)[0]!,
  };
}

export function migrateAgentFrameBlocks(database: DatabaseSync) {
  let pending: AgentFrame[] = [];
  let turnId = '';
  let bytes = 0;
  const flush = () => {
    if (pending.length) putBlock(database, turnId, pending);
    pending = [];
    bytes = 0;
  };
  for (const row of agentStatement(
    database,
    'SELECT * FROM agent_steps_frames ORDER BY turn_id,position',
  ).iterate()) {
    const frame = parseFrame(row);
    const previous = pending.at(-1);
    const address = frameAddress(frame.id);
    if (
      pending.length &&
      (row.turn_id !== turnId ||
        pending.length === 128 ||
        bytes + Buffer.byteLength(frame.wire) > 64 * 1024 ||
        (previous &&
          (frameAddress(previous.id).group !== address.group ||
            frameAddress(previous.id).ordinal + 1 !== address.ordinal ||
            previous.position + 1 !== frame.position)))
    )
      flush();
    turnId = String(row.turn_id);
    pending.push(frame);
    bytes += Buffer.byteLength(frame.wire);
  }
  flush();
  database.exec('DROP TABLE agent_steps_frames');
}
