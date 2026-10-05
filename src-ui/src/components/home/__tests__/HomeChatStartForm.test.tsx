/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  type NewChatIntent,
  OPEN_NEW_CHAT_EVENT,
  readNewChatIntent,
} from '../../../lib/newChatIntent';
import { HomeChatStartForm } from '../HomeChatStartForm';

afterEach(cleanup);
test('submits the goal once and keeps its text when preparation closes', () => {
  const intents: NewChatIntent[] = [];
  const receive = (event: Event) => intents.push(readNewChatIntent(event));
  window.addEventListener(OPEN_NEW_CHAT_EVENT, receive);
  try {
    render(<HomeChatStartForm identity="Codex" />);
    const input = screen.getByRole('textbox', {
      name: 'What would you like done?',
    });
    const start = screen.getByRole('button', { name: 'Start a chat' });
    expect(start).toHaveProperty('disabled', true);
    const prompt = '  Review this change.\nKeep my request intact.  ';
    fireEvent.change(input, { target: { value: prompt } });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.initialPrompt).toBe(prompt);
    expect(intents[0]?.startWithDefault).toBe(true);
    act(() => intents[0]?.onClosed?.());
    expect(input).toHaveProperty('value', prompt);
    expect(start).toHaveProperty('disabled', false);
  } finally {
    window.removeEventListener(OPEN_NEW_CHAT_EVENT, receive);
  }
});
test('New chat opens an unsent draft rather than submitting the Home goal', () => {
  const receive = vi.fn();
  window.addEventListener(OPEN_NEW_CHAT_EVENT, receive);
  try {
    render(<HomeChatStartForm />);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(receive).toHaveBeenCalledOnce();
    expect(
      readNewChatIntent(receive.mock.calls[0]![0]).startWithDefault,
    ).toBeUndefined();
  } finally {
    window.removeEventListener(OPEN_NEW_CHAT_EVENT, receive);
  }
});
// #3312: the compact form, shown above a page of work, still says which Agent
// and Model Start will run on — beside Start, without the "Using" caption —
// and describes the Start button with it.
test('the compact form names the identity Start uses, beside Start', () => {
  render(<HomeChatStartForm identity="Codex · gpt-5.3-codex" compact />);
  const start = screen.getByRole('button', { name: 'Start a chat' });
  expect(start.getAttribute('aria-describedby')).toBeTruthy();
  const note = document.getElementById(
    start.getAttribute('aria-describedby') ?? '',
  );
  expect(note?.textContent).toBe('Codex · gpt-5.3-codex');
  expect(screen.queryByText(/^Using /)).toBeNull();
  // One identity on the form, not a caption and a note.
  expect(screen.getAllByText('Codex · gpt-5.3-codex')).toHaveLength(1);
});
test('the compact form advertises nothing when no Agent is ready', () => {
  render(<HomeChatStartForm compact />);
  const start = screen.getByRole('button', { name: 'Start a chat' });
  expect(start.getAttribute('aria-describedby')).toBeNull();
  expect(document.querySelector('.home-view__goal-identity')).toBeNull();
});
