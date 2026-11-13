// @vitest-environment jsdom
import type {
  ChildWorkItem,
  ChildWorkTranscriptEntry,
} from '@kontourai/station-contracts/child-work';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SubagentTranscriptCard } from '../components/chat/SubagentTranscriptCard';
import { ChildChatNavigation } from '../components/chat-dock/ChildChatNavigation';
import {
  childChatTarget,
  useChildChatNavigation,
} from '../components/chat-dock/ChildChatNavigationContext';
import { ConversationConnectionProvider } from '../components/conversation/ConversationConnectionContext';
import { PreviewProvider } from '../contexts/PreviewContext';

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));
vi.mock('../components/chat/ChildWorkInstructionPanel', () => ({
  ChildWorkInstructionPanel: () => null,
}));
const history = vi.hoisted(() => ({
  entries: [
    { kind: 'text', message: 0, role: 'user', text: 'Inspect the child files' },
    {
      kind: 'text',
      message: 1,
      role: 'assistant',
      text: '## Child answer\n\nThe files are ready.',
    },
  ] as ChildWorkTranscriptEntry[],
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useChildWorkTranscriptQuery: vi.fn(() => ({
    data: { pages: [{ entries: history.entries }] },
    isSuccess: true,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
    hasNextPage: false,
  })),
}));
afterEach(cleanup);
const connection = { apiBase: 'https://station.test' };
const item: ChildWorkItem = {
  producer: 'engine-subagent',
  reporterThreadId: 'parent',
  childId: 'child',
  status: 'completed',
  title: 'Review files',
  transcript: { kind: 'codex-thread', threadId: 'child' },
} as ChildWorkItem;
function Nested() {
  const open = useChildChatNavigation();
  return (
    <button
      type="button"
      onClick={() =>
        open?.(
          childChatTarget(
            { ...item, childId: 'nested', title: 'Nested review' },
            connection,
          ),
        )
      }
    >
      Open nested
    </button>
  );
}
function Parent() {
  return (
    <>
      <input aria-label="Parent draft" defaultValue="Keep this draft" />
      <SubagentTranscriptCard
        child={{ item, provider: 'claude', toolAnchor: true }}
      />
      <Nested />
    </>
  );
}
function tree(rootKey = 'parent') {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <PreviewProvider>
        <ConversationConnectionProvider value={connection}>
          <ChildChatNavigation rootKey={rootKey} title="Parent chat">
            <Parent />
          </ChildChatNavigation>
        </ConversationConnectionProvider>
      </PreviewProvider>
    </QueryClientProvider>
  );
}

test('the real child card opens the normal message renderer in the chat pane and breadcrumb restores its parent draft', async () => {
  render(tree());
  fireEvent.click(screen.getByRole('button', { name: /Review files/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
  const trail = await screen.findByRole('navigation', {
    name: 'Chat breadcrumb',
  });
  expect(trail.textContent).toContain('Parent chat');
  expect(trail.textContent).toContain('Review files');
  const transcript = await screen.findByRole('log', {
    name: 'Conversation transcript',
  });
  expect(within(transcript).getByText('Inspect the child files')).toBeTruthy();
  expect(
    await within(transcript).findByRole('heading', { name: 'Child answer' }),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  fireEvent.click(within(trail).getByRole('button', { name: 'Parent chat' }));
  expect(screen.getByRole('textbox', { name: 'Parent draft' })).toHaveProperty(
    'value',
    'Keep this draft',
  );
  expect(
    screen.queryByRole('navigation', { name: 'Chat breadcrumb' }),
  ).toBeNull();
});

test('Escape pops one level and changing the root cannot show the previous chat child', async () => {
  const view = render(tree());
  fireEvent.click(screen.getByRole('button', { name: 'Open nested' }));
  const trail = await screen.findByRole('navigation', {
    name: 'Chat breadcrumb',
  });
  fireEvent.keyDown(trail, { key: 'Escape' });
  await waitFor(() =>
    expect(
      screen.queryByRole('navigation', { name: 'Chat breadcrumb' }),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open nested' }));
  view.rerender(tree('different-parent'));
  expect(
    screen.queryByRole('navigation', { name: 'Chat breadcrumb' }),
  ).toBeNull();
});
