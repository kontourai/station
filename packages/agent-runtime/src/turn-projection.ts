import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { canonical, fence, hash, runKey, text } from './encoding.js';
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
  return row ? parseFrame(row) : undefined;
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
  if (
    frames.length > 1_048_576 ||
    frames.some((frame, index) => frame.position !== index)
  )
    throw new Error('DURABLE_AGENT_FRAME_ORDER_DAMAGED');
  return frames;
}
export function projectAgentFrame(
  database: DatabaseSync,
  turnId: string,
  command: FrameCommand,
  now: number,
): FrameResult {
  const existing = readAgentFrame(database, turnId, command.id);
  if (existing) return { kind: 'frame', frame: existing };
  const position =
    Number(
      agentStatement(
        database,
        'SELECT max(position) AS n FROM agent_steps_frames WHERE turn_id=?',
      ).get(turnId)?.n ?? -1,
    ) + 1;
  if (
    position >= 1_048_576 ||
    Buffer.byteLength(command.wire) > 32 * 1024 * 1024
  )
    throw new Error('DURABLE_AGENT_FRAME_CAPACITY');
  const frame = frameSchema.parse({
    version: 1,
    id: command.id,
    position,
    wire: command.wire,
    digest: hash(command.wire),
    createdAt: new Date(now).toISOString(),
  });
  agentStatement(
    database,
    'INSERT INTO agent_steps_frames VALUES(?,?,?,?)',
  ).run(turnId, frame.id, frame.position, canonical(frame));
  return { kind: 'frame', frame };
}
