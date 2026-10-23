/**
 * @vitest-environment jsdom
 *
 * A settled assistant row never renders as a header over an empty card. The
 * reasoning-only row comes from the real projection and chat's own part
 * mapping (the path `useActiveChatTranscript` takes), so the test reaches
 * the shape the transcript actually receives.
 */

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { conversationPartToContentParts } from '../hooks/orchestration/conversationTranscriptParts';
import type { ChatMessage } from '../types';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('../components/icons/AgentIcon', () => ({
  AgentIcon: () => <span>Agent</span>,
}));
vi.mock('../components/chat/ConnectedAnswerBasisAffordance', () => ({
  ConnectedAnswerBasisAffordance: () => <button type="button">Basis</button>,
}));

const { MessageBubble } = await import('../components/chat/MessageBubble');

const THOUGHT = 'Weighing the two options before answering.';

function projectedReasoningOnlyRow(): ChatMessage {
  const base = {
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: '2026-10-20T00:00:00.000Z',
    turnId: 'turn-1',
  };
  const rows = projectRuntimeEventsToMessages([
    { ...base, eventId: 'e1', method: 'turn.started', prompt: 'hi' },
    {
      ...base,
      eventId: 'e2',
      method: 'content.reasoning-delta',
      delta: THOUGHT,
    },
    { ...base, eventId: 'e3', method: 'turn.completed' },
  ] as CanonicalRuntimeEvent[]);
  const assistant = rows.find((row) => row.role === 'assistant');
  expect(assistant?.parts.map((part) => part.type)).toEqual(['reasoning']);
  return {
    role: 'assistant',
    content: '',
    turnId: 'turn-1',
    contentParts: assistant!.parts.flatMap(conversationPartToContentParts),
  };
}

function renderSettledRow(msg: ChatMessage, showReasoning: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageBubble
        msg={msg}
        // Not the last row: this is a settled row in history.
        idx={0}
        activeSession={{ id: 'thread-1', agentSlug: 'agent', messageCount: 3 }}
        agents={[]}
        chatFontSize={14}
        showReasoning={showReasoning}
        showToolDetails={false}
        onCopy={() => {}}
        anchorKey="row-1"
      />
    </QueryClientProvider>,
  );
}

