import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './encoding.js';
import { projectAgentFrames } from './turn-projection.js';
import { agentStatement } from './turn-statements.js';

const liveBodies =
  "SELECT tree.value FROM agent_steps_effects e,json_tree(e.record) tree WHERE tree.type='text' AND tree.value GLOB 'sha256:*'";
export const retainedBodyDefinitions = [
  `CREATE TRIGGER agent_steps_bodies_no_delete BEFORE DELETE ON agent_steps_bodies WHEN OLD.digest IN (${liveBodies}) BEGIN SELECT RAISE(ABORT,'immutable agent body'); END`,
  "CREATE TRIGGER agent_steps_body_chunks_no_delete BEFORE DELETE ON agent_steps_body_chunks WHEN EXISTS(SELECT 1 FROM agent_steps_bodies b,json_each(b.wire,'$.chunks') c WHERE c.value=OLD.digest) BEGIN SELECT RAISE(ABORT,'immutable agent chunk'); END",
];
export const retentionDefinitions = [
  'CREATE TABLE agent_steps_retained(turn_id TEXT PRIMARY KEY REFERENCES agent_steps_turns(id), expired_at INTEGER NOT NULL CHECK(expired_at>0)) STRICT',
  'CREATE INDEX agent_steps_terminal_age ON agent_steps_terminal(state,settled_at)',
];
/** Reclaim unreachable payloads; live recovery roots remain protected by triggers. */
export function compactAgentBodies(database: DatabaseSync) {
  agentStatement(
    database,
    `DELETE FROM agent_steps_bodies WHERE digest NOT IN (${liveBodies})`,
  ).run();
  agentStatement(
    database,
    "DELETE FROM agent_steps_body_chunks WHERE digest NOT IN (SELECT c.value FROM agent_steps_bodies b,json_each(b.wire,'$.chunks') c)",
  ).run();
}

/** Seven-day replay window; retain a small refusing tombstone, never an uncertain turn. */
export function retainAgentTurns(database: DatabaseSync, now: number) {
  const expired = agentStatement(
    database,
    "SELECT t.id,t.record FROM agent_steps_terminal s JOIN agent_steps_turns t ON t.id=s.turn_id WHERE s.state='completed' AND s.settled_at<=? AND NOT EXISTS(SELECT 1 FROM agent_steps_retained r WHERE r.turn_id=t.id) ORDER BY s.settled_at LIMIT 16",
  ).all(now - 7 * 24 * 60 * 60 * 1000);
  for (const row of expired) {
    const id = String(row.id);
    const turn = JSON.parse(String(row.record));
    turn.retired = true;
    turn.spec.input = '[expired]';
    agentStatement(
      database,
      'INSERT INTO agent_steps_retained VALUES(?,?)',
    ).run(id, now);
    agentStatement(
      database,
      'UPDATE agent_steps_turns SET record=? WHERE id=?',
    ).run(canonical(turn), id);
    agentStatement(
      database,
      'DELETE FROM agent_steps_effects WHERE turn_id=?',
    ).run(id);
    agentStatement(
      database,
      'DELETE FROM agent_steps_approvals WHERE turn_id=?',
    ).run(id);
    agentStatement(
      database,
      'DELETE FROM agent_steps_changes WHERE turn_id=?',
    ).run(id);
    agentStatement(
      database,
      'DELETE FROM agent_steps_frames WHERE turn_id=?',
    ).run(id);
    agentStatement(
      database,
      'DELETE FROM agent_steps_frame_blocks WHERE turn_id=?',
    ).run(id);
    projectAgentFrames(
      database,
      id,
      [
        {
          type: 'projectFrame',
          key: turn.spec.key,
          expected: turn.fence,
          id: 'retained:error',
          wire: `data: ${JSON.stringify({ type: 'error', code: 'DURABLE_AGENT_REPLAY_EXPIRED', errorText: 'The saved output for this turn has expired. The turn will not be run again.' })}\n\n`,
        },
        {
          type: 'projectFrame',
          key: turn.spec.key,
          expected: turn.fence,
          id: 'retained:done',
          wire: 'data: [DONE]\n\n',
        },
      ],
      now,
    );
  }
  return expired.length;
}
