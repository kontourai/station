// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const fetchAgentConversations = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  fetchAgentConversations: (agentSlug: string) =>
    fetchAgentConversations(agentSlug),
}));

import { ShareTargetPickerModal } from '../components/chat/ShareTargetPickerModal';

const AGENTS = [
  { slug: 'agent-one', name: 'Agent One' },
  { slug: 'agent-two', name: 'Agent Two' },
];

function conversation(id: string, title: string, updatedAt: string) {
  return { id, title, createdAt: updatedAt, updatedAt };
}

function renderPicker(overrides: Partial<{ sharedFiles: File[] }> = {}) {
  const onShareToConversation = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  render(
    <ShareTargetPickerModal
      isOpen
      agents={AGENTS}
      sharedFiles={
        overrides.sharedFiles ?? [
          new File(['abc'], 'shared.png', { type: 'image/png' }),
        ]
      }
      attachmentCapabilities={{ images: true, files: true }}
      onShareToConversation={onShareToConversation}
      onClose={onClose}
    />,
    { wrapper },
  );
  return { onShareToConversation, onClose };
}

afterEach(() => {
  cleanup();
  fetchAgentConversations.mockReset();
});

describe('ShareTargetPickerModal', () => {
  test('lists recent conversations across agents, most-recent first', async () => {
    fetchAgentConversations.mockImplementation((slug: string) =>
      slug === 'agent-one'
        ? Promise.resolve([
            conversation('c1', 'Older chat', '2026-07-20T10:00:00.000Z'),
          ])
        : Promise.resolve([
            conversation('c2', 'Newer chat', '2026-07-24T10:00:00.000Z'),
          ]),
    );

    renderPicker();

    await screen.findByText('Older chat');
    const titles = screen.getAllByText(/chat$/).map((node) => node.textContent);
    expect(titles).toEqual(['Newer chat', 'Older chat']);
  });

  test('seeds the shared image into the chosen conversation composer path', async () => {
    fetchAgentConversations.mockImplementation((slug: string) =>
      slug === 'agent-one'
        ? Promise.resolve([
            conversation('c1', 'Design review', '2026-07-24T10:00:00.000Z'),
          ])
        : Promise.resolve([]),
    );

    const { onShareToConversation, onClose } = renderPicker();

    const row = await screen.findByText('Design review');
    fireEvent.click(row);

    await waitFor(() => expect(onShareToConversation).toHaveBeenCalledTimes(1));
    const [target, attachments] = onShareToConversation.mock.calls[0];
    expect(target).toEqual({
      conversationId: 'c1',
      agentSlug: 'agent-one',
      agentName: 'Agent One',
    });
    // The shared File flowed through readChatAttachmentFiles into a real
    // image attachment destined for that conversation's composer.
    expect(attachments).toHaveLength(1);
    expect(attachments[0].type).toBe('image/png');
    expect(attachments[0].name).toBe('shared.png');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test('renders the Empty state when no conversations exist', async () => {
    fetchAgentConversations.mockResolvedValue([]);

    renderPicker();

    await screen.findByText('No conversations yet');
  });

  test('filters conversations by the search field', async () => {
    fetchAgentConversations.mockImplementation((slug: string) =>
      slug === 'agent-one'
        ? Promise.resolve([
            conversation('c1', 'Alpha', '2026-07-24T10:00:00.000Z'),
            conversation('c2', 'Beta', '2026-07-23T10:00:00.000Z'),
          ])
        : Promise.resolve([]),
    );

    renderPicker();

    await screen.findByText('Alpha');
    fireEvent.change(screen.getByLabelText('Search conversations'), {
      target: { value: 'bet' },
    });

    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.getByText('Beta')).not.toBeNull();
  });
});
