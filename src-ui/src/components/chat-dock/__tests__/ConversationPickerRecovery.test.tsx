/** @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConversationPickerRecovery } from '../ConversationPickerRecovery';
import type { ConversationOpenRecovery } from '../conversationOpenController';

afterEach(cleanup);

const conversation = {
  id: 'conv-1',
  source: 'runtime',
  agentSlug: 'codex',
  title: 'New chat',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:01:00.000Z',
  messageCount: 0,
  mutable: false,
  answerability: { answerable: true },
} as unknown as ConversationOpenRecovery['conversation'];

function renderRecovery(
  callerAccess?: ConversationOpenRecovery['callerAccess'],
) {
  render(
    <ConversationPickerRecovery
      recovery={{
        conversation,
        status: 'unavailable',
        ...(callerAccess ? { callerAccess } : {}),
      }}
      onRetry={vi.fn()}
      onStartNew={vi.fn()}
    />,
  );
}

// The chat dock's picker path: a conversation chosen from the picker that
// could not be opened writable. Start new chat follows the server's
// per-caller answer from the open read.
describe('ConversationPickerRecovery', () => {
  test('withholds Start new chat when the server says this caller may not start one', async () => {
    renderRecovery({ continue: false, startChat: false });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start new chat' })).toBeNull();
  });

  test('offers Start new chat when the server says this caller may', async () => {
    renderRecovery({ continue: false, startChat: true });
    expect(
      await screen.findByRole('button', { name: 'Start new chat' }),
    ).toBeTruthy();
  });

  test('offers Start new chat when the server said nothing (unknown shows)', async () => {
    renderRecovery();
    expect(
      await screen.findByRole('button', { name: 'Start new chat' }),
    ).toBeTruthy();
  });
});
