import { describe, expect, test } from 'vitest';
import {
  TASK_ROOM_DOCUMENT_PLAIN_TEXT_CAPACITY,
  taskRoomDocumentSeedFits,
} from '../task-room-document-capacity.js';

describe('Task room document capacity (#4007)', () => {
  test('a seed fits up to the measured bound and is refused one character past it', () => {
    // Measured with maximum-length scope identities; the real room admits a
    // few more (see project-task-room-capacity.test.ts).
    expect(taskRoomDocumentSeedFits('a'.repeat(5_472))).toBe(true);
    expect(taskRoomDocumentSeedFits('a'.repeat(5_473))).toBe(false);
    expect(TASK_ROOM_DOCUMENT_PLAIN_TEXT_CAPACITY).toBe(5_400);
    expect(
      taskRoomDocumentSeedFits(
        'a'.repeat(TASK_ROOM_DOCUMENT_PLAIN_TEXT_CAPACITY),
      ),
    ).toBe(true);
    // The longest proposal brief does not fit; acceptance refuses it up front.
    expect(taskRoomDocumentSeedFits('a'.repeat(12_000))).toBe(false);
  });
});
