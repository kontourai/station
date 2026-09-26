/**
 * @vitest-environment jsdom
 *
 * archive#55: the STREAMING row renders reasoning through the shared
 * `ReasoningSection`, wired by `ChatMessageList`'s `renderReasoning`: it honours
 * the reader's show-reasoning setting, and the disclosure stays open while no
 * answer text has arrived and collapses once it has. The settled row's half
 * of the same contract is `ReasoningDisclosure.test.tsx`'s `MessageContent`
 * cases.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChatContentPart } from '../contexts/active-chats-state';

const REASONING = 'inspect the request compare the evidence choose the answer';

const streaming = vi.hoisted(() => ({
  parts: [] as ChatContentPart[],
  text: '',
}));

vi.mock('../contexts/PreviewContext', () => ({
  usePreview: () => ({ openPreview: vi.fn() }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'dev-agent', name: 'Dev Agent' }],
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));
vi.mock('../hooks/useStreamingContent', () => ({
  useStreamingContent: () => ({
    streamingText: streaming.text,
    hasContent: true,
    contentParts: streaming.parts,
    contentRevision: 1,
  }),
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import { __resetReasoningDisclosureIntents } from '../components/chat/ReasoningSection';

afterEach(() => {
  cleanup();
  __resetReasoningDisclosureIntents();
});

function renderStreamingRow({
  parts,
  showReasoning,
}: {
  parts: ChatContentPart[];
  showReasoning: boolean;
}) {
  streaming.parts = parts;
  streaming.text = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.content ?? '')
    .join('');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatMessageList
        activeSession={{
          id: 'reasoning-streaming',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'Reasoning',
          status: 'sending',
          messages: [],
          input: '',
          attachments: [],
          queuedMessages: [],
          inputHistory: [],
          hasUnread: false,
          createdAt: 1,
          updatedAt: 1,
          source: 'manual',
        }}
        fontSize={14}
        showReasoning={showReasoning}
        showToolDetails
      />
    </QueryClientProvider>,
  );
}

const reasoningPart = {
  type: 'reasoning',
  content: REASONING,
} as ChatContentPart;
const answerPart = {
  type: 'text',
  content: 'Here is the answer.',
} as ChatContentPart;

describe('the streaming row renders reasoning through ReasoningSection', () => {
  test('reasoning with no answer yet is an open disclosure', () => {
    renderStreamingRow({ parts: [reasoningPart], showReasoning: true });

    const summary = screen.getByRole('button', {
      name: 'Reasoning · 9 words',
    });
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(REASONING)).toBeTruthy();
  });

  test('once answer text streams in, the disclosure collapses', () => {
    renderStreamingRow({
      parts: [reasoningPart, answerPart],
      showReasoning: true,
    });

    const summary = screen.getByRole('button', {
      name: 'Reasoning · 9 words',
    });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(REASONING)).toBeNull();
  });

  test('the show-reasoning setting off hides it', () => {
    renderStreamingRow({ parts: [reasoningPart], showReasoning: false });

    expect(screen.queryByRole('button', { name: /Reasoning/ })).toBeNull();
    expect(screen.queryByText(REASONING)).toBeNull();
  });
});
