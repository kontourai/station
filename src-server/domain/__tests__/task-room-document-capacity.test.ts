import { describe, expect, test } from 'vitest';
import {
  TASK_ROOM_DOCUMENT_PLAIN_TEXT_CAPACITY,
  taskRoomDocumentSeedFits,
} from '../task-room-document-capacity.js';

describe('Task room document capacity (#4007)', () => {
  test('admits the longest proposal brief and refuses text beyond the evidence text bound', () => {
    expect(TASK_ROOM_DOCUMENT_PLAIN_TEXT_CAPACITY).toBeGreaterThanOrEqual(
      12_000,
    );
    expect(taskRoomDocumentSeedFits('a'.repeat(12_000))).toBe(true);
    expect(taskRoomDocumentSeedFits('😀'.repeat(6_000))).toBe(true);
    expect(taskRoomDocumentSeedFits('a'.repeat(256 * 1024 + 1))).toBe(false);
  });
});
