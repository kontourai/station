/**
 * @vitest-environment jsdom
 *
 * #4397: the phone drawer lists recent chats and opens them through Home's
 * Continue action; "See all" opens the dock's Inbox.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { HomeWorkItem } from '../../../views/home/home-view-model';

const home = vi.hoisted(() => ({
  workItems: [] as HomeWorkItem[],
  continueWork: vi.fn(),
}));
vi.mock('../../../views/home/useHomeViewModel', () => ({
  useHomeViewModel: () => ({
    workItems: home.workItems,
    continueWork: home.continueWork,
  }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: vi.fn(), setLayout: vi.fn() }),
}));
const openCollection = vi.hoisted(() => vi.fn());
vi.mock('../../../contexts/open-chats-store', () => ({
  openChatsStore: { openCollection },
}));

const { ProjectSidebarRecentChats, selectRecentChats, RECENT_CHAT_LIMIT } =
  await import('../ProjectSidebarRecentChats');

function item(
  id: string,
  updatedAt: number,
  overrides: Partial<HomeWorkItem> = {},
): HomeWorkItem {
  return {
    id,
    conversationId: id,
    kind: 'chat',
    kindLabel: 'Conversation',
    title: `Chat ${id}`,
    projectLabel: 'No project',
    agentLabel: 'Codex',
    modelLabel: '',
    updatedAt,
    lifecycleLabel: 'Done',
    ...overrides,
  } as HomeWorkItem;
}

beforeEach(() => {
  home.workItems = [];
  home.continueWork.mockReset();
  openCollection.mockReset();
});

describe('selectRecentChats', () => {
  test('lists conversations newest first, each once, without Tasks or drafts', () => {
    const recent = selectRecentChats([
      item('a', 1),
      item('b', 3),
      item('b', 2, { kind: 'orchestration', id: 'thread-b' }),
      item('t', 9, { kind: 'task' }),
      item('d', 8, { lifecycleLabel: 'Draft' }),
    ]);
    expect(recent.map((entry) => entry.title)).toEqual(['Chat b', 'Chat a']);
  });

  test('stops at the drawer limit', () => {
    const many = Array.from({ length: RECENT_CHAT_LIMIT + 3 }, (_, index) =>
      item(`c${index}`, index),
    );
    expect(selectRecentChats(many)).toHaveLength(RECENT_CHAT_LIMIT);
  });
});

describe('ProjectSidebarRecentChats', () => {
  test('renders nothing without a conversation', () => {
    const { container } = render(
      <ProjectSidebarRecentChats onAfterNavigate={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
  });

  test('opens a chat through Continue and closes the drawer', () => {
    const chat = item('a', 1);
    home.workItems = [chat];
    const onAfterNavigate = vi.fn();
    render(<ProjectSidebarRecentChats onAfterNavigate={onAfterNavigate} />);
    expect(screen.getByRole('region', { name: 'Recent chats' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Chat a' }));
    expect(home.continueWork).toHaveBeenCalledWith(chat);
    expect(onAfterNavigate).toHaveBeenCalledTimes(1);
  });

  test('See all opens the Inbox', () => {
    home.workItems = [item('a', 1)];
    const onAfterNavigate = vi.fn();
    render(<ProjectSidebarRecentChats onAfterNavigate={onAfterNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'See all' }));
    expect(openCollection).toHaveBeenCalledTimes(1);
    expect(onAfterNavigate).toHaveBeenCalledTimes(1);
  });
});
