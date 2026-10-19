/**
 * @vitest-environment jsdom
 *
 * The answer's Basis chip, through the REAL MessageBubble and the REAL lazy
 * chip (`ConnectedAnswerBasisAffordance`). Only the launcher's outer seams are
 * replaced: the Basis Pane launcher (a spy standing in for the Pane host) and
 * the authority/project hooks that would otherwise need the app's providers.
 *
 * Session ids are the colon-shaped ids real sessions carry, not `session-a`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeSessionInventoryOccurrence,
  registerSessionInventoryHost,
  useSessionInventoryOccurrence,
} from '../components/chat-dock/sessionInventoryOccurrence';
import type { ChatMessage } from '../types';

const mocks = vi.hoisted(() => ({
  openBasis: vi.fn(),
  isMobile: false,
  realLauncher: false,
  authority: {
    apiBase: 'http://station.test',
    authorityKey: 'authority-a',
    isCurrent: () => true,
  },
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('../hooks/useIsMobile', async (original) => ({
  ...(await original<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => mocks.isMobile,
}));
vi.mock('../contexts/ApiBaseContext', async (original) => ({
  ...(await original<typeof import('../contexts/ApiBaseContext')>()),
  useHostRequestAuthorityScope: () => mocks.authority,
}));
vi.mock('../contexts/ProjectsContext', async (original) => ({
  ...(await original<typeof import('../contexts/ProjectsContext')>()),
  useScopedProjectQuery: () => ({ data: undefined }),
}));
vi.mock('../workspace-panes/BasisPaneLauncher', async (original) => {
  const actual =
    await original<typeof import('../workspace-panes/BasisPaneLauncher')>();
  return {
    ...actual,
    useBasisPaneLauncher: () =>
      mocks.realLauncher
        ? // biome-ignore lint/correctness/useHookAtTopLevel: the branch is fixed per test, never per render.
          actual.useBasisPaneLauncher()
        : { openBasis: mocks.openBasis, fallback: null },
  };
});
// The fallback dialog's body is the Basis Pane itself; it is not under test
// here, only that the launcher opened it for this exact answer.
vi.mock('../workspace-panes/BasisPaneFallbackContent', () => ({
  ConnectedBasisFallbackPane: ({
    scope,
  }: {
    scope: { initialScope?: unknown };
  }) => (
    <output data-testid="fallback-scope">
      {JSON.stringify(scope.initialScope)}
    </output>
  ),
}));

const { MessageBubble } = await import('../components/chat/MessageBubble');

const SESSION = 'agent:1792425046978';
const CHAT_STORE = 'agent:1792425046978';

const envelope = {
  envelopeVersion: 1,
  sessionId: SESSION,
  turnId: 'turn-7',
  outcome: 'completed',
  observedAt: '2026-08-01T00:00:00.000Z',
  engine: {
    state: 'observed',
    value: { provider: 'codex' },
    observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
  },
  requestedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
  reportedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
  tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
  usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
  routingReceipt: { state: 'unavailable', reason: 'not-captured-by-station' },
  sources: { state: 'unavailable', reason: 'not-captured-by-station' },
  trustReport: { state: 'unavailable', reason: 'not-captured-by-station' },
};

function answer(turnId: string, overrides: Partial<ChatMessage> = {}) {
  return {
    role: 'assistant',
    content: `Answer for ${turnId}.`,
    sessionId: SESSION,
    turnId,
    answerEligible: true,
    provenance: { ...envelope, turnId },
    ...overrides,
  } as ChatMessage;
}

function withQueryClient(ui: ReactNode) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>
  );
}

/** Renders `messages` as one transcript, so `isLastMessage` is real. */
function renderTranscript(
  messages: ChatMessage[],
  session: { isThinking?: boolean; conversationId?: string } = {},
) {
  return render(
    withQueryClient(
      messages.map((msg, idx) => (
        <MessageBubble
          key={msg.turnId ?? idx}
          msg={msg}
          idx={idx}
          activeSession={{
            id: CHAT_STORE,
            agentSlug: 'agent',
            messageCount: messages.length,
            ...session,
          }}
          agents={[]}
          chatFontSize={14}
          showReasoning={false}
          showToolDetails={false}
          onCopy={() => {}}
        />
      )),
    ),
  );
}

function expectOpenedBasisFor(turnId: string, trigger: HTMLElement) {
  expect(mocks.openBasis).toHaveBeenCalledTimes(1);
  expect(mocks.openBasis).toHaveBeenCalledWith(
    null,
    {
      kind: 'session-inventory',
      sessionId: SESSION,
      initialScope: { kind: 'current-answer', sessionId: SESSION, turnId },
    },
    trigger,
  );
}

