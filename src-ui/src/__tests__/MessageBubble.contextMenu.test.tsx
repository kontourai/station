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

// Markdown reduced to its one construct these tests need: a `[text](url)` link.
vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => {
    const link = /\[(.+)\]\((.+)\)/.exec(children ?? '');
    return link ? (
      <div>
        <a href={link[2]}>{link[1]}</a>
      </div>
    ) : (
      <div>{children}</div>
    );
  },
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

  test('a link inside an answer keeps its own menu, not the bubble menu', async () => {
    renderBubble({
      role: 'assistant',
      content: '[the docs](https://example.com/docs)',
      sessionId: 'session-1',
      turnId: 'turn-1',
      answerEligible: true,
    });
    const trigger = await screen.findByRole('button', {
      name: 'More answer actions',
    });
    expect(rightClick(screen.getByRole('link', { name: 'the docs' }))).toBe(
      false,
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  test("a finger's long-press on a message is left to text selection", async () => {
    renderBubble({
      role: 'assistant',
      content: 'Touch me',
      sessionId: 'session-1',
      turnId: 'turn-1',
      answerEligible: true,
    });
    const trigger = await screen.findByRole('button', {
      name: 'More answer actions',
    });
    const text = screen.getByText('Touch me');
    fireEvent.pointerDown(text, { pointerType: 'touch', button: 0 });
    // Android's recogniser fires `contextmenu` from the hold.
    expect(rightClick(text)).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // A mouse afterwards is a right-click again.
    fireEvent.pointerDown(text, { pointerType: 'mouse', button: 2 });
    expect(rightClick(text)).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  test('a second right-click on the bubble leaves focus in the open menu', async () => {
    renderBubble({
      role: 'assistant',
      content: 'Twice',
      sessionId: 'session-1',
      turnId: 'turn-1',
      answerEligible: true,
    });
    await screen.findByRole('button', { name: 'More answer actions' });
    const text = screen.getByText('Twice');
    rightClick(text);
    const menu = screen.getByRole('menu', { name: 'Answer actions' });
    // Focus inside the menu first, as a pointer user's arrow keys put it.
    (menu.querySelector('[role="menuitem"]') as HTMLElement | null)?.focus();
    menu.focus();
    expect(menu.contains(document.activeElement)).toBe(true);
    expect(rightClick(text)).toBe(true);
    expect(menu.contains(document.activeElement)).toBe(true);
  });

  test("a right-click inside the open answer menu is not the bubble's", async () => {
    renderBubble({
      role: 'assistant',
      content: 'Inner',
      sessionId: 'session-1',
      turnId: 'turn-1',
      answerEligible: true,
    });
    await screen.findByRole('button', { name: 'More answer actions' });
    rightClick(screen.getByText('Inner'));
    const menu = screen.getByRole('menu', { name: 'Answer actions' });
    expect(rightClick(menu)).toBe(false);
  });

  test('the keyboard menu key after a finger has lifted opens the menu', async () => {
    renderBubble({
      role: 'assistant',
      content: 'Tapped then keyed',
      sessionId: 'session-1',
      turnId: 'turn-1',
      answerEligible: true,
    });
    const trigger = await screen.findByRole('button', {
      name: 'More answer actions',
    });
    const text = screen.getByText('Tapped then keyed');
    fireEvent.pointerDown(text, { pointerType: 'touch', button: 0 });
    fireEvent.pointerUp(text, { pointerType: 'touch' });
    const event = createEvent.contextMenu(text, {
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent(text, event);
    expect(event.defaultPrevented).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  test('a bubble with no ⋯ leaves the right-click to the platform', () => {
    // An optimistic user row: no fork, no Task tuple, so no menu to open.
    renderBubble({ role: 'user', content: 'Optimistic', clientId: 'local-1' });
    expect(rightClick(screen.getByText('Optimistic'))).toBe(false);
  });
});
