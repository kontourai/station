/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { chatDraftsStore } from '../contexts/chat-drafts-store';
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

  test('chat and Station-scoped Activity drafts survive fresh reads and clear after send', async () => {
    chatDraftsStore.set('session-a', 'unsent message');
    chatDraftsStore.setActivityDraft(
      'https://station-a.example',
      'same-session',
      'A follow-up',
    );
    chatDraftsStore.setActivityDraft(
      'https://station-b.example',
      'same-session',
      'B follow-up',
    );
    vi.resetModules();
    const { chatDraftsStore: reloaded } = await import(
      '../contexts/chat-drafts-store'
    );
    expect(reloaded.get('session-a')).toBe('unsent message');
    expect(
      reloaded.getActivityDraft('https://station-a.example', 'same-session'),
    ).toBe('A follow-up');
    expect(
      reloaded.getActivityDraft('https://station-b.example', 'same-session'),
    ).toBe('B follow-up');
    expect(Object.keys(reloaded.getSnapshot())).toEqual(['session-a']);

    reloaded.clear('session-a');
    reloaded.clearActivityDraft('https://station-a.example', 'same-session');
    vi.resetModules();
    const { chatDraftsStore: afterSend } = await import(
      '../contexts/chat-drafts-store'
    );
    expect(afterSend.get('session-a')).toBe('');
    expect(
      afterSend.getActivityDraft('https://station-a.example', 'same-session'),
    ).toBe('');
    expect(
      afterSend.getActivityDraft('https://station-b.example', 'same-session'),
    ).toBe('B follow-up');
    // The statically imported instance still holds the draft in memory.
    chatDraftsStore.clear('session-a');
    chatDraftsStore.clearActivityDraft(
      'https://station-a.example',
      'same-session',
    );
    chatDraftsStore.clearActivityDraft(
      'https://station-b.example',
      'same-session',
    );
  });

  test('keeps at most twenty newest session drafts', () => {
    let now = 1;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    for (let index = 0; index < 21; index += 1) {
      chatDraftsStore.set(`session-${index}`, `draft-${index}`);
    }
    const persisted = JSON.parse(
      localStorage.getItem('station:chat-drafts:v1') || '{}',
    );
    expect(Object.keys(persisted.sessions)).toHaveLength(20);
    expect(chatDraftsStore.get('session-0')).toBe('');
    expect(chatDraftsStore.get('session-20')).toBe('draft-20');
  });

  test('truncates each draft to twenty thousand characters', () => {
    chatDraftsStore.set('session-a', 'x'.repeat(20_100));
    expect(chatDraftsStore.get('session-a')).toHaveLength(20_000);
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
    // Five images fit in a stash; the sixth is dropped by name.
    const attachments = Array.from({ length: 6 }, (_, index) =>
      image(`image-${index}.png`),
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
    expect(draft.droppedImageNames).toEqual(['image-5.png']);
  });

  // A reload into a newer build reads whatever an older one wrote. One
  // attachment entry in another shape used to reach the composer and throw
  // inside render (`type.startsWith`), taking the chat pane down with it.
  test('drops portable draft attachments that are not the shape the composer reads', async () => {
    localStorage.setItem(
      'station:chat-drafts:v1',
      JSON.stringify({
        sessions: {},
        portable: [
          {
            id: 'p1',
            name: 'old build',
            text: 'kept',
            createdAt: 1,
            attachments: [image('good.png'), { name: 'bad.png' }, 'x', null],
            droppedImageNames: ['a.png', 5],
            unreadableImageNames: [{}],
          },
        ],
      }),
    );
    vi.resetModules();
    const { chatDraftsStore: reloaded } = await import(
      '../contexts/chat-drafts-store'
    );
    const [draft] = reloaded.getPortableSnapshot();
    expect(draft?.text).toBe('kept');
    expect(draft?.attachments).toEqual([image('good.png')]);
    expect(draft?.droppedImageNames).toEqual(['a.png']);
    expect(draft?.unreadableImageNames).toEqual([]);
  });

  test('caps portable drafts at twenty in newest-first order', async () => {
    let now = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    for (let index = 0; index <= 20; index += 1) {
      await chatDraftsStore.stash(`draft-${index}`, `text-${index}`, []);
    }
    const drafts = chatDraftsStore.getPortableSnapshot();
    expect(drafts).toHaveLength(20);
    expect(drafts[0]?.name).toBe('draft-20');
    expect(drafts.at(-1)?.name).toBe('draft-1');
  });

  test('portable records structurally cannot carry execution selection', async () => {
    const draft = await chatDraftsStore.stash('Portable', 'move me', []);
    for (const key of [
      'model',
      'engine',
      'provider',
      'connectionId',
      'agentConnectionId',
    ]) {
      expect(draft).not.toHaveProperty(key);
    }
  });
});
