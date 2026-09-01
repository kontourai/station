/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CHAT_DRAFTS_STORAGE_KEY,
  chatDraftsStore,
  MAX_DRAFT_LENGTH,
  MAX_DRAFTS,
  MAX_STASHED_IMAGES,
} from '../contexts/chat-drafts-store';
import type { FileAttachment } from '../types';

const image = (name: string): FileAttachment => ({
  id: name,
  name,
  type: 'image/png',
  size: 3,
  data: 'abc',
});

describe('chatDraftsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    chatDraftsStore.clearPortable();
    vi.restoreAllMocks();
  });

  test('survives a reload-like fresh read and clears after send', () => {
    chatDraftsStore.set('session-a', 'unsent message');
    expect(chatDraftsStore.get('session-a')).toBe('unsent message');
    chatDraftsStore.clear('session-a');
    expect(chatDraftsStore.get('session-a')).toBe('');
  });

  test('keeps at most twenty newest session drafts', () => {
    let now = 1;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    for (let index = 0; index < 21; index += 1) {
      chatDraftsStore.set(`session-${index}`, `draft-${index}`);
    }
    const persisted = JSON.parse(
      localStorage.getItem(CHAT_DRAFTS_STORAGE_KEY) || '{}',
    );
    expect(Object.keys(persisted.sessions)).toHaveLength(20);
    expect(chatDraftsStore.get('session-0')).toBe('');
    expect(chatDraftsStore.get('session-20')).toBe('draft-20');
  });

  test('truncates each draft to twenty thousand characters', () => {
    chatDraftsStore.set('session-a', 'x'.repeat(MAX_DRAFT_LENGTH + 100));
    expect(chatDraftsStore.get('session-a')).toHaveLength(MAX_DRAFT_LENGTH);
  });

  test('persists text before image encoding and classifies an encoding failure', async () => {
    const writes: string[] = [];
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      writes.push(value);
      setItem.call(this, key, value);
    });

    await chatDraftsStore.stash(
      'Crash-safe prompt',
      'words survive',
      [image('broken.png')],
      async () => {
        throw new Error('decode failed');
      },
    );

    const firstWrite = JSON.parse(writes[0]);
    expect(firstWrite.portable[0]).toMatchObject({
      text: 'words survive',
      attachments: [],
      unreadableImageNames: [],
    });
    expect(chatDraftsStore.getPortableSnapshot()[0]).toMatchObject({
      text: 'words survive',
      unreadableImageNames: ['broken.png'],
    });
  });

  test('keeps dropped and unreadable names distinct', async () => {
    const attachments = Array.from(
      { length: MAX_STASHED_IMAGES + 1 },
      (_, index) => image(`image-${index}.png`),
    );
    const draft = await chatDraftsStore.stash(
      'Image outcomes',
      'prompt',
      attachments,
      async (attachment) => {
        if (attachment.name === 'image-0.png') throw new Error('bad bytes');
        return attachment;
      },
    );
    expect(draft.unreadableImageNames).toEqual(['image-0.png']);
    expect(draft.droppedImageNames).toEqual([
      `image-${MAX_STASHED_IMAGES}.png`,
    ]);
  });

  test('caps portable drafts at twenty in newest-first order', async () => {
    let now = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    for (let index = 0; index <= MAX_DRAFTS; index += 1) {
      await chatDraftsStore.stash(`draft-${index}`, `text-${index}`, []);
    }
    const drafts = chatDraftsStore.getPortableSnapshot();
    expect(drafts).toHaveLength(MAX_DRAFTS);
    expect(drafts[0]?.name).toBe(`draft-${MAX_DRAFTS}`);
    expect(drafts.at(-1)?.name).toBe('draft-1');
  });

  test('portable records structurally cannot carry execution selection', async () => {
    const draft = await chatDraftsStore.stash('Portable', 'move me', []);
    expect(Object.keys(draft)).not.toEqual(
      expect.arrayContaining([
        'model',
        'engine',
        'provider',
        'connectionId',
        'agentConnectionId',
      ]),
    );
  });
});
