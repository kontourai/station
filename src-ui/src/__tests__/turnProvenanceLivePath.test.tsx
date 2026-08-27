/**
 * @vitest-environment jsdom
 *
 * station#1410 MB1 — the live path.
 *
 * The provider-backed send returns right after `sendOrchestrationTurn` and
 * never refetches the transcript; the assistant bubble is committed straight
 * from the SSE stream by `finalizeAssistantTurn`. So an envelope that only
 * exists on the REST projection is invisible until a remount or reconnect,
 * and "every assistant turn gets a provenance card" is false in the one
 * place users actually look.
 *
 * These tests drive real orchestration events through the real dispatcher
 * into the real store, then render the real chat row — no refetch, no
 * remount between the turn completing and the assertion.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
  // station#1423: the row's share affordance. Stubbed rather than provided
  // for real, because this file is about the LIVE provenance path and a
  // query client would add a dependency none of its assertions are about.
  useMintAnswerShareMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
  useTasksQuery: () => ({
    data: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useCreateTaskReferenceMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  // The button branches on this class to decide whether to offer the pairing
  // path; the mock must carry it or the row cannot render at all.
  AnswerShareAuthRequiredError: class extends Error {},
}));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));

const { activeChatsStore } = await import('../contexts/active-chats-store');
const { handleOrchestrationEvent } = await import(
  '../hooks/orchestration/eventHandlers'
);
const { handleTurnAbortedEvent } = await import(
  '../hooks/orchestration/turnHandlers'
);
const { MessageBubble } = await import('../components/chat/MessageBubble');

const THREAD_ID = 'live-provenance-thread';
const API_BASE = 'http://localhost';

/** The envelope the server assembles and hangs beside the terminal frame. */
const envelope = {
  envelopeVersion: 1,
  sessionId: THREAD_ID,
  turnId: 'turn-live-1',
  outcome: 'completed',
  observedAt: '2026-08-01T00:00:02.000Z',
  engine: {
    state: 'observed',
    value: { provider: 'claude' },
    observedFrom: [{ eventId: 'e-done', method: 'turn.completed' }],
  },
  requestedModel: {
    state: 'observed',
    value: 'claude-sonnet-9',
    observedFrom: [{ eventId: 'e-start', method: 'turn.started' }],
  },
  reportedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
  tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
  usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
  routingReceipt: { state: 'unavailable', reason: 'not-captured-by-station' },
  sources: { state: 'unavailable', reason: 'not-captured-by-station' },
  trustReport: { state: 'unavailable', reason: 'not-captured-by-station' },
};

/** Streams one complete turn, exactly as the SSE dispatcher would. */
function runLiveTurn(options: { provenance?: unknown } = {}) {
  handleOrchestrationEvent(API_BASE, {
    eventId: 'e-start',
    provider: 'claude',
    threadId: THREAD_ID,
    createdAt: '2026-08-01T00:00:00.000Z',
    method: 'turn.started',
    turnId: 'turn-live-1',
    metadata: { effectiveModel: 'claude-sonnet-9' },
  });
  handleOrchestrationEvent(API_BASE, {
    eventId: 'e-delta',
    provider: 'claude',
    threadId: THREAD_ID,
    createdAt: '2026-08-01T00:00:01.000Z',
    method: 'content.text-delta',
    itemId: 'i1',
    delta: 'Here is the answer.',
  });
  handleOrchestrationEvent(
    API_BASE,
    {
      eventId: 'e-done',
      provider: 'claude',
      threadId: THREAD_ID,
      createdAt: '2026-08-01T00:00:02.000Z',
      method: 'turn.completed',
      turnId: 'turn-live-1',
      finishReason: 'stop',
    },
    options.provenance,
  );
}

function committedAssistantMessage() {
  const chat = activeChatsStore.getSnapshot()[THREAD_ID];
  return (chat.messages ?? []).find((message) => message.role === 'assistant');
}

