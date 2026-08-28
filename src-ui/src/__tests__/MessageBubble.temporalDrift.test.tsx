/**
 * @vitest-environment jsdom
 *
 * archive#1424 fix : pins the actual reported defect end-to-end
 * through the real `ChatMessageList` -> `MessageBubble` render path, not
 * just the pure `resolveTurnEngine` unit (see message-bubble-utils.test.ts).
 * Before the fix, a PERSISTED assistant row derived its engine chip from
 * `agents.find(...).slug` — the agent's CURRENT live binding — so simply
 * having a resolvable current agent was enough to paint an engine chip on
 * every historical row, even though nothing about that specific turn was
 * ever recorded. This mounts a real resolvable agent (which
 * `agentEngineDescriptor` would happily resolve to "Station") and asserts
 * the persisted row still renders no engine chip at all.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
// A real, resolvable agent — `agentEngineDescriptor({ slug: 'dev-agent' })`
// resolves this to `{ name: 'Station' }` (no execution binding at all ->
// Station, per EngineChip.test.tsx's own pinned case). If MessageBubble
// still derived its chip from this live agent, "Station" would render.
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

vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: () => <div data-testid="streaming-message">Streaming</div>,
}));

vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe('MessageBubble temporal-drift regression (station#1424 M1)', () => {
  test("a persisted (non-streaming) assistant row never shows an engine chip derived from the agent's current live binding", () => {
    renderWithQueryClient(
      <ChatMessageList
        activeSession={{
          id: 'temporal-drift-session',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'Temporal drift chat',
          input: '',
          attachments: [],
          queuedMessages: [],
          inputHistory: [],
          hasUnread: false,
          status: 'idle',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'manual',
          messages: [
            { role: 'user', content: 'hi', timestamp: 1 },
            {
              role: 'assistant',
              content: 'hello there',
              model: 'claude-3-5-sonnet-20241022',
              timestamp: 2,
            },
          ],
        }}
        fontSize={14}
        showReasoning
        showToolDetails
      />,
    );

// The agent's own name IS still shown (identity, not engine — see
// MessageAttribution.test.tsx for that boundary)...
    expect(screen.getByText('Dev Agent')).toBeTruthy();
//.but no "Station" engine chip — `agentEngineDescriptor` would have
// resolved one from the current agent config, proving this row is NOT
// reading that live source for its engine chip. This is deliberately
// NOT a blanket "no.engine-chip ever" assertion (archive#1424
 //): a correct archive#1410 turn-envelope implementation is
// EXPECTED to make a real engine chip appear here once it lands as the
// per-turn authority, and a blanket absence check would misread that
// as a regression. `queryByText('Station')` pins the specific defect
// (no LIVE-derivation leak) without pinning against a legitimate future
// implementation.
    expect(screen.queryByText('Station')).toBeNull();
  });

  test('station#1424 review round 3 (NEW-6): a deleted agent (agents.find misses) falls back to the session\'s own threaded agentName instead of leaving an orphaned "identity-less" row', () => {
    renderWithQueryClient(
      <ChatMessageList
        activeSession={{
          id: 'deleted-agent-session',
// No entry in the mocked useAgents list below matches this slug.
          agentSlug: agentId('deleted-agent-slug'),
          agentName: 'Formerly Known Agent',
          title: 'Deleted agent chat',
          input: '',
          attachments: [],
          queuedMessages: [],
          inputHistory: [],
          hasUnread: false,
          status: 'idle',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'manual',
          messages: [
            { role: 'assistant', content: 'hello there', timestamp: 2 },
          ],
        }}
        fontSize={14}
        showReasoning
        showToolDetails
        owner={{ id: 'brian', label: 'Brian Anderson' }}
      />,
    );

// The row still names an agent — the session's threaded agentName, not
// a blank identity next to a now-orphaned owner chip.
    expect(screen.getByText('Formerly Known Agent')).toBeTruthy();
    expect(screen.getByText(/via Brian Anderson/)).toBeTruthy();
  });
});
