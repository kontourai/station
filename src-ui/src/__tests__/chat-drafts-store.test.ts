/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CHAT_DRAFTS_STORAGE_KEY,
  chatDraftsStore,
  MAX_DRAFT_LENGTH,
} from '../contexts/chat-drafts-store';

describe('chatDraftsStore', () => {
  beforeEach(() => {
    localStorage.clear();
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
    expect(Object.keys(persisted)).toHaveLength(20);
    expect(chatDraftsStore.get('session-0')).toBe('');
    expect(chatDraftsStore.get('session-20')).toBe('draft-20');
  });

  test('truncates each draft to twenty thousand characters', () => {
    chatDraftsStore.set('session-a', 'x'.repeat(MAX_DRAFT_LENGTH + 100));
    expect(chatDraftsStore.get('session-a')).toHaveLength(MAX_DRAFT_LENGTH);
  });
});
