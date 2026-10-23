// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import type { OutboundQueueStorage } from '../lib/outboundQueue';

const getTurnDelivery = vi.fn();
const sendMessage = vi.fn();
vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  getTurnDelivery: (...args: unknown[]) => getTurnDelivery(...args),
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnectionStatus: () => ({ status: 'connected' }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => sendMessage,
}));

const values = new Map<string, unknown>();
const storage: OutboundQueueStorage = {
  getItem: async (key) => values.get(key),
  setItem: async (key, value) => {
    values.set(key, value);
  },
  updateItem: async (key, updater) => {
    values.set(key, updater(values.get(key)));
  },
};
const channels = new Set<QueueChannel>();
class QueueChannel extends EventTarget {
  constructor(readonly name: string) {
    super();
    channels.add(this);
  }
  postMessage(data: unknown) {
    for (const channel of channels)
      if (channel !== this && channel.name === this.name)
        channel.dispatchEvent(new MessageEvent('message', { data }));
  }
  close() {
    channels.delete(this);
  }
}

const mounted: Array<() => void> = [];
const queues: Array<typeof import('../lib/outboundQueue')> = [];
async function mountRenderer() {
  // Separate hook/queue module state: a module-global owner or flushing flag
  // must not accidentally make a two-renderer test pass.
  vi.resetModules();
  const queue = await import('../lib/outboundQueue');
  queue._setOutboundQueueStorage(storage, {
    get: async () => values.get('retired'),
    set: async (value) => {
      values.set('retired', value);
    },
  });
  queues.push(queue);
  queue.noteCurrentStation({ apiBase: 'http://api.test' });
  const { projectOutboundQueueEntries } = await import(
    '../hooks/outboundQueueProjection'
  );
  projectOutboundQueueEntries(await queue.outboundDispatch.open());
  const { useOutboundQueueFlush } = await import(
    '../hooks/useOutboundQueueFlush'
  );
  const registrations = vi.spyOn(document, 'addEventListener');
  const view = renderHook(() => useOutboundQueueFlush('http://api.test'));
  mounted.push(view.unmount);
  await settle();
  await settle();
  const visibilityListeners = registrations.mock.calls
    .filter(([type]) => type === 'visibilitychange')
    .map(([, listener]) => listener);
  registrations.mockRestore();
  const setVisibility = async (state: DocumentVisibilityState) => {
    // Each renderer has its own document in production. Deliver this event
    // only to the listeners registered by this mounted renderer.
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue(state);
    try {
      act(() => {
        for (const listener of visibilityListeners) {
          const event = new Event('visibilitychange');
          if (typeof listener === 'function') listener(event);
          else listener.handleEvent(event);
        }
      });
    } finally {
      visibility.mockRestore();
    }
    await settle();
  };
  return { ...view, queue, setVisibility };
}
async function settle() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // Both mounted renderers use the test renderer's React dispatcher; only
  // their application modules are reloaded.
  vi.doMock('react', () => React);
  vi.doMock('../contexts/active-chats-store', () => ({ activeChatsStore }));
  vi.stubGlobal('BroadcastChannel', QueueChannel);
  activeChatsStore.initChat('session-1', {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Unconfirmed send',
  });
  values.set('station-outbound-queue-v1', {
    version: 2,
    terminalEvidence: [],
    completedTerminals: [],
    turns: [
      {
        clientTurnId: 'key-orphan',
        station: { apiBase: 'http://api.test' },
        sessionId: 'session-1',
        conversationId: 'session-1',
        agentSlug: 'codex',
        content: 'already attempted',
        createdAt: Date.now() - 600_000,
        attempts: 1,
        status: 'invoking',
        origin: 'live',
      },
    ],
  });
  getTurnDelivery.mockRejectedValue(new Error('lookup unavailable'));
});
afterEach(async () => {
  for (const unmount of mounted.splice(0)) unmount();
  await settle();
  for (const queue of queues.splice(0)) {
    queue._resetOutboundQueueChangeChannel();
    queue._resetOutboundQueueStorage();
  }
  activeChatsStore.removeChat('session-1');
  values.clear();
  channels.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.doUnmock('react');
  vi.doUnmock('../contexts/active-chats-store');
});

it.each(['unmount', 'hidden'] as const)(
  'two mounted renderers share lookup backoff, observe queue changes, and take over after %s',
  async (leave) => {
    const owner = await mountRenderer();
    expect(getTurnDelivery).toHaveBeenCalledTimes(1);
    const follower = await mountRenderer();
    expect(getTurnDelivery).toHaveBeenCalledTimes(1);
    let calls = 1;
    for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      await advance(delay - 1);
      expect(getTurnDelivery).toHaveBeenCalledTimes(calls);
      await advance(1);
      expect(getTurnDelivery).toHaveBeenCalledTimes(++calls);
    }
    const followerReads = vi.spyOn(
      follower.queue.outboundDispatch,
      'retiredKeys',
    );
    followerReads.mockClear();
    // Queue notices still reach the non-owner and retire its projected bubble.
    await act(async () => {
      await owner.queue.outboundDispatch.enqueue({
        clientTurnId: 'discard-me',
        station: { apiBase: 'http://other-station.test' },
        sessionId: 'other-chat',
        agentSlug: 'codex',
        content: 'draft',
      });
      await owner.queue.outboundDispatch.discard('discard-me');
    });
    await settle();
    expect(followerReads).toHaveBeenCalled();
    expect(await follower.queue.outboundDispatch.retiredKeys()).toMatchObject({
      discarded: ['discard-me'],
    });
    // A change notice may cause the owner to look immediately, but not the follower.
    calls = getTurnDelivery.mock.calls.length;
    if (leave === 'unmount') owner.unmount();
    else await owner.setVisibility('hidden');
    await settle();
    // A queue notice reset the follower's lease check; takeover is within three seconds.
    await advance(3_000);
    expect(getTurnDelivery).toHaveBeenCalledTimes(++calls);
    if (leave === 'hidden') {
      await owner.setVisibility('visible');
      expect(getTurnDelivery).toHaveBeenCalledTimes(calls);
    }
    await advance(1_999);
    expect(getTurnDelivery).toHaveBeenCalledTimes(calls);
    await advance(1);
    expect(getTurnDelivery).toHaveBeenCalledTimes(++calls);
    getTurnDelivery.mockImplementation(
      async (_apiBase, conversationId, clientTurnId) => ({
        outcome: 'started',
        conversationId,
        clientTurnId,
        sessionId: 'session-1',
        turnId: 'provider-turn-orphan',
      }),
    );
    await advance(4_000);
    expect(await follower.queue.outboundDispatch.snapshot()).toEqual([]);
    expect(
      activeChatsStore.getSnapshot()['session-1']?.outboundQueuedTurns ?? [],
    ).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  },
);
