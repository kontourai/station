import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './encoding.js';
import { forgetAgentBody } from './turn-bodies.js';
import { agentStatement } from './turn-statements.js';

const liveBodies =
  "SELECT tree.value FROM agent_steps_effects e,json_tree(e.record) tree WHERE tree.type='text' AND tree.value GLOB 'sha256:*'";
export const retainedBodyDefinitions = [
  `CREATE TRIGGER agent_steps_bodies_no_delete BEFORE DELETE ON agent_steps_bodies WHEN OLD.digest IN (${liveBodies}) BEGIN SELECT RAISE(ABORT,'immutable agent body'); END`,
  "CREATE TRIGGER agent_steps_body_chunks_no_delete BEFORE DELETE ON agent_steps_body_chunks WHEN EXISTS(SELECT 1 FROM agent_steps_bodies b,json_each(b.wire,'$.chunks') c WHERE c.value=OLD.digest) OR EXISTS(SELECT 1 FROM agent_steps_body_nodes n,json_each(n.refs) r WHERE r.value=substr(OLD.digest,8)) BEGIN SELECT RAISE(ABORT,'immutable agent chunk'); END",
];
export const retentionDefinitions = [
  'CREATE TABLE agent_steps_retained(turn_id TEXT PRIMARY KEY REFERENCES agent_steps_turns(id), expired_at INTEGER NOT NULL CHECK(expired_at>0)) STRICT, WITHOUT ROWID',
  'CREATE INDEX agent_steps_terminal_age ON agent_steps_terminal(state,settled_at)',
];
export const incrementalRetentionDefinitions = [
  'CREATE TABLE agent_steps_reclaimable(turn_id TEXT PRIMARY KEY REFERENCES agent_steps_turns(id), settled_at INTEGER NOT NULL) STRICT, WITHOUT ROWID',
  'CREATE INDEX agent_steps_reclaimable_age ON agent_steps_reclaimable(settled_at)',
  'CREATE TABLE agent_steps_retained_cleanup(turn_id TEXT PRIMARY KEY REFERENCES agent_steps_turns(id)) STRICT, WITHOUT ROWID',
  'CREATE TRIGGER agent_steps_reclaimable_insert AFTER INSERT ON agent_steps_terminal BEGIN INSERT INTO agent_steps_reclaimable VALUES(NEW.turn_id,NEW.settled_at); END',
];
export function compactAgentBodies(database: DatabaseSync, deadline: number) {
  let removed = 0;
  for (let i = 0; i < 32 && performance.now() < deadline; i++) {
    const row = agentStatement(
      database,
      'SELECT kind,digest FROM agent_steps_body_counts WHERE n=0 LIMIT 1',
    ).get();
    if (!row) break;
    if (
      !(row.digest instanceof Uint8Array) ||
      (row.kind !== 0 && row.kind !== 1 && row.kind !== 2)
    )
      throw new Error('DURABLE_AGENT_REFERENCE_DAMAGED');
    const digest = Buffer.from(row.digest);
    const text = `sha256:${digest.toString('hex')}`;
    const table =
      Number(row.kind) === 0
        ? 'bodies'
        : Number(row.kind) === 1
          ? 'body_nodes'
          : 'body_chunks';
    agentStatement(
      database,
      `DELETE FROM agent_steps_${table} WHERE digest=?`,
    ).run(Number(row.kind) === 1 ? digest : text);
    agentStatement(
      database,
      'DELETE FROM agent_steps_body_counts WHERE kind=? AND digest=? AND n=0',
    ).run(Number(row.kind), digest);
    forgetAgentBody(database, text, row.kind);
    removed++;
  }
  return removed;
}

/** Retire one terminal identity, then reclaim bounded batches across later commands. */
export function retainAgentTurns(
  database: DatabaseSync,
  now: number,
  deadline: number,
) {
  if (performance.now() >= deadline) return false;
  let pending = agentStatement(
    database,
    'SELECT turn_id FROM agent_steps_retained_cleanup LIMIT 1',
  ).get();
  if (!pending) {
    const expired = agentStatement(
      database,
      'SELECT t.id,t.record FROM agent_steps_reclaimable r JOIN agent_steps_turns t ON t.id=r.turn_id WHERE r.settled_at<=? ORDER BY r.settled_at LIMIT 1',
    ).get(now - 7 * 24 * 60 * 60 * 1000);
    if (expired) {
      const id = String(expired.id);
      const turn = JSON.parse(String(expired.record));
      turn.retired = true;
      turn.spec.input = '[expired]';
      agentStatement(
        database,
        'INSERT INTO agent_steps_retained VALUES(?,?)',
      ).run(id, now);
      agentStatement(
        database,
        'INSERT INTO agent_steps_retained_cleanup VALUES(?)',
      ).run(id);
      agentStatement(
        database,
        'DELETE FROM agent_steps_reclaimable WHERE turn_id=?',
      ).run(id);
      agentStatement(
        database,
        'UPDATE agent_steps_turns SET record=? WHERE id=?',
      ).run(canonical(turn), id);
      pending = { turn_id: id };
    }
  }
  if (pending) {
    const id = String(pending.turn_id);
    for (const table of ['approvals', 'effects', 'changes', 'frame_blocks']) {
      if (performance.now() >= deadline) break;
      const eligible =
        table === 'effects'
          ? ' AND NOT EXISTS(SELECT 1 FROM agent_steps_approvals a WHERE a.turn_id=agent_steps_effects.turn_id AND a.tool_id=agent_steps_effects.id)'
          : '';
      const remove = agentStatement(
        database,
        `DELETE FROM agent_steps_${table} WHERE rowid IN (SELECT rowid FROM agent_steps_${table} WHERE turn_id=?${eligible} LIMIT 1)`,
      );
      for (let row = 0; row < 16 && performance.now() < deadline; row++) {
        if (remove.run(id).changes === 0) break;
      }
    }
    if (
      !['approvals', 'effects', 'changes', 'frame_blocks'].some((table) =>
        agentStatement(
          database,
          `SELECT 1 FROM agent_steps_${table} WHERE turn_id=? LIMIT 1`,
        ).get(id),
      )
    )
      agentStatement(
        database,
        'DELETE FROM agent_steps_retained_cleanup WHERE turn_id=?',
      ).run(id);
  }
  return compactAgentBodies(database, deadline) > 0 || pending !== undefined;
}
