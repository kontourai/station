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
  'CREATE TABLE agent_steps_frame_blocks(turn_id TEXT NOT NULL REFERENCES agent_steps_turns(id), position INTEGER NOT NULL CHECK(position>=0), last_position INTEGER NOT NULL CHECK(last_position>=position), group_id TEXT NOT NULL, first_ordinal INTEGER NOT NULL, last_ordinal INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(turn_id,position)) STRICT',
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
function parseBlock(row: Record<string, unknown>): AgentFrame[] {
  const envelope = z
    .object({ digest: text, payload: z.string() })
    .strict()
    .parse(JSON.parse(String(row.record)));
  const raw = z
    .object({
      at: z.iso.datetime(),
      wires: z
        .array(z.string().max(32 * 1024 * 1024))
        .min(1)
        .max(1024),
      times: z.array(z.iso.datetime()).max(1024).optional(),
    })
    .strict()
    .parse(
      JSON.parse(
        inflateSync(Buffer.from(envelope.payload, 'base64'), {
          maxOutputLength: 64 * 1024 * 1024,
        }).toString('utf8'),
      ),
    );
  if (
    hash(
      canonical([
        row.turn_id,
        row.position,
        row.last_position,
        row.group_id,
        row.first_ordinal,
        row.last_ordinal,
        raw,
      ]),
    ) !== envelope.digest ||
    (raw.times !== undefined && raw.times.length !== raw.wires.length) ||
    Number(row.last_position) !== Number(row.position) + raw.wires.length - 1 ||
    Number(row.last_ordinal) !==
      Number(row.first_ordinal) + raw.wires.length - 1
  )
    throw new Error('DURABLE_AGENT_FRAME_DAMAGED');
  return raw.wires.map((wire, index) =>
    frameSchema.parse({
      version: 1,
      id: String(row.group_id).startsWith('ordinal:')
        ? `${String(row.group_id).slice(8)}:${Number(row.first_ordinal) + index}`
        : String(row.group_id).slice(8),
      position: Number(row.position) + index,
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
  const previous = agentStatement(
    database,
    'SELECT * FROM agent_steps_frame_blocks WHERE turn_id=? ORDER BY position DESC LIMIT 1',
  ).get(turnId);
  const incoming = frames[0]!;
  const incomingAddress = frameAddress(incoming.id);
  const append =
    previous &&
    previous.group_id === incomingAddress.group &&
    Number(previous.last_position) + 1 === incoming.position &&
    Number(previous.last_ordinal) + 1 === incomingAddress.ordinal &&
    Number(previous.last_position) -
      Number(previous.position) +
      1 +
      frames.length <=
      128;
  if (append) frames = [...parseBlock(previous), ...frames];
  const first = frames[0]!;
  const last = frames.at(-1)!;
  const address = frameAddress(first.id);
  const times = frames.map((frame) => frame.createdAt);
  const raw = {
    at: first.createdAt,
    wires: frames.map((frame) => frame.wire),
    ...(times.some((at) => at !== first.createdAt) ? { times } : {}),
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
      'UPDATE agent_steps_frame_blocks SET last_position=?,last_ordinal=?,record=? WHERE turn_id=? AND position=? AND record=?',
    ).run(
      last.position,
      frameAddress(last.id).ordinal,
      JSON.stringify({
        digest,
        payload: deflateSync(JSON.stringify(raw)).toString('base64'),
      }),
      turnId,
      first.position,
      String(previous.record),
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
    address.group,
    address.ordinal,
    frameAddress(last.id).ordinal,
    JSON.stringify({
      digest,
      payload: deflateSync(JSON.stringify(raw)).toString('base64'),
    }),
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
  const row = agentStatement(
    database,
    'SELECT * FROM agent_steps_frames WHERE turn_id=? AND id=?',
  ).get(turnId, id);
  if (row) return parseFrame(row);
  if (!blockFormat(database)) return undefined;
  const address = frameAddress(id);
  const block = agentStatement(
    database,
    'SELECT * FROM agent_steps_frame_blocks WHERE turn_id=? AND group_id=? AND first_ordinal<=? ORDER BY first_ordinal DESC LIMIT 1',
  ).get(turnId, address.group, address.ordinal);
  return block && Number(block.last_ordinal) >= address.ordinal
    ? parseBlock(block).find((frame) => frame.id === id)
    : undefined;
}
export function readAgentFrames(
  database: DatabaseSync,
  turnId: string,
): AgentFrame[] {
  const frames = agentStatement(
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
  let position =
    Number(
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
          'SELECT last_position AS n FROM agent_steps_frame_blocks WHERE turn_id=? ORDER BY position DESC LIMIT 1',
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