function committedAssistantMessages() {
  const chat = activeChatsStore.getSnapshot()[THREAD_ID];
  return (chat.messages ?? []).filter(
    (message) => message.role === 'assistant',
  );
}

/** Envelope for a DIFFERENT turn than the one currently streaming. */
const foreignEnvelope = {
  ...envelope,
  turnId: 'turn-live-0',
  engine: {
    state: 'observed',
    value: { provider: 'codex' },
    observedFrom: [{ eventId: 'e-old', method: 'turn.completed' }],
  },
};

function renderCommittedRow() {
  const msg = committedAssistantMessage();
  if (!msg) throw new Error('no assistant message was committed');
  return render(
    <MessageBubble
      msg={msg}
      idx={0}
      activeSession={{ id: THREAD_ID, agentSlug: 'claude', messages: [msg] }}
      agents={[]}
      chatFontSize={14}
      showReasoning={false}
      showToolDetails={false}
      onCopy={() => {}}
    />,
  );
}

describe('turn provenance on the live orchestration path (station#1410)', () => {
  beforeEach(() => {
    activeChatsStore.removeChat(THREAD_ID);
    activeChatsStore.initChat(THREAD_ID, {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'Claude Chat',
    });
  });

  it('renders the card for a turn that completed live, with no refetch or remount', () => {
    runLiveTurn({ provenance: envelope });

    const message = committedAssistantMessage();
    expect(message?.content).toBe('Here is the answer.');
    expect(message?.turnId).toBe('turn-live-1');
    expect(message?.sessionId).toBe(THREAD_ID);
    expect(message?.provenance).toEqual(envelope);

    const { container } = renderCommittedRow();
    const card = screen.getByLabelText(
      'Answer provenance for turn turn-live-1',
    );
    // station#1434: the live-committed row states the engine once, on its
    // own attribution strip, sourced from this same envelope — the card's
    // collapsed headline no longer repeats it.
    expect(container.querySelector('.engine-chip')?.textContent).toBe(
      'Claude Code',
    );
    expect(card.textContent).not.toContain('Claude Code');
    // station#1802: this used to assert "6 gaps". That count was of Station's
    // own not-yet-captured signals, which are identical under every answer and
    // therefore say nothing about this turn — they no longer reach the badge.
    // A live turn that completed cleanly has nothing notable to badge.
    expect(card.textContent).not.toMatch(/\d+ gaps?/);
  });

  it('revokes an already eligible live answer when a late abort arrives', async () => {
    runLiveTurn({ provenance: envelope });
    const message = committedAssistantMessage();
    expect(message?.answerEligible).toBe(true);
    const view = renderCommittedRow();
    expect(
      await screen.findByRole('button', {
        name: 'Add this answer to a Task (turn turn-live-1)',
      }),
    ).toBeTruthy();

    handleTurnAbortedEvent({
      eventId: 'e-abort',
      provider: 'claude',
      threadId: THREAD_ID,
      turnId: 'turn-live-1',
      createdAt: '2026-08-01T00:00:03.000Z',
      method: 'turn.aborted',
      reason: 'cancelled late',
    });
    expect(committedAssistantMessage()?.content).toBe('Here is the answer.');
    expect(committedAssistantMessage()?.answerEligible).toBeUndefined();
    expect(committedAssistantMessage()?.provenance).toBeUndefined();
    view.unmount();
  });

  it('claims nothing when the terminal frame carried no envelope', () => {
    runLiveTurn();

    const message = committedAssistantMessage();
    expect(message?.content).toBe('Here is the answer.');
    // Turn identity still lands; the envelope simply is not asserted.
    expect(message?.turnId).toBe('turn-live-1');
    expect(message?.provenance).toBeUndefined();

    renderCommittedRow();
    expect(screen.queryByText(/gaps/)).toBeNull();
  });

  // D1 — the live mirror of the REST-side identity guard.
  it('never stamps a late foreign terminal’s envelope onto the open turn', () => {
    // Turn 0 completes normally.
    runLiveTurn({ provenance: envelope });
    // Turn 1 starts and streams…
    handleOrchestrationEvent(API_BASE, {
      eventId: 'e-start-2',
      provider: 'claude',
      threadId: THREAD_ID,
      createdAt: '2026-08-01T00:00:03.000Z',
      method: 'turn.started',
      turnId: 'turn-live-2',
    });
    handleOrchestrationEvent(API_BASE, {
      eventId: 'e-delta-2',
      provider: 'claude',
      threadId: THREAD_ID,
      createdAt: '2026-08-01T00:00:04.000Z',
      method: 'content.text-delta',
      itemId: 'i2',
      delta: 'Second answer.',
    });
    // …and an EARLIER turn's terminal arrives while turn 1 is still open.
    handleOrchestrationEvent(
      API_BASE,
      {
        eventId: 'e-done-foreign',
        provider: 'codex',
        threadId: THREAD_ID,
        createdAt: '2026-08-01T00:00:05.000Z',
        method: 'turn.completed',
        turnId: 'turn-live-0',
        finishReason: 'stop',
      },
      foreignEnvelope,
    );

    const committed = committedAssistantMessages();
    const secondAnswer = committed.find((m) => m.content === 'Second answer.');
    expect(secondAnswer).toBeDefined();
    // The foreign turn's envelope must not be attached to this turn's text.
    expect(secondAnswer?.provenance).toBeUndefined();
    expect(secondAnswer?.turnId).toBeUndefined();

    renderCommittedRow();
    // Nothing claims "codex" over text that Claude produced.
    expect(screen.queryByText(/Codex/)).toBeNull();
  });

  it('still attaches when the terminal closes the turn that is open', () => {
    handleOrchestrationEvent(API_BASE, {
      eventId: 'e-start-x',
      provider: 'claude',
      threadId: THREAD_ID,
      createdAt: '2026-08-01T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-live-1',
    });
    handleOrchestrationEvent(API_BASE, {
      eventId: 'e-delta-x',
      provider: 'claude',
      threadId: THREAD_ID,
      createdAt: '2026-08-01T00:00:01.000Z',
      method: 'content.text-delta',
      itemId: 'i1',
      delta: 'Matching answer.',
    });
    handleOrchestrationEvent(
      API_BASE,
      {
        eventId: 'e-done-x',
        provider: 'claude',
        threadId: THREAD_ID,
        createdAt: '2026-08-01T00:00:02.000Z',
        method: 'turn.completed',
        turnId: 'turn-live-1',
        finishReason: 'stop',
      },
      envelope,
    );

    expect(committedAssistantMessage()?.provenance).toEqual(envelope);
  });

  it('adopts a terminal whose turn.started fell outside this connection', () => {
    // No turn.started seen: the terminal is the only identity available.
    handleOrchestrationEvent(API_BASE, {
      eventId: 'e-delta-orphan',
      provider: 'claude',
      threadId: THREAD_ID,
      createdAt: '2026-08-01T00:00:01.000Z',
      method: 'content.text-delta',
      itemId: 'i1',
      delta: 'Resumed answer.',
    });
    handleOrchestrationEvent(
      API_BASE,
      {
        eventId: 'e-done-orphan',
        provider: 'claude',
        threadId: THREAD_ID,
        createdAt: '2026-08-01T00:00:02.000Z',
        method: 'turn.completed',
        turnId: 'turn-live-1',
        finishReason: 'stop',
      },
      envelope,
    );

    expect(committedAssistantMessage()?.turnId).toBe('turn-live-1');
    expect(committedAssistantMessage()?.provenance).toEqual(envelope);
  });

  it('keeps the transcript usable when the live envelope is unreadable', () => {
    runLiveTurn({ provenance: { envelopeVersion: 9999 } });

    renderCommittedRow();
    expect(screen.getByText('Here is the answer.')).toBeTruthy();
    expect(
      screen.getByText(
        /cannot read\. Nothing about this answer is being claimed/,
      ),
    ).toBeTruthy();
  });
});
