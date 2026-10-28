/** @vitest-environment jsdom */

/**
 * A right-click on a desktop message bubble opens that bubble's own `⋯` menu:
 * the user menu on a user bubble, the answer menu on an answer. Selected text
 * and links inside the bubble keep their own menus.
 */

import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../types';
import { selectTextAt } from './selection-stub';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('../components/chat/AttachAnswerToTaskButton', () => ({
  ConnectedAnswerActions: () => null,
  ConnectedAttachAnswerToTaskButton: () => (
    <output data-testid="answer-task-row" />
  ),
  ConnectedAttachUserInputToTaskButton: () => (
    <output data-testid="input-task-row" />
  ),
}));
vi.mock('../components/chat/ConnectedAnswerBasisAffordance', () => ({
  ConnectedAnswerBasisAffordance: () => null,
}));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  useQueryClient: () => ({
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  }),
  useSessionRelationsQuery: () => ({ data: { links: [] } }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [{ slug: 'alpha', name: 'Alpha' }] }),
}));

const { MessageBubble } = await import('../components/chat/MessageBubble');

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

function renderBubble(message: ChatMessage) {
  render(
    <MessageBubble
      msg={message}
      idx={0}
      activeSession={{
        id: 'session-1',
        agentSlug: 'station',
        projectSlug: 'alpha',
        messageCount: 1,
      }}
      agents={[]}
      chatFontSize={14}
      showReasoning={false}
      showToolDetails={false}
      onCopy={() => {}}
    />,
  );
}

function rightClick(target: Element): boolean {
  const event = createEvent.contextMenu(target, {
    button: 2,
    clientX: 5,
    clientY: 5,
  });
  fireEvent(target, event);
  return event.defaultPrevented;
}

describe('message bubble context menu', () => {
  test('a right-click on an answer opens the answer menu', async () => {
    renderBubble({
      role: 'assistant',
      content: 'The answer text',
      sessionId: 'session-1',
      turnId: 'turn-1',
      answerEligible: true,
    });
    const trigger = await screen.findByRole('button', {
      name: 'More answer actions',
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(rightClick(screen.getByText('The answer text'))).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu', { name: 'Answer actions' })).toBeTruthy();
    expect(await screen.findByTestId('answer-task-row')).toBeTruthy();
  });

  test('a right-click on a user message opens the message menu', async () => {
    renderBubble({
      role: 'user',
      content: 'My durable input',
      sessionId: 'session-1',
      turnId: 'turn-1',
      sourceEventId: 'event-1',
    });
    const trigger = await screen.findByRole('button', {
      name: 'More message actions',
    });
    expect(rightClick(screen.getByText('My durable input'))).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByTestId('input-task-row')).toBeTruthy();
  });

  test('selected text in the bubble keeps the native menu', async () => {
    renderBubble({
      role: 'assistant',
      content: 'Select me',
      sessionId: 'session-1',
      turnId: 'turn-1',
      answerEligible: true,
    });
    const trigger = await screen.findByRole('button', {
      name: 'More answer actions',
    });
    const text = screen.getByText('Select me');
    selectTextAt(text, { left: 0, top: 0, right: 100, bottom: 100 });
    expect(rightClick(text)).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  test('a right-click beside a selection still opens the menu', async () => {
    renderBubble({
      role: 'assistant',
      content: 'Partly selected',
      sessionId: 'session-1',
      turnId: 'turn-1',
      answerEligible: true,
    });
    const trigger = await screen.findByRole('button', {
      name: 'More answer actions',
    });
    const text = screen.getByText('Partly selected');
    selectTextAt(text, { left: 200, top: 200, right: 300, bottom: 220 });
    expect(rightClick(text)).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  test('a bubble with no ⋯ leaves the right-click to the platform', () => {
    // An optimistic user row: no fork, no Task tuple, so no menu to open.
    renderBubble({ role: 'user', content: 'Optimistic', clientId: 'local-1' });
    expect(rightClick(screen.getByText('Optimistic'))).toBe(false);
  });
});
