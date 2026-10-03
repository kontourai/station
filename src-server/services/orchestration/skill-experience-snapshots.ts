import { createHash } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type {
  SkillExperienceInvocationReferenceV1,
  SkillExperienceInvocationV1,
} from '@kontourai/station-contracts/skill-experience';
import { isRecord } from '../../utils/is-record.js';
import {
  experienceIdentityEqual,
  parseExperienceSnapshot,
} from './skill-experience-model.js';

const MAX_SNAPSHOT_BYTES = 256 * 1024;

export interface SkillExperienceSnapshots {
  deleteThread(threadId: string): void;
  record(
    threadId: string,
    snapshot: SkillExperienceInvocationV1,
  ): SkillExperienceInvocationReferenceV1;
  read(
    reference: SkillExperienceInvocationReferenceV1,
  ): SkillExperienceInvocationV1;
}

/** Immutable presentation data; only canonical Session events establish invocation. */
export function createSkillExperienceSnapshots(db: {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...parameters: SQLInputValue[]): unknown;
    get(...parameters: SQLInputValue[]): unknown;
  };
}): SkillExperienceSnapshots {
  db.exec(`CREATE TABLE IF NOT EXISTS skill_experience_snapshots (
    thread_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    PRIMARY KEY(thread_id, invocation_id)
  )`);
  const readRow = db.prepare(
    'SELECT snapshot_digest, snapshot_json FROM skill_experience_snapshots WHERE thread_id = ? AND invocation_id = ?',
  );
  const insert = db.prepare(
    'INSERT OR IGNORE INTO skill_experience_snapshots (thread_id, invocation_id, snapshot_digest, snapshot_json) VALUES (?, ?, ?, ?)',
  );
  const remove = db.prepare(
    'DELETE FROM skill_experience_snapshots WHERE thread_id = ?',
  );
  return {
    deleteThread(threadId) {
      remove.run(threadId);
    },
    record(threadId, snapshot) {
      const text = JSON.stringify(snapshot);
      if (
        !threadId ||
        threadId.length > 512 ||
        Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES ||
        !parseExperienceSnapshot(snapshot)
      )
        throw new Error(
          'Skill experience snapshot exceeds the supported bounds or is invalid.',
        );
      const digest = createHash('sha256').update(text).digest('hex');
      insert.run(threadId, snapshot.clientTurnId, digest, text);
      const stored = readRow.get(threadId, snapshot.clientTurnId);
      if (
        !isRecord(stored) ||
        stored.snapshot_digest !== digest ||
        stored.snapshot_json !== text
      )
        throw new Error(
          'This dispatch identity already belongs to a different Skill experience snapshot.',
        );
      return {
        version: '1.0',
        invocationId: snapshot.clientTurnId,
        snapshotSessionId: threadId,
        snapshotDigest: digest,
        identity: snapshot.identity,
      };
    },
    read(reference) {
      const row = readRow.get(
        reference.snapshotSessionId,
        reference.invocationId,
      );
      if (
        !isRecord(row) ||
        row.snapshot_digest !== reference.snapshotDigest ||
        typeof row.snapshot_json !== 'string' ||
        row.snapshot_json.length > MAX_SNAPSHOT_BYTES ||
        Buffer.byteLength(row.snapshot_json) > MAX_SNAPSHOT_BYTES ||
        createHash('sha256').update(row.snapshot_json).digest('hex') !==
          reference.snapshotDigest
      )
        throw new Error(
          'The retained Skill experience snapshot is missing or corrupt.',
        );
      const snapshot = parseExperienceSnapshot(JSON.parse(row.snapshot_json));
      if (
        !snapshot ||
        snapshot.clientTurnId !== reference.invocationId ||
        !experienceIdentityEqual(snapshot.identity, reference.identity)
      )
        throw new Error(
          'The retained Skill experience snapshot is incompatible or has a different identity.',
        );
      return snapshot;
    },
  };
}
