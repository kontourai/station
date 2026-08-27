// @vitest-environment jsdom
//
// station#1424 review round 3 (item 5, "the unpinned owner hop"): unlike
// ACPChatPanel.viewport.test.tsx (which deliberately stubs out
// ChatMessageList to isolate the viewport-boundary behavior it actually
// tests), this file renders the REAL ChatMessageList/MessageBubble tree so
// deleting `owner={owner}` at ACPChatPanel.tsx's own ChatMessageList call
// site fails a test, not just a narrower unit that never exercises
// ACPChatPanel's own wiring.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  useAgentConnectionsQuery: () => ({ data: [] }),
  // MessageRating (rendered by the real MessageBubble this test exercises)
  // needs these three — not under test here.
  useFeedbackRatingsQuery: () => ({ data: [] }),
  useSaveFeedbackRatingMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteFeedbackRatingMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));
const connectionState = vi.hoisted(() => ({
  active: { id: 'saved-kontour', name: 'Kontour' } as {
    id: string;
    name: string;
  } | null,
}));
vi.mock('../build-info', () => ({
  // The dev fallback: a provenance chip must render NOTHING here, never a
  // fabricated 'Station v0.0.0 · dev' (#2585 sol review P1).
  verifiedBuildLabel: null,
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: connectionState.active,
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'codex', name: 'Codex' }],
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { alias: 'operator', name: 'Operator Person' } }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const acpFixture = {
  id: 'acp-session',
  agentSlug: 'codex',
  agentName: 'Codex',
  title: 'Engine fixture',
  messages: [{ role: 'assistant', content: 'Build is green.', timestamp: 1 }],
  input: '',
  attachments: [],
  queuedMessages: [],
  inputHistory: [],
  status: 'idle',
};

vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({ updateChat: vi.fn() }),
  useActiveChatState: () => acpFixture,
  useActiveChatSelector: (
    _sessionId: string,
    selector: (state: typeof acpFixture | null) => unknown,
  ) => selector(acpFixture),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => () => 'acp-session',
  useSendMessage: () => vi.fn(),
}));
vi.mock('../hooks/useChatInput', () => ({
  useChatInput: () => ({}),
}));
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: () => <div data-testid="acp-composer" />,
}));
vi.mock('../components/chat/SessionSummaryCard', () => ({
  SessionSummaryCard: () => null,
}));

import { ACPChatPanel } from '../components/acp-connections/ACPChatPanel';

describe('ACPChatPanel Station attribution wiring (station#2585)', () => {
  test('a real assistant row names the active saved Station, never the OS alias', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ACPChatPanel projectSlug="station" agentSlug="codex" tabId="tab-1" />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Build is green.')).toBeTruthy();
    expect(screen.getByText('via Kontour')).toBeTruthy();
    expect(screen.queryByText(/operator/i)).toBeNull();
  });

  test('renders no chip at all when neither a saved Station nor verified build identity resolves', async () => {
    connectionState.active = null;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ACPChatPanel projectSlug="station" agentSlug="codex" tabId="tab-1" />
      </QueryClientProvider>,
    );
    expect(document.body.textContent).not.toContain('via ');
    expect(document.body.textContent).not.toContain('v0.0.0');
    connectionState.active = { id: 'saved-kontour', name: 'Kontour' };
  });
});
