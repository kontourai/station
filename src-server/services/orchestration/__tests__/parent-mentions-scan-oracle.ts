// Frozen from EventStore at 0e8d6df7: independent legacy-query oracle for #3569.
import type { DatabaseSync } from 'node:sqlite';
import { DELEGATION_PROVENANCE_METADATA_KEY } from '@kontourai/station-contracts/provider';
import type { SessionNamingParent } from '../event-store.js';

const EVENT_STORE_BATCH_CHUNK_SIZE = 500;
export function scanSessionsNamingParents(
  db: DatabaseSync,
  parentIds: readonly string[],
  limit: number,
): {
  sessions: SessionNamingParent[];
  truncated: boolean;
} {
  const unique = [...new Set(parentIds)];
  const result: SessionNamingParent[] = [];
  let truncated = false;
  if (unique.length === 0 || limit < 1) return { sessions: result, truncated };
  const seen = new Set<string>();
  for (
    let offset = 0;
    offset < unique.length;
    offset += EVENT_STORE_BATCH_CHUNK_SIZE
  ) {
    const chunk = unique.slice(offset, offset + EVENT_STORE_BATCH_CHUNK_SIZE);
    const list = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT e.thread_id AS thread_id,
                  MAX(COALESCE(
                    json_extract(e.payload, '$.metadata.delegation.parentConversationId'),
                    json_extract(e.payload, '$.metadata.parentConversationId'))) AS verified_parent,
                  MAX(json_extract(e.payload, '$.metadata.parentTaskId')) AS claimed_parent,
                  MAX(CASE
                    WHEN e.method = 'session.started'
                     AND json_extract(e.payload, '$.metadata.${DELEGATION_PROVENANCE_METADATA_KEY}') IN ('caller-derived', 'runtime-attested')
                    THEN COALESCE(
                      json_extract(e.payload, '$.metadata.delegation.parentConversationId'),
                      json_extract(e.payload, '$.metadata.parentConversationId'))
                  END) AS derived_parent,
                  MIN(e.global_sequence) AS first_sequence
             FROM orchestration_events e
            WHERE e.method IN ('session.started', 'session.configured')
              AND json_valid(e.payload)
              AND (json_extract(e.payload, '$.metadata.delegation.parentConversationId') IN (${list})
                OR json_extract(e.payload, '$.metadata.parentConversationId') IN (${list})
                OR json_extract(e.payload, '$.metadata.parentTaskId') IN (${list}))
            GROUP BY e.thread_id
            ORDER BY first_sequence ASC
            LIMIT ?`,
      )
      .all(...chunk, ...chunk, ...chunk, limit + 1) as Array<{
      thread_id: string;
      verified_parent: unknown;
      claimed_parent: unknown;
      derived_parent: unknown;
    }>;
    // One row past the bound proves there is more than it allows.
    if (rows.length > limit) truncated = true;
    const named = new Set(chunk);
    for (const row of rows) {
      // Matched by another chunk's parents already.
      if (seen.has(row.thread_id)) continue;
      // A delegation context decides; a parent task id counts only when
      // there is none.
      const verified =
        typeof row.verified_parent === 'string'
          ? row.verified_parent
          : undefined;
      const claimed =
        typeof row.claimed_parent === 'string' ? row.claimed_parent : undefined;
      if (verified !== undefined) {
        // Pushed by the chunk that names the verified parent, if any.
        if (named.has(verified)) {
          seen.add(row.thread_id);
          result.push({
            threadId: row.thread_id,
            parentId: verified,
            binding: 'delegation-context',
            stationDerived: row.derived_parent === verified,
          });
        }
        continue;
      }
      if (claimed !== undefined && named.has(claimed)) {
        seen.add(row.thread_id);
        result.push({
          threadId: row.thread_id,
          parentId: claimed,
          binding: 'parent-task-id',
          stationDerived: false,
        });
      }
    }
  }
  return { sessions: result, truncated };
}