describe('MessageBubble answer Basis chip', () => {
  beforeEach(() => {
    mocks.openBasis.mockReset();
    mocks.isMobile = false;
    closeSessionInventoryOccurrence();
  });

  it('puts Basis on an eligible settled answer and opens that exact answer', async () => {
    const { container } = renderTranscript([answer('turn-7')]);

    const chip = await screen.findByRole('button', { name: 'Basis' });
    // In the answer's own action row: no menu or dialog to open first.
    expect(
      container.querySelector('.turn-footer__actions')?.contains(chip),
    ).toBe(true);
    // The chip claims nothing it did not compute: no count, no standing.
    expect(chip.textContent).toBe('Basis');

    fireEvent.click(chip);
    expectOpenedBasisFor('turn-7', chip);
  });

  it('hands the exact answer scope to the chat host that owns the session', async () => {
    const unregister = registerSessionInventoryHost('chat-host', {
      authorityKey: mocks.authority.authorityKey,
      chatStoreId: CHAT_STORE,
      executionId: SESSION,
    });
    try {
      renderTranscript([answer('turn-7')]);
      fireEvent.click(await screen.findByRole('button', { name: 'Basis' }));

      const occurrence = renderHook(() =>
        useSessionInventoryOccurrence('chat-host'),
      ).result.current;
      expect(occurrence?.requestedScope).toEqual({
        kind: 'current-answer',
        sessionId: SESSION,
        turnId: 'turn-7',
      });
      expect(mocks.openBasis).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('is the only Basis entry: the provenance dialog no longer repeats it', async () => {
    renderTranscript([answer('turn-7')]);
    await screen.findByRole('button', { name: 'Basis' });

    fireEvent.click(
      await screen.findByRole('button', { name: 'More answer actions' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn provenance' }));
    const dialog = await screen.findByLabelText(/^Answer provenance/);
    expect(within(dialog).queryByRole('button', { name: /Basis/ })).toBeNull();
  });

  /**
   * Each ineligible row renders beside an eligible one in the same transcript,
   * so the lazy chip has demonstrably loaded: exactly one chip, and it opens
   * the eligible turn, never the ineligible one.
   */
  describe('offers no Basis where the route cannot answer', () => {
    const ineligible: Array<[string, ChatMessage]> = [
      [
        'an answer not marked eligible',
        answer('turn-x', { answerEligible: undefined }),
      ],
      [
        'an answer marked ineligible',
        answer('turn-x', { answerEligible: false }),
      ],
      [
        'an aborted turn',
        answer('turn-x', {
          provenance: { ...envelope, turnId: 'turn-x', outcome: 'aborted' },
        }),
      ],
      [
        'a turn with no provenance envelope',
        answer('turn-x', { provenance: undefined }),
      ],
      ['a row with no turn id', answer('turn-x', { turnId: undefined })],
    ];

    it.each(ineligible)('%s', async (_label, row) => {
      renderTranscript([row, answer('turn-ok')]);

      const chips = await screen.findAllByRole('button', { name: 'Basis' });
      expect(chips).toHaveLength(1);
      fireEvent.click(chips[0]!);
      expectOpenedBasisFor('turn-ok', chips[0]!);
    });

    it('the still-streaming last answer', async () => {
      renderTranscript([answer('turn-ok'), answer('turn-live')], {
        isThinking: true,
      });

      const chips = await screen.findAllByRole('button', { name: 'Basis' });
      expect(chips).toHaveLength(1);
      fireEvent.click(chips[0]!);
      expectOpenedBasisFor('turn-ok', chips[0]!);
    });

    it('a conversation row whose execution Session is unknown', async () => {
      renderTranscript(
        [answer('turn-x', { sessionId: undefined }), answer('turn-ok')],
        { conversationId: 'conversation-1' },
      );

      const chips = await screen.findAllByRole('button', { name: 'Basis' });
      expect(chips).toHaveLength(1);
      fireEvent.click(chips[0]!);
      expectOpenedBasisFor('turn-ok', chips[0]!);
    });
  });

  describe('on a phone', () => {
    afterEach(() => {
      mocks.isMobile = false;
      mocks.realLauncher = false;
    });

    it('opens Basis in front, in the launcher dialog, when no chat host owns the session', async () => {
      // Phones mount no session-inventory host today, so the occurrence
      // handoff is refused. The chip must still open this answer's Basis,
      // not do nothing.
      mocks.isMobile = true;
      mocks.realLauncher = true;
      renderTranscript([answer('turn-7')]);

      fireEvent.click(await screen.findByRole('button', { name: 'Basis' }));

      const dialog = await screen.findByRole('dialog', { name: 'Basis' });
      expect(
        JSON.parse(
          (await within(dialog).findByTestId('fallback-scope')).textContent ??
            '',
        ),
      ).toEqual({
        kind: 'current-answer',
        sessionId: SESSION,
        turnId: 'turn-7',
      });
    });

    it('sits in the answer meta row beside copy, one tap from the answer', async () => {
      mocks.isMobile = true;
      const { container } = renderTranscript([answer('turn-7')]);

      const chip = await screen.findByRole('button', { name: 'Basis' });
      expect(container.querySelector('.message-meta')?.contains(chip)).toBe(
        true,
      );
      fireEvent.click(chip);
      expectOpenedBasisFor('turn-7', chip);
    });
  });
});
