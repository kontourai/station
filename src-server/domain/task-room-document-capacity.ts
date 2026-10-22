import {
  MAX_REVISION_EVIDENCE_IDENTIFIER_BYTES,
  revisionEvidenceAdmission,
  revisionEvidenceRecordBytesUpperBound,
} from './revision-bound-evidence.js';
import {
  SHARED_WORKING_STATE_SCHEMA_VERSION,
  SharedWorkingState,
} from './shared-working-state.js';
import { lowSortingIntentId } from './shared-working-state-editing.js';

/**
 * Snapshot headroom a write that inserts text must leave, so a person can
 * still delete from a Task document that inserts have filled (#4007). A
 * deletion adds no atoms; it costs one known-operation entry, about 120 bytes.
 */
export const TASK_ROOM_INSERT_RESERVE_BYTES = 16 * 1024;

/**
 * A conservative round figure for messages: plain ASCII text of this length
 * always fits (the exact bound is pinned by its test; #4007 measured 5,472).
 */
export const TASK_ROOM_DOCUMENT_PLAIN_TEXT_CAPACITY = 5_400;

const PLACEHOLDER = 'x'.repeat(MAX_REVISION_EVIDENCE_IDENTIFIER_BYTES);

/**
 * Whether `text` can seed an empty Task document, judged by the same check
 * the room's working state applies before it commits (#4007). Scope and actor
 * identities are not known before the Task exists, so they are taken at
 * their maximum length: this can refuse a few characters early, never late.
 * The Station-wide evidence ledger is not consulted; a full ledger is still
 * refused explicitly when the seed is written.
 */
export function taskRoomDocumentSeedFits(text: string): boolean {
  if (text.length === 0) return true;
  const scope = {
    projectId: PLACEHOLDER,
    taskId: PLACEHOLDER,
    documentId: PLACEHOLDER,
  };
  const intentId = lowSortingIntentId(null);
  if (!intentId) return false;
  const state = new SharedWorkingState({ scope });
  const applied = state.apply(
    {
      schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
      operationId: `${intentId}:i`,
      documentId: scope.documentId,
      replicaId: PLACEHOLDER,
      actor: { actorId: PLACEHOLDER, kind: 'human' },
      parents: [],
      authorizationEpoch: 0,
      kind: 'insert',
      after: null,
      text,
    },
    {
      scope,
      epoch: 0,
      allowedActorIds: new Set([PLACEHOLDER]),
    },
  );
  if (applied.outcome !== 'applied') return false;
  const snapshotBytes = Buffer.byteLength(
    JSON.stringify(state.snapshot()),
    'utf8',
  );
  return (
    revisionEvidenceAdmission({
      snapshotBytes,
      textBytes: Buffer.byteLength(text, 'utf8'),
      recordBytes: revisionEvidenceRecordBytesUpperBound({
        snapshotBytes,
        text,
        scope,
        actor: {
          actorId: PLACEHOLDER,
          kind: 'human',
          displayLabel: PLACEHOLDER,
        },
        correlation: { projectId: PLACEHOLDER, taskId: PLACEHOLDER },
      }),
      reserveBytes: TASK_ROOM_INSERT_RESERVE_BYTES,
      ledger: { count: 0, recordBytes: 0 },
    }) === null
  );
}
