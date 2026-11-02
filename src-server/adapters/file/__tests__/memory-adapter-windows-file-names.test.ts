import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Conversation } from '@voltagent/core';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createMemoryConversationStore } from '../memory-adapter-conversations.js';
import { MemoryAdapterPaths } from '../memory-adapter-paths.js';

const makeTempDir = trackTempDirs();

describe('conversation file names on Windows', () => {
  test('percent-encodes the characters Windows refuses, and only on Windows', () => {
    const windows = new MemoryAdapterPaths('/home', 'win32');
    const linux = new MemoryAdapterPaths('/home', 'linux');

    expect(basename(windows.getConversationPath('a', 'codex:1793'))).toBe(
      'codex%3A1793.json',
    );
    expect(basename(windows.getMessagesPath('a', 'codex:1793'))).toBe(
      'codex%3A1793.ndjson',
    );
    expect(
      basename(windows.getConversationWorkingMemoryPath('a', 'codex:1793')),
    ).toBe('codex%3A1793.json');
    // `%` is encoded first, so two different ids never share a file.
    expect(basename(windows.getConversationPath('a', 'x%3Ay'))).toBe(
      'x%253Ay.json',
    );
    // Existing files elsewhere keep their names.
    expect(basename(linux.getConversationPath('a', 'codex:1793'))).toBe(
      'codex:1793.json',
    );
  });

  // A native engine conversation id (`codex:<id>`) must persist and reload on
  // this host: a fork writes the source conversation to disk, which failed
  // with ENOENT on Windows before the encoding.
  test('persists and reloads a native engine conversation id', async () => {
    const dir = makeTempDir('memory-adapter-win-names-');
    const paths = new MemoryAdapterPaths(dir);
    const store = createMemoryConversationStore({
      paths,
      logger: { error: vi.fn<Console['error']>() },
    });
    const conversation: Conversation = {
      id: 'codex:1793602366286',
      resourceId: 'codex',
      userId: 'user-1',
      title: 'Engine chat',
      metadata: {},
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    };

    await store.persistConversation(conversation);

    expect(await store.loadConversationFromDisk(conversation.id)).toEqual(
      conversation,
    );
    expect(
      readdirSync(join(dir, 'agents', 'codex', 'memory', 'conversations')),
    ).toEqual([basename(paths.getConversationPath('codex', conversation.id))]);
  });
});
