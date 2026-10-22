// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { AuthorityPersistenceContext } from '../contexts/AuthorityPersistenceContext';
import { useSessionEventWindow } from '../hooks/orchestration/useSessionEventWindow';
import {
  configureOfflineReading,
  readOfflineReading,
} from '../lib/offlineReading';

const memory = vi.hoisted(() => new Map<string, unknown>());
vi.mock('idb-keyval', () => ({
  createStore: () => null,
  get: async (key: string) => structuredClone(memory.get(key)),
  update: async (key: string, change: (value: unknown) => unknown) => {
    memory.set(key, structuredClone(change(memory.get(key))));
  },
}));
const windowRead = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', () => ({
  fetchSessionEventWindowCapability: async () => true,
  resetSessionEventWindowCapabilityRecovery: () => {},
  claimSessionEventWindowCapabilityRecovery: () => false,
  fetchOrchestrationConversationEventWindow: (...args: unknown[]) =>
    windowRead(...args),
  fetchOrchestrationSessionEventWindow: vi.fn(),
  SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS: 30000,
  SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS: 60000,
}));

test('a successful mounted history reader saves only opted-in recent text and rejects a retired response', async () => {
  const event = {
    sequence: 1,
    event: {
      eventId: 'event-a',
      method: 'turn.started',
      turnId: 'turn-a',
      prompt: 'History from the server',
      ambientContext: 'must not persist',
      createdAt: '2026-10-22T00:00:00.000Z',
    },
  };
  windowRead.mockResolvedValue({
    protocolVersion: 1,
    events: [event],
    watermark: 1,
    handoffs: [],
    contextBoundaries: [],
  });
  await configureOfflineReading('authority-a', 'binding-a', true, () => true);
  const mounted = renderHook(
    ({ threadId }) => useSessionEventWindow('http://station.test', threadId),
    {
      initialProps: { threadId: 'conversation-a' },
      wrapper: ({ children }) => (
        <AuthorityPersistenceContext.Provider
          value={{
            status: 'verified',
            namespace: 'authority-a',
            observation: null,
          }}
        >
          {children}
        </AuthorityPersistenceContext.Provider>
      ),
    },
  );
  await waitFor(() => expect(mounted.result.current.settled).toBe(true));
  await waitFor(async () =>
    expect((await readOfflineReading('authority-a')).copies[0]?.turns).toEqual([
      { role: 'user', text: 'History from the server' },
    ]),
  );
  let resolveLate!: (value: unknown) => void;
  windowRead.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveLate = resolve;
      }),
  );
  mounted.rerender({ threadId: 'conversation-late' });
  await waitFor(() => expect(resolveLate).toBeDefined());
  mounted.unmount();
  resolveLate({ protocolVersion: 1, events: [event], watermark: 1 });
  await Promise.resolve();
  expect(
    (await readOfflineReading('authority-a')).copies.map(
      (copy) => copy.conversationId,
    ),
  ).toEqual(['conversation-a']);
});
