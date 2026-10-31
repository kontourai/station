import { describe, expect, test } from 'vitest';
import { revisionEvidenceAdmission } from '../revision-bound-evidence.js';
import {
  TASK_ROOM_DOCUMENT_PLAIN_TEXT_CAPACITY,
  TASK_ROOM_INSERT_RESERVE_BYTES,
  taskRoomDocumentSeedFits,
} from '../task-room-document-capacity.js';

describe('Task room document capacity (#4007)', () => {
  test('admits the longest proposal brief and refuses text beyond the evidence text bound', () => {
    expect(TASK_ROOM_DOCUMENT_PLAIN_TEXT_CAPACITY).toBeGreaterThanOrEqual(
      12_000,
    );
    expect(taskRoomDocumentSeedFits('a'.repeat(12_000))).toBe(true);
    expect(taskRoomDocumentSeedFits('😀'.repeat(6_000))).toBe(true);
    expect(taskRoomDocumentSeedFits('a'.repeat(256 * 1024))).toBe(true);
    expect(taskRoomDocumentSeedFits('a'.repeat(256 * 1024 + 1))).toBe(false);
  });

  test('leaves deletion headroom at the evidence record bound as well as the snapshot bound', () => {
    const usage = {
      snapshotBytes: 128 * 1024,
      textBytes: 64 * 1024,
      recordBytes: 768 * 1024,
      ledger: { count: 0, recordBytes: 0 },
    };
    expect(
      revisionEvidenceAdmission({
        ...usage,
        reserveBytes: TASK_ROOM_INSERT_RESERVE_BYTES,
      }),
    ).toBe('document-full');
    expect(
      revisionEvidenceAdmission({
        ...usage,
        recordBytes: usage.recordBytes - TASK_ROOM_INSERT_RESERVE_BYTES,
        reserveBytes: TASK_ROOM_INSERT_RESERVE_BYTES,
      }),
    ).toBeNull();
    expect(revisionEvidenceAdmission(usage)).toBeNull();
    expect(
      revisionEvidenceAdmission({
        ...usage,
        recordBytes: usage.recordBytes + 1,
      }),
    ).toBe('document-full');
  });
});
