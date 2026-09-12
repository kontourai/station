/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const registered = vi.hoisted(() => new Map<string, () => void>());
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: (
    id: string,
    _key: string,
    _modifiers: unknown,
    _description: string,
    handler: () => void,
  ) => registered.set(id, handler),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    removeChat: vi.fn(),
    addEphemeralMessage: vi.fn(),
  }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useCancelMessage: () => vi.fn(),
}));
vi.mock('../hooks/useActiveChatSessionMessaging', () => ({
  describeStopTurnOutcome: vi.fn(),
}));

import { useChatDockKeyboardShortcuts } from '../hooks/useChatDockKeyboardShortcuts';

test('the New chat command uses the canonical parent action with no active session', () => {
  const onNewChat = vi.fn();
  renderHook(() =>
    useChatDockKeyboardShortcuts({
      sessions: [],
      activeSessionId: null,
      activeSession: null,
      onNewChat,
      setShowSessionPicker: vi.fn(),
      focusSession: vi.fn(),
    }),
  );
  expect(registered.has('dock.newChat')).toBe(true);
  act(() => registered.get('dock.newChat')!());
  expect(onNewChat).toHaveBeenCalledOnce();
});
