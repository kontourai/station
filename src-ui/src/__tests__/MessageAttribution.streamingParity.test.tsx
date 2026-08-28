/**
 * @vitest-environment jsdom
 *
 * archive#1424 3, refined : the streaming row
 * and the persisted row it becomes must render the SAME attribution
 * fields — no transition delta, no chip that appears while streaming and
 * then vanishes (or vice versa) the instant the turn settles.
 *
 * This pins EQUALITY between the two renders rather than an absolute
 * "engine chip never renders" claim (archive#1424 4): a
 * correct future archive#1410 turn-envelope implementation is expected to make an
 * engine chip appear on BOTH rows at once, and an absolute-absence
 * assertion on either render would misread that as a regression — the same
 * reasoning `MessageBubble.temporalDrift.test.tsx` already documents for
 * its own `queryByText('Station')` pin. The one absolute assertion kept
 * here targets the CURRENT defect class specifically (no engine identity
 * read from the agent's CURRENT live binding — i.e. no live-derived
 * "Station" text — on either row), which archive#1410 landing does not retire:
 * it introduces a NEW turn-scoped source, not a live-derivation shortcut.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  // `agentEngineDescriptor({ slug: 'dev-agent' })` resolves this to
  // `{ name: 'Station' }` (no execution binding at all -> Station). If
  // either render still derived its engine chip from this live agent,
  // "Station" would render there.
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

vi.mock('../hooks/useStreamingContent', () => ({
  useStreamingContent: () => ({
    streamingText: 'Working on it…',
    hasContent: true,
    contentParts: [],
  }),
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';

const OWNER = { id: 'brian', label: 'Brian Anderson' };
const GAP = { state: 'unavailable', reason: 'not-reported-by-engine' } as const;
const STATION_GAP = {
  state: 'unavailable',
  reason: 'not-captured-by-station',
} as const;

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe('streaming vs. persisted row attribution parity (station#1424 review round 3 NEW-1, refined round 4)', () => {
  test('streaming and persisted rows render identical agent identity, owner chip, and engine-chip presence state — no transition delta', () => {
    const { container: streaming } = renderWithQueryClient(
      <ChatMessageList
        activeSession={{
          id: 'parity-streaming-session',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'Parity chat (streaming)',
          input: '',
          attachments: [],
          queuedMessages: [],
          inputHistory: [],
          hasUnread: false,
          status: 'sending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'manual',
          messages: [],
        }}
        fontSize={14}
        showReasoning
        showToolDetails
        owner={OWNER}
      />,
    );

    const { container: persisted } = renderWithQueryClient(
      <ChatMessageList
        activeSession={{
          id: 'parity-persisted-session',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'Parity chat (persisted)',
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
            {
              role: 'assistant',
              content: 'All done.',
              model: 'claude-3-5-sonnet-20241022',
              timestamp: 1,
            },
          ],
        }}
        fontSize={14}
        showReasoning
        showToolDetails
        owner={OWNER}
      />,
    );

    // Agent identity text is present, identically, on both rows.
    expect(within(streaming).getByText('Dev Agent')).toBeTruthy();
    expect(within(persisted).getByText('Dev Agent')).toBeTruthy();

    // Owner chip text is present, identically, on both rows.
    expect(within(streaming).getByText(/via Brian Anderson/)).toBeTruthy();
    expect(within(persisted).getByText(/via Brian Anderson/)).toBeTruthy();

    // Engine-chip PRESENCE STATE — not a hardcoded absence — must match
    // between streaming and persisted. Today both are false; a correct
    // future archive#1410 implementation making both true (a real, turn-scoped
    // engine identity on both rows at once) still passes this assertion,
    // exactly the point of comparing state rather than asserting "never".
    const streamingHasEngineChip = Boolean(
      streaming.querySelector('.engine-chip'),
    );
    const persistedHasEngineChip = Boolean(
      persisted.querySelector('.engine-chip'),
    );
    expect(streamingHasEngineChip).toBe(persistedHasEngineChip);

    // One absolute assertion, pinning the CURRENT defect class specifically
    // ( temporal-drift bug): neither row's engine identity is ever read
    // from the agent's CURRENT live binding — `agentEngineDescriptor` would
    // resolve "Station" for `dev-agent` if either render read that live
    // source. archive#1410 landing introduces a new turn-scoped authority; it does
    // not resurrect the live-derivation shortcut this pins against.
    expect(within(streaming).queryByText('Station')).toBeNull();
    expect(within(persisted).queryByText('Station')).toBeNull();
  });

  test('station#1434: the settled row may state an engine the streaming row could not — an addition when the turn is observed, never a retraction or a correction', () => {
    const { container: streaming } = renderWithQueryClient(
      <ChatMessageList
        activeSession={{
          id: 'additive-streaming-session',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'Additive chat (streaming)',
          input: '',
          attachments: [],
          queuedMessages: [],
          inputHistory: [],
          hasUnread: false,
          status: 'sending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'manual',
          messages: [],
        }}
        fontSize={14}
        showReasoning
        showToolDetails
        owner={OWNER}
      />,
    );

    const { container: persisted } = renderWithQueryClient(
      <ChatMessageList
        activeSession={{
          id: 'additive-persisted-session',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'Additive chat (persisted)',
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
            {
              role: 'assistant',
              content: 'All done.',
              timestamp: 1,
              turnId: 'turn-7',
              // The turn's provenance envelope only exists once the turn
              // has a terminal event to fold, which is precisely why the
              // streaming row above can state nothing.
              provenance: {
                envelopeVersion: 1,
                sessionId: 'additive-persisted-session',
                turnId: 'turn-7',
                outcome: 'completed',
                observedAt: '2026-08-01T00:00:00.000Z',
                engine: {
                  state: 'observed',
                  value: { provider: 'claude' },
                  observedFrom: [
                    { eventId: 'e1', method: 'turn.completed' as const },
                  ],
                },
                requestedModel: GAP,
                reportedModel: GAP,
                tools: GAP,
                usage: GAP,
                routingReceipt: STATION_GAP,
                sources: STATION_GAP,
                trustReport: STATION_GAP,
              },
            },
          ],
        }}
        fontSize={14}
        showReasoning
        showToolDetails
        owner={OWNER}
      />,
    );

    // Streaming: no engine claim of any kind — not a different one, none.
    expect(streaming.querySelector('.engine-chip')).toBeNull();
    expect(within(streaming).queryByText('Claude Code')).toBeNull();
    // Settled with an observed envelope: the engine is finally knowable, and
    // the row says so. Nothing the streaming row asserted is withdrawn.
    expect(persisted.querySelector('.engine-chip')?.textContent).toBe(
      'Claude Code',
    );
    // The live-derivation shortcut stays closed on both rows.
    expect(within(streaming).queryByText('Station')).toBeNull();
    expect(within(persisted).queryByText('Station')).toBeNull();
  });
});
