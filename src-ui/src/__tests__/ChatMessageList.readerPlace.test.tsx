/**
 * @vitest-environment jsdom
 *
 * The list tells the transcript's window where its reader is, and the window
 * keeps what it holds while they are away. A list that is gone reads nothing:
 * its last word must be that no one is away, or the window stays kept with no
 * one reading it. A report that only re-runs while the list is mounted must
 * never say so, or a reload in between would drop the rows being read.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ReaderPlace } from '../hooks/orchestration/readerPlace';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'dev-agent', name: 'Dev Agent' }],
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
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

import { ChatMessageList } from '../components/chat/ChatMessageList';

const session = {
  id: 'reader-place-session',
  agentSlug: agentId('dev-agent'),
  agentName: 'Dev Agent',
  title: 'Reader place',
  input: '',
  attachments: [],
  queuedMessages: [],
  inputHistory: [],
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
  source: 'manual',
  messages: [
    {
      role: 'user' as const,
      content: 'the question',
      timestamp: '2026-01-01T00:00:00.000Z',
      turnId: 'turn-1',
    },
    {
      role: 'assistant' as const,
      content: 'the answer',
      timestamp: '2026-01-01T00:00:01.000Z',
      turnId: 'turn-1',
    },
  ],
} as any;

function list(onReaderPlaceChange: (place: ReaderPlace) => void) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ChatMessageList
        activeSession={session}
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        preserveReading
        onReaderPlaceChange={onReaderPlaceChange}
      />
    </QueryClientProvider>
  );
}

describe('ChatMessageList reader place', () => {
  test('a list unmounted while its reader is away last reports no one away', () => {
    const places: ReaderPlace[] = [];
    const view = render(list((place) => places.push(place)));
    expect(places.at(-1)?.away).toBe(true);
    view.unmount();
    expect(places.at(-1)).toEqual({ away: false });
  });

  test('a report that re-runs while mounted never says the reader is back', () => {
    const places: ReaderPlace[] = [];
    const view = render(list((place) => places.push(place)));
    expect(places.at(-1)?.away).toBe(true);
    // A new callback re-runs the report; nothing in between may read as the
    // reader back at the end.
    view.rerender(list((place) => places.push(place)));
    view.rerender(list((place) => places.push(place)));
    expect(places.length).toBeGreaterThan(1);
    expect(places.every((place) => place.away)).toBe(true);
  });
});
