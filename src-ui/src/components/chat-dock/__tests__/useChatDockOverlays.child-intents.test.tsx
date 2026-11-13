// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { SurfaceIntentRecord } from '../../../contexts/RegionModelContext';
import { useChatDockOverlays } from '../useChatDockOverlays';

const offered = vi.hoisted(() => ({
  intent: undefined as SurfaceIntentRecord | undefined,
  consume: vi.fn(),
}));
vi.mock('../../../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => ({
    surfaceIntents: { chat: offered.intent },
    consumeSurfaceIntent: offered.consume,
  }),
}));
vi.mock('../../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({ inboxOpen: false }),
}));
const host = {
  id: 'working-tab',
  conversationId: 'parent-conversation',
  currentSessionId: 'parent-session',
};
function mount(hostSession: typeof host | null = host) {
  const hostSessionRef = { current: hostSession };
  const args = {
    isMobile: false,
    composerMenuTriggerRef: createRef<HTMLButtonElement>(),
    setDeviceSetting: vi.fn(),
    setShowNewChatModalState: vi.fn(),
    hasConversationIntent: true,
    onReaderIntent: vi.fn(),
    hostSessionRef,
  };
  return renderHook(() => useChatDockOverlays(args));
}
beforeEach(() => {
  offered.intent = undefined;
  offered.consume.mockReset();
});
test('a child request reuses the bound working parent instead of replacing its draft with a record reader', () => {
  offered.intent = {
    session: 'parent-session',
    childId: 'engine-child',
    token: 1,
  };
  const { result } = mount();
  expect(result.current.importedSessionId).toBeNull();
  expect(result.current.readerSurfaceIntent).toMatchObject({
    workingSessionId: 'working-tab',
    childId: 'engine-child',
  });
  act(() => result.current.consumeChildIntent(1));
  expect(result.current.readerSurfaceIntent?.childId).toBeUndefined();
});
test('a delegated session uses the same parent admission without treating its session id as an engine child id', () => {
  offered.intent = {
    session: 'parent-session',
    childSessionId: 'delegate-session',
    token: 2,
  };
  const { result } = mount();
  expect(result.current.importedSessionId).toBeNull();
  expect(result.current.readerSurfaceIntent).toMatchObject({
    workingSessionId: 'working-tab',
    childSessionId: 'delegate-session',
  });
});
test('unknown or foreign parent authority falls back to the record reader', () => {
  offered.intent = {
    session: 'parent-session',
    childId: 'engine-child',
    token: 3,
  };
  const { result } = mount(null);
  expect(result.current.importedSessionId).toBe('parent-session');
  expect(result.current.readerSurfaceIntent?.workingSessionId).toBeUndefined();
});
test('exact message anchors retain the recorded-message reader even for the active parent', () => {
  offered.intent = {
    session: 'parent-session',
    messageAnchor: { direction: 'received', requestKey: 'request' },
    token: 4,
  };
  const { result } = mount();
  expect(result.current.importedSessionId).toBe('parent-session');
  expect(result.current.readerSurfaceIntent?.messageAnchor?.requestKey).toBe(
    'request',
  );
});
test('consuming an older child request cannot clear a later request', () => {
  offered.intent = { session: 'parent-session', childId: 'first', token: 5 };
  const { result, rerender } = mount();
  offered.intent = {
    session: 'parent-session',
    childSessionId: 'later',
    token: 6,
  };
  rerender();
  act(() => result.current.consumeChildIntent(5));
  expect(result.current.readerSurfaceIntent?.childSessionId).toBe('later');
  act(() => result.current.onOpenInboxSession('parent-session'));
  expect(result.current.readerSurfaceIntent).toBeUndefined();
});