describe('settled assistant rows with no answer text', () => {
  test('a reasoning-only row keeps a collapsed Reasoning disclosure instead of an empty card', () => {
    const { container } = renderSettledRow(projectedReasoningOnlyRow(), true);
    const disclosure = screen.getByRole('button', {
      name: /^Reasoning · 6 words/,
    });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(THOUGHT)).toBeNull();
    expect(container.querySelector('.message.assistant')).not.toBeNull();

    fireEvent.click(disclosure);
    expect(screen.getByText(THOUGHT)).toBeTruthy();
  });

  test('with reasoning hidden by the reader, the row draws no bubble at all', () => {
    const { container } = renderSettledRow(projectedReasoningOnlyRow(), false);
    expect(container.querySelector('.message-row')).toBeNull();
    expect(screen.queryByText('Agent')).toBeNull();
  });

  test('a row whose only text is whitespace draws no bubble', () => {
    const { container } = renderSettledRow(
      {
        role: 'assistant',
        content: '\n\n',
        contentParts: [{ type: 'text', content: '\n\n' }],
      },
      true,
    );
    expect(container.querySelector('.message-row')).toBeNull();
  });

  test('a row with an answer keeps reasoning out of the bubble (#2211)', () => {
    const row = projectedReasoningOnlyRow();
    renderSettledRow(
      {
        ...row,
        content: 'The answer.',
        contentParts: [
          ...(row.contentParts ?? []),
          { type: 'text', content: 'The answer.' },
        ],
      },
      true,
    );
    expect(screen.getByText('The answer.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Reasoning ·/ })).toBeNull();
  });

  test('an empty user row still renders its bubble', () => {
    const { container } = renderSettledRow({ role: 'user', content: '' }, true);
    expect(container.querySelector('.message-row--user')).not.toBeNull();
  });

  test('a turn that ended with nothing to show keeps its row: a one-line marker and its anchor', () => {
    const base = {
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-10-20T00:00:00.000Z',
      turnId: 'turn-quiet',
    };
    // A completed turn whose only output is reasoning, with reasoning hidden
    // by the reader: nothing to draw, but the turn ended and has a record.
    const assistant = projectRuntimeEventsToMessages([
      { ...base, eventId: 'e1', method: 'turn.started', prompt: 'hi' },
      {
        ...base,
        eventId: 'e2',
        method: 'content.reasoning-delta',
        delta: THOUGHT,
      },
      { ...base, eventId: 'e3', method: 'turn.completed' },
    ] as CanonicalRuntimeEvent[]).find((row) => row.role === 'assistant');
    expect(assistant?.metadata?.provenance?.outcome).toBe('completed');
    const { container } = renderSettledRow(
      {
        role: 'assistant',
        content: '',
        turnId: 'turn-quiet',
        contentParts: assistant!.parts.flatMap(conversationPartToContentParts),
        provenance: assistant!.metadata!.provenance,
      },
      false,
    );
    expect(screen.getByText('No reply')).toBeTruthy();
    // Its footer (the turn's record) stays with it, on the marker's line.
    expect(
      container.querySelector('.message__turn-outcome .turn-footer__bar'),
    ).not.toBeNull();
    expect(container.querySelector('.turn-footer')).toBeNull();
    expect(
      container.querySelector('[data-chat-message-key="row-1"]'),
    ).not.toBeNull();
  });

  test('an ended turn with no parts says how it ended; an open one draws nothing', () => {
    const stopped = renderSettledRow(
      {
        role: 'assistant',
        content: '',
        contentParts: [],
        turnId: 'turn-stop',
        turnEnded: 'aborted',
      },
      true,
    );
    expect(screen.getByText('Stopped')).toBeTruthy();
    // No reply and Stopped share one line shape: actions at the line's end,
    // no footer row beneath.
    expect(
      stopped.container.querySelector(
        '.message__turn-outcome .turn-footer__bar',
      ),
    ).not.toBeNull();
    expect(stopped.container.querySelector('.turn-footer')).toBeNull();
    // The person's own Stop needs no second line.
    expect(
      stopped.container.querySelector('.message__turn-outcome-detail'),
    ).toBeNull();
    stopped.unmount();

    const stalled = renderSettledRow(
      {
        role: 'assistant',
        content: '',
        contentParts: [],
        turnId: 'turn-stall',
        turnEnded: 'aborted',
        turnEndedReason: 'Stopped after the turn-stall window elapsed.',
        turnStoppedBy: 'stall',
      },
      true,
    );
    const detail = stalled.container.querySelector(
      '.message__turn-outcome-detail',
    );
    expect(detail?.textContent).toBe('No progress for too long');
    expect(detail?.getAttribute('title')).toBe(
      'Stopped after the turn-stall window elapsed.',
    );
    stalled.unmount();

    // History from before Station recorded who stopped a turn carries only
    // the forced Stop's reason: the person's needs no second line, and the
    // stall's reads as the stall's, its reason the tooltip.
    const personForced = renderSettledRow(
      {
        role: 'assistant',
        content: '',
        contentParts: [],
        turnId: 'turn-old-forced',
        turnEnded: 'aborted',
        turnEndedReason: 'Stopped after the cooperative cancel budget expired.',
      },
      true,
    );
    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(
      personForced.container.querySelector('.message__turn-outcome-detail'),
    ).toBeNull();
    personForced.unmount();

    const stallForced = renderSettledRow(
      {
        role: 'assistant',
        content: '',
        contentParts: [],
        turnId: 'turn-old-stall',
        turnEnded: 'aborted',
        turnEndedReason:
          'Stopped after the turn-stall window elapsed with no observed progress, then the cooperative cancel budget expired.',
      },
      true,
    );
    const oldStall = stallForced.container.querySelector(
      '.message__turn-outcome-detail',
    );
    expect(oldStall?.textContent).toBe('No progress for too long');
    expect(oldStall?.getAttribute('title')).toBe(
      'Stopped after the turn-stall window elapsed with no observed progress, then the cooperative cancel budget expired.',
    );
    stallForced.unmount();

    const quiet = renderSettledRow(
      {
        role: 'assistant',
        content: '',
        contentParts: [],
        turnEnded: 'completed',
      },
      true,
    );
    expect(screen.getByText('No reply')).toBeTruthy();
    quiet.unmount();

    const open = renderSettledRow(
      { role: 'assistant', content: '', contentParts: [] },
      true,
    );
    expect(open.container.querySelector('.message-row')).toBeNull();
  });

  test('a row without answer text offers no Basis, which could only read as missing', async () => {
    const base = {
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-10-20T00:00:00.000Z',
      turnId: 'turn-basis',
    };
    const project = (extra: CanonicalRuntimeEvent[]) =>
      projectRuntimeEventsToMessages(
        [
          { ...base, eventId: 'e1', method: 'turn.started', prompt: 'hi' },
          ...extra,
          { ...base, eventId: 'e9', method: 'turn.completed' },
        ] as CanonicalRuntimeEvent[],
        { markEndedTurns: true },
      ).find((row) => row.role === 'assistant')!;
    const toChat = (
      row: ReturnType<typeof projectRuntimeEventsToMessages>[number],
    ): ChatMessage => ({
      role: 'assistant',
      content: row.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join(''),
      contentParts: row.parts.flatMap(conversationPartToContentParts),
      turnId: row.metadata?.turnId,
      sessionId: row.metadata?.sessionId,
      answerEligible: row.metadata?.answerEligible,
      provenance: row.metadata?.provenance,
      turnEnded: row.metadata?.turnEnded,
    });

    const answered = renderSettledRow(
      toChat(
        project([
          {
            ...base,
            eventId: 'e2',
            method: 'content.text-delta',
            delta: 'An answer.',
          },
        ] as CanonicalRuntimeEvent[]),
      ),
      true,
    );
    expect(await screen.findByRole('button', { name: 'Basis' })).toBeTruthy();
    answered.unmount();

    const silent = toChat(project([]));
    expect(silent.answerEligible).toBe(true);
    renderSettledRow(silent, true);
    expect(screen.getByText('No reply')).toBeTruthy();
    // Give the lazy chip the same chance to appear before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: 'Basis' })).toBeNull();
  });
});
