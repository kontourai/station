import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { canonical, fence, hash, runKey, text } from './encoding.js';
import { readAgentEffect } from './turn-effects.js';
import { readAgentWire } from './turn-wire.js';
import type { Fence, RunKey } from './types.js';

const payload = z.string().max(32 * 1024 * 1024);
const approvalSchema = z
  .object({
    version: z.literal(1),
    id: text,
    toolId: text,
    input: payload,
    inputDigest: text,
    deadline: z.number().int().positive().safe(),
    revision: z.enum(['0', '1']),
    state: z.enum(['pending', 'approved', 'denied', 'expired']),
  })
  .strict();
export type DurableApproval = z.infer<typeof approvalSchema>;
export type ApprovalResult = {
  readonly kind: 'approval';
  readonly approval: DurableApproval;
};
type Owned = { readonly key: RunKey; readonly expected: Fence };
export type ApprovalCommand =
  | (Owned & {
      readonly type: 'approvalPlan';
      readonly id: string;
      readonly toolId: string;
      readonly input: string;
      readonly deadline: number;
    })
  | (Owned & {
      readonly type: 'approvalResolve';
      readonly id: string;
      readonly expectedRevision: string;
      readonly decision: 'approved' | 'denied' | 'expired';
    });
const owned = { key: runKey, expected: fence };
export const approvalCommands = [
  z
    .object({
      type: z.literal('approvalPlan'),
      ...owned,
      id: text,
      toolId: text,
      input: payload,
      deadline: z.number().int().positive().safe(),
    })
    .strict(),
  z
    .object({
      type: z.literal('approvalResolve'),
      ...owned,
      id: text,
      expectedRevision: z.enum(['0', '1']),
      decision: z.enum(['approved', 'denied', 'expired']),
    })
    .strict(),
] as const;
export const approvalsDefinition =
  'CREATE TABLE agent_steps_approvals(turn_id TEXT NOT NULL, id TEXT NOT NULL, tool_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(turn_id,id), UNIQUE(turn_id,tool_id), FOREIGN KEY(turn_id,tool_id) REFERENCES agent_steps_effects(turn_id,id)) STRICT';
export function readAgentApproval(
  database: DatabaseSync,
  turnId: string,
  id: string,
) {
  const row = database
    .prepare('SELECT * FROM agent_steps_approvals WHERE turn_id=? AND id=?')
    .get(turnId, id);
  if (!row) return undefined;
  const approval = approvalSchema.parse(JSON.parse(String(row.record)));
  const tool = readAgentEffect(database, turnId, approval.toolId);
  readAgentWire(approval.input);
  if (
    approval.id !== id ||
    approval.toolId !== row.tool_id ||
    approval.inputDigest !== hash(approval.input) ||
    (approval.state === 'pending') !== (approval.revision === '0') ||
    tool?.intent.kind !== 'tool' ||
    tool.intent.input !== approval.input
  )
    throw new Error('DURABLE_AGENT_APPROVAL_DAMAGED');
  return approval;
}
export function validateAgentApprovals(database: DatabaseSync, turnId: string) {
  const rows = database
    .prepare('SELECT id FROM agent_steps_approvals WHERE turn_id=?')
    .all(turnId);
  if (rows.length > 128) throw new Error('DURABLE_AGENT_APPROVAL_CAPACITY');
  return rows.map(
    (row) => readAgentApproval(database, turnId, String(row.id))!,
  );
}
export function decideAgentApproval(
  database: DatabaseSync,
  turnId: string,
  command: ApprovalCommand,
  now: number,
):
  | ApprovalResult
  | {
      readonly kind: 'refused';
      readonly reason: 'conflict' | 'stale' | 'busy';
    } {
  let approval = readAgentApproval(database, turnId, command.id);
  if (command.type === 'approvalPlan') {
    if (approval)
      return approval.toolId === command.toolId &&
        approval.input === command.input
        ? { kind: 'approval', approval }
        : { kind: 'refused', reason: 'conflict' };
    const tool = readAgentEffect(database, turnId, command.toolId);
    if (
      tool?.intent.kind !== 'tool' ||
      tool.state !== 'planned' ||
      tool.intent.input !== command.input
    )
      return { kind: 'refused', reason: 'conflict' };
    if (
      Number(
        database
          .prepare(
            'SELECT count(*) AS n FROM agent_steps_approvals WHERE turn_id=?',
          )
          .get(turnId)?.n,
      ) >= 128
    )
      return { kind: 'refused', reason: 'busy' };
    approval = {
      version: 1,
      id: command.id,
      toolId: command.toolId,
      input: command.input,
      inputDigest: hash(command.input),
      deadline: command.deadline,
      revision: '0',
      state: 'pending',
    };
    database
      .prepare('INSERT INTO agent_steps_approvals VALUES(?,?,?,?)')
      .run(turnId, approval.id, approval.toolId, canonical(approval));
  } else {
    if (
      approval?.state !== 'pending' ||
      approval.revision !== command.expectedRevision
    )
      return { kind: 'refused', reason: 'stale' };
    if (!Number.isSafeInteger(now) || now < 1)
      throw new Error('DURABLE_AGENT_CLOCK_UNAVAILABLE');
    if (command.decision === 'expired' && now < approval.deadline)
      return { kind: 'refused', reason: 'conflict' };
    approval.state = now >= approval.deadline ? 'expired' : command.decision;
    approval.revision = '1';
    database
      .prepare(
        'UPDATE agent_steps_approvals SET record=? WHERE turn_id=? AND id=?',
      )
      .run(canonical(approval), turnId, approval.id);
  }
  return { kind: 'approval', approval };
}
