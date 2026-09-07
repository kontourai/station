import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { JsonFileStore } from '../../infra/json-store.js';
import { FileConversationAcknowledgementStore } from '../conversation-acknowledgement-store.js';

describe('FileConversationAcknowledgementStore', () => {
  test('treats an absent store as an honest empty state and writes the first acknowledgement', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'station-conversation-empty-'));
    const store = new FileConversationAcknowledgementStore(dataDir);

    expect(
      store.getMany('brian', ['thread-1']).get('thread-1'),
    ).toBeUndefined();
    store.acknowledge({
      userId: 'brian',
      conversationId: 'thread-1',
      updatedAt: '2026-08-02T20:00:00.000Z',
    });

    expect(store.getMany('brian', ['thread-1']).get('thread-1')).toBe(
      '2026-08-02T20:00:00.000Z',
    );
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
    expect(restarted.getMany('brian', ['thread-1']).get('thread-1')).toBe(
      '2026-08-02T20:00:00.000Z',
    );
    expect(
      restarted.getMany('other-user', ['thread-1']).get('thread-1'),
    ).toBeUndefined();
  });

  test('batches one snapshot, scopes it to the user, and sees external writes on the next read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-ack-batch-'));
    const path = join(dir, 'conversation-acknowledgements.json');
    const ids = Array.from({ length: 100 }, (_, i) => `thread-${i}`);
    const write = (version: string) =>
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          acknowledgements: {
            brian: Object.fromEntries(ids.map((id) => [id, version])),
            other: { private: version },
          },
        }),
      );
    write('2026-09-05T00:00:00Z');
    const store = new FileConversationAcknowledgementStore(dir);
    const read = vi.spyOn(JsonFileStore.prototype, 'read');
    try {
      const snapshot = store.getMany('brian', [...ids, 'private', 'missing']);
      expect(snapshot.size).toBe(100);
      expect(snapshot.get('private')).toBeUndefined();
      expect(snapshot.get('missing')).toBeUndefined();
      expect(read).toHaveBeenCalledTimes(1);
      write('2026-09-05T01:00:00Z');
      expect(store.getMany('brian', ids).get(ids[0])).toBe(
        '2026-09-05T01:00:00Z',
      );
      expect(snapshot.get(ids[0])).toBe('2026-09-05T00:00:00Z');
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a readable-corrupt store without overwriting its original bytes', () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), 'station-conversation-corrupt-'),
    );
    const storePath = join(dataDir, 'conversation-acknowledgements.json');
    const corruptBytes = '{"version":1,"acknowledgements":';
    writeFileSync(storePath, corruptBytes, 'utf8');
    const store = new FileConversationAcknowledgementStore(dataDir);

    expect(() => store.getMany('brian', ['thread-1']).get('thread-1')).toThrow(
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
