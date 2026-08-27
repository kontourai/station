import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FileConversationAcknowledgementStore } from '../conversation-acknowledgement-store.js';

describe('FileConversationAcknowledgementStore', () => {
  test('treats an absent store as an honest empty state and writes the first acknowledgement', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'station-conversation-empty-'));
    const store = new FileConversationAcknowledgementStore(dataDir);

    expect(store.get('brian', 'thread-1')).toBeUndefined();
    store.acknowledge({
      userId: 'brian',
      conversationId: 'thread-1',
      updatedAt: '2026-08-02T20:00:00.000Z',
    });

    expect(store.get('brian', 'thread-1')).toBe('2026-08-02T20:00:00.000Z');
  });

  test('persists a user-scoped rendered conversation version across instances', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'station-conversation-read-'));
    const first = new FileConversationAcknowledgementStore(dataDir);

    first.acknowledge({
      userId: 'brian',
      conversationId: 'thread-1',
      updatedAt: '2026-08-02T20:00:00.000Z',
    });

    const restarted = new FileConversationAcknowledgementStore(dataDir);
    expect(restarted.get('brian', 'thread-1')).toBe('2026-08-02T20:00:00.000Z');
    expect(restarted.get('other-user', 'thread-1')).toBeUndefined();
  });

  test('refuses a readable-corrupt store without overwriting its original bytes', () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), 'station-conversation-corrupt-'),
    );
    const storePath = join(dataDir, 'conversation-acknowledgements.json');
    const corruptBytes = '{"version":1,"acknowledgements":';
    writeFileSync(storePath, corruptBytes, 'utf8');
    const store = new FileConversationAcknowledgementStore(dataDir);

    expect(() => store.get('brian', 'thread-1')).toThrow(
      'JSON store is corrupt',
    );
    expect(() =>
      store.acknowledge({
        userId: 'brian',
        conversationId: 'thread-1',
        updatedAt: '2026-08-02T20:00:00.000Z',
      }),
    ).toThrow('JSON store is corrupt');
    expect(readFileSync(storePath, 'utf8')).toBe(corruptBytes);
  });
});
