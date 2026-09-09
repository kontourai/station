/** @vitest-environment jsdom */
import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
  remove: vi.fn(),
  cancel: vi.fn(),
  create: vi.fn(),
}));
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: (
    id: string,
    _key: string,
    _mods: unknown,
    _description: string,
    handler: () => void,
  ) => {
    state.handlers.set(id, handler);
  },
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    initChat: state.create,
    removeChat: state.remove,
    addEphemeralMessage: vi.fn(),
  }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ selectedAgent: null, setActiveChat: vi.fn() }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useCancelMessage: () => state.cancel,
}));
vi.mock('../hooks/useActiveChatSessionMessaging', () => ({
  describeStopTurnOutcome: () => '',
}));

import { useChatDockKeyboardShortcuts } from '../hooks/useChatDockKeyboardShortcuts';

test('reader shortcuts close or replace the visible conversation without stopping a hidden chat', () => {
  state.handlers.clear();
  state.remove.mockClear();
  state.cancel.mockClear();
  state.create.mockClear();
  const close = vi.fn();
  const newChat = vi.fn();
  renderHook(() =>
    useChatDockKeyboardShortcuts({
      sessions: [{ id: 'background-chat' }],
      activeSessionId: null,
      activeSession: null,
      setShowSessionPicker: vi.fn(),
      focusSession: vi.fn(),
      onCloseCurrent: close,
      onNewChat: newChat,
    }),
  );
  state.handlers.get('dock.closeTab')!();
  expect(close).toHaveBeenCalledOnce();
  expect(state.remove).not.toHaveBeenCalled();
  state.handlers.get('dock.cancel')!();
  expect(state.cancel).not.toHaveBeenCalled();
  state.handlers.get('dock.newChat')!();
  expect(newChat).toHaveBeenCalledOnce();
  expect(state.create).not.toHaveBeenCalled();
});
