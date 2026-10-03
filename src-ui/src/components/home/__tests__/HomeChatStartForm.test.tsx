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
test('configuration choices are an explicit optional action', () => {
  const receive = vi.fn();
  window.addEventListener(OPEN_NEW_CHAT_EVENT, receive);
  try {
    render(<HomeChatStartForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    expect(receive).toHaveBeenCalledOnce();
    expect(
      readNewChatIntent(receive.mock.calls[0]![0]).startWithDefault,
    ).toBeUndefined();
  } finally {
    window.removeEventListener(OPEN_NEW_CHAT_EVENT, receive);
  }
});
