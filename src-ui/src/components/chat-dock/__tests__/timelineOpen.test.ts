import { agentId } from '@kontourai/station-contracts/agent-identity';
import { beforeEach, expect, test, vi } from 'vitest';

const open = vi.hoisted(() => vi.fn());
vi.mock('../../../hooks/orchestration/replay/controller', () => ({
  openConversationTimeline: open,
}));

import { openTimeline } from '../timelineOpen';

const session = {
  id: 'chat-1',
  conversationId: 'conversation-1',
  agentSlug: agentId('codex'),
  agentName: 'Codex',
  title: 'Conversation',
} as never;
const authority = {
  apiBase: 'http://station.test',
  authorityKey: 'authority-1',
  isCurrent: () => true,
};

beforeEach(() => open.mockReset());

test('shows one persistent loading notice and coalesces duplicate opens', async () => {
  let finish!: () => void;
  open.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
  const notify = vi.fn(() => 'loading-toast');
  const dismiss = vi.fn();
  const first = openTimeline(
    'http://station.test',
    session,
    authority,
    notify,
    dismiss,
    () => true,
  );
  const duplicate = openTimeline(
    'http://station.test',
    session,
    authority,
    notify,
    dismiss,
    () => true,
  );
  expect(first).toBe(duplicate);
  expect(notify).toHaveBeenCalledWith(
    'Loading conversation history…',
    undefined,
    0,
  );
  await Promise.resolve();
  expect(open).toHaveBeenCalledTimes(1);
  finish();
  await first;
  expect(dismiss).toHaveBeenCalledWith('loading-toast');
});

test('turns an unavailable authority into visible feedback without an unhandled rejection', async () => {
  const notify = vi.fn(() => 'loading-toast');
  const dismiss = vi.fn();
  await expect(
    openTimeline(
      'http://station.test',
      session,
      { ...authority, isCurrent: () => false },
      notify,
      dismiss,
      () => true,
    ),
  ).resolves.toBeUndefined();
  expect(notify).toHaveBeenLastCalledWith(
    'Conversation history authorization is no longer current.',
  );
  expect(dismiss).toHaveBeenCalledWith('loading-toast');
  expect(open).not.toHaveBeenCalled();
});
