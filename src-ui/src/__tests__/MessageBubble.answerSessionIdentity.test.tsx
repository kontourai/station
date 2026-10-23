/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../types';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('../components/chat/AttachAnswerToTaskButton', () => ({
  ConnectedAnswerActions: ({
    sessionId,
    turnId,
  }: {
    sessionId: string;
    turnId: string;
  }) => (
    <>
      <output data-testid="answer-origin">{`${sessionId}/${turnId}`}</output>
      <output data-testid="basis-origin">{`${sessionId}/${turnId}`}</output>
    </>
  ),
  ConnectedAttachAnswerToTaskButton: ({
    sessionId,
    turnId,
  }: {
    sessionId: string;
    turnId: string;
  }) => <output data-testid="answer-origin">{`${sessionId}/${turnId}`}</output>,
  ConnectedAttachUserInputToTaskButton: ({
    sessionId,
    eventId,
  }: {
    sessionId: string;
    eventId: string;
  }) => <output data-testid="input-origin">{`${sessionId}/${eventId}`}</output>,
}));
vi.mock('../components/chat/ConnectedAnswerBasisAffordance', () => ({
  ConnectedAnswerBasisAffordance: ({
    sessionId,
    turnId,
  }: {
    sessionId: string;
    turnId: string;
  }) => <output data-testid="basis-origin">{`${sessionId}/${turnId}`}</output>,
}));

const createProposalTask = vi.hoisted(() => vi.fn());
const proposalCardProps = vi.hoisted(
  () => [] as Array<{ conversationId?: string; sessionId: string }>,
);
vi.mock('../components/chat/TaskProposalCard', async (original) => {
  const actual =
    await original<typeof import('../components/chat/TaskProposalCard')>();
  return {
    ...actual,
    TaskProposalCard: (
      props: Parameters<typeof actual.TaskProposalCard>[0],
    ) => {
      proposalCardProps.push(props);
      return actual.TaskProposalCard(props);
    },
  };
});
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  useQueryClient: () => ({
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  }),
  useSessionRelationsQuery: () => ({ data: { links: [] } }),
  useCreateTaskMutation: () => ({
    mutateAsync: createProposalTask,
    isPending: false,
  }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [{ slug: 'alpha', name: 'Alpha' }] }),
}));

const { MessageBubble } = await import('../components/chat/MessageBubble');

function row(message: ChatMessage, conversationId?: string) {
  return (
    <MessageBubble
      msg={message}
      idx={0}
      activeSession={{
        id: 'replacement-session',
        ...(conversationId ? { conversationId } : {}),
        agentSlug: 'station',
        projectSlug: 'alpha',
        messageCount: 1,
      }}
      agents={[]}
      chatFontSize={14}
      showReasoning={false}
      showToolDetails={false}
      onCopy={() => {}}
    />
  );
}

describe('MessageBubble answer Session identity', () => {
  test('attaches a historical row using its originating execution Session', async () => {
    render(
      row(
        {
          role: 'assistant',
          content: 'Historical answer',
          sessionId: 'original-session',
          turnId: 'turn-1',
          answerEligible: true,
        },
        'conversation-1',
      ),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'More answer actions' }),
    );
    expect((await screen.findByTestId('answer-origin')).textContent).toBe(
      'original-session/turn-1',
    );
    expect(screen.queryByTestId('basis-origin')).toBeNull();
  });

  const untagged: ChatMessage = {
    role: 'assistant',
    content: 'Unknown origin',
    turnId: 'turn-1',
    answerEligible: true,
  };

  test('does not guess the active replacement Session for an untagged historical row', async () => {
    // The overflow is a lazy chunk: preload it and let it settle, or its
    // absence below would hold before it could have rendered.
    await import('../components/chat/TurnActionsMenu');
    render(row(untagged, 'conversation-1'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(
      screen.queryByRole('button', { name: 'More answer actions' }),
    ).toBeNull();
    expect(screen.queryByTestId('answer-origin')).toBeNull();
    expect(screen.queryByTestId('basis-origin')).toBeNull();
  });

  // The control for the refusal above: without a conversation there is no
  // replacement Session, so the active Session is the row's own.
  test('attaches an untagged legacy one-session row to the active Session', async () => {
    render(row(untagged));
    fireEvent.click(
      await screen.findByRole('button', { name: 'More answer actions' }),
    );
    expect((await screen.findByTestId('answer-origin')).textContent).toBe(
      'replacement-session/turn-1',
    );
  });

  test('offers a Task action only for a durable user row with its full source tuple', async () => {
    render(
      row(
        {
          role: 'user',
          content: 'Durable input',
          sessionId: 'original-session',
          turnId: 'turn-1',
          sourceEventId: 'event-1',
        },
        'conversation-1',
      ),
    );
    // Desktop: the pin is a row of the bubble's ⋯ menu, not a standing button.
    expect(screen.queryByTestId('input-origin')).toBeNull();
    fireEvent.click(
      await screen.findByRole('button', { name: 'More message actions' }),
    );
    expect((await screen.findByTestId('input-origin')).textContent).toBe(
      'original-session/event-1',
    );
  });

  test('does not offer a Task action for an optimistic or content-reconciled user row', () => {
    render(
      row({ role: 'user', content: 'Optimistic input', clientId: 'local-1' }),
    );
    expect(screen.queryByTestId('input-origin')).toBeNull();
  });
});

const proposalText =
  '```station-task-proposal\n' +
  JSON.stringify({
    title: 'Installer progress',
    goal: 'See the current step.',
    doneWhen: ['Steps have counts.'],
    firstStep: 'Find the installer.',
  }) +
  '\n```';

test('a completed chat answer renders a provisional Task card; user text and incomplete answers cannot offer acceptance', () => {
  const view = render(
    row(
      {
        role: 'assistant',
        content: proposalText,
        sessionId: 'original-session',
        turnId: 'shape-turn',
        answerEligible: true,
      },
      'conversation-1',
    ),
  );
  expect(
    screen.getByRole('region', { name: 'Task proposal' }).textContent,
  ).toContain('Steps have counts.');
  expect(createProposalTask).not.toHaveBeenCalled();
  view.rerender(
    row({ role: 'user', content: proposalText, turnId: 'shape-turn' }),
  );
  expect(screen.queryByRole('region', { name: 'Task proposal' })).toBeNull();
  view.rerender(
    row({
      role: 'assistant',
      content: proposalText,
      turnId: 'shape-turn',
      answerEligible: false,
    }),
  );
  expect(screen.queryByRole('button', { name: 'Create Task' })).toBeNull();
});

test('the proposal card receives the conversation so acceptance can clear shaping after a Session change', () => {
  proposalCardProps.length = 0;
  render(
    row(
      {
        role: 'assistant',
        content: proposalText,
        sessionId: 'original-session',
        turnId: 'shape-turn',
        answerEligible: true,
      },
      'conversation-1',
    ),
  );
  expect(proposalCardProps.at(-1)).toMatchObject({
    conversationId: 'conversation-1',
    sessionId: 'original-session',
  });
});

test('a proposal with unknown source identity stays readable without offering acceptance', () => {
  const view = render(
    row(
      {
        role: 'assistant',
        content: proposalText,
        turnId: 'shape-turn',
        answerEligible: true,
      },
      'conversation-1',
    ),
  );
  expect(screen.queryByRole('region', { name: 'Task proposal' })).toBeNull();
  expect(view.container.textContent).toContain('station-task-proposal');
});
