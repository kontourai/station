/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  _resetOutboundQueueChangeChannel,
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  OUTBOUND_DEFER_RETRY_MS,
  outboundDispatch,
} from '../lib/outboundQueue';

const sendMessage = vi.fn();
const getTurnDelivery = vi.fn();
const connection = vi.hoisted(() => ({ status: 'connected' }));

vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  getTurnDelivery: (...args: unknown[]) => getTurnDelivery(...args),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnectionStatus: () => connection,
}));

vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => sendMessage,
}));

import { projectOutboundQueueEntries } from '../hooks/outboundQueueProjection';
import { useOutboundQueueFlush } from '../hooks/useOutboundQueueFlush';

describe('useOutboundQueueFlush', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connection.status = 'connected';
    _setOutboundQueueStorage({
      getItem: async () => [],
      setItem: async () => {},
      updateItem: async () => {
        throw new Error('IndexedDB is unavailable');
      },
    });
    activeChatsStore.initChat('session-1', {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Queued chat',
    });
  });

  afterEach(() => {
    activeChatsStore.removeChat('session-1');
    _resetOutboundQueueStorage();
  });

  it('surfaces a durable-settlement outage without invoking transport', async () => {
    renderHook(() => useOutboundQueueFlush('http://api.test'));

    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()['session-1']).toMatchObject({
        status: 'error',
        error: expect.stringContaining('delivery status is unavailable'),
      }),
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('drops the unsent bubble of a message discarded in another window', async () => {
    let stored: unknown;
    _setOutboundQueueStorage(
      {
        getItem: async () => stored,
        setItem: async (_key, value) => {
          stored = value;
        },
        updateItem: async (_key, updater) => {
          stored = updater(stored);
        },
      },
      {
        // Another window discarded `discarded-elsewhere`: only the shared
        // retired list says so.
        get: async () => [
          { clientTurnId: 'discarded-elsewhere', reason: 'discarded', at: 1 },
        ],
        set: async () => {},
      },
    );
    activeChatsStore.updateChat('session-1', {
      messages: [
        {
          id: 'discarded-elsewhere',
          clientId: 'discarded-elsewhere',
          role: 'user',
          content: 'not wanted',
          timestamp: 1,
        },
      ] as never,
    });
    renderHook(() => useOutboundQueueFlush('http://api.test'));
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()['session-1']?.messages).toEqual([]),
    );
  });

  it('drops the bubble when another window discards the message after this one opened', async () => {
    // Two windows share one channel name; a channel never hears its own post.
    const channels: Array<{
      name: string;
      listeners: Set<(event: { data: unknown }) => void>;
    }> = [];
    class FakeChannel {
      readonly listeners = new Set<(event: { data: unknown }) => void>();
      constructor(readonly name: string) {
        channels.push(this);
      }
      addEventListener(_t: string, l: (event: { data: unknown }) => void) {
        this.listeners.add(l);
      }
      removeEventListener(_t: string, l: (event: { data: unknown }) => void) {
        this.listeners.delete(l);
      }
      postMessage(data: unknown) {
        for (const channel of channels)
          if (channel !== this && channel.name === this.name)
            for (const listener of channel.listeners) listener({ data });
      }
      close() {}
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    let stored: unknown;
    let retired: unknown[] = [];
    _setOutboundQueueStorage(
      {
        getItem: async () => stored,
        setItem: async (_key, value) => {
          stored = value;
        },
        updateItem: async (_key, updater) => {
          stored = updater(stored);
        },
      },
      {
        get: async () => retired,
        set: async (next) => {
          retired = next as unknown[];
        },
      },
    );
    activeChatsStore.updateChat('session-1', {
      messages: [
        {
          id: 'discarded-later',
          clientId: 'discarded-later',
          role: 'user',
          content: 'thrown away in the other window',
          timestamp: 1,
        },
      ] as never,
    });
    try {
      const reads = vi.spyOn(outboundDispatch, 'retiredKeys');
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      // This window has read the queue once and still shows the bubble.
      await waitFor(() => expect(reads).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        activeChatsStore.getSnapshot()['session-1']?.messages,
      ).toHaveLength(1);
      // The other window discards it and announces the change.
      retired = [
        { clientTurnId: 'discarded-later', reason: 'discarded', at: 2 },
      ];
      // Nothing in this window re-reads the queue by itself.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        activeChatsStore.getSnapshot()['session-1']?.messages,
      ).toHaveLength(1);
      const otherWindow = new FakeChannel('station-outbound-queue');
      otherWindow.postMessage('changed');
      await waitFor(() =>
        expect(activeChatsStore.getSnapshot()['session-1']?.messages).toEqual(
          [],
        ),
      );
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      _resetOutboundQueueChangeChannel();
    }
  });

  it('re-reads finished keys when the window comes back into view', async () => {
    // No channel at all: only the visibility change can carry the news.
    vi.stubGlobal('BroadcastChannel', undefined);
    let stored: unknown;
    let retired: unknown[] = [];
    _setOutboundQueueStorage(
      {
        getItem: async () => stored,
        setItem: async (_key, value) => {
          stored = value;
        },
        updateItem: async (_key, updater) => {
          stored = updater(stored);
        },
      },
      {
        get: async () => retired,
        set: async (next) => {
          retired = next as unknown[];
        },
      },
    );
    activeChatsStore.updateChat('session-1', {
      messages: [
        {
          id: 'discarded-while-hidden',
          clientId: 'discarded-while-hidden',
          role: 'user',
          content: 'thrown away while this window was hidden',
          timestamp: 1,
        },
      ] as never,
    });
    try {
      const reads = vi.spyOn(outboundDispatch, 'retiredKeys');
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(() => expect(reads).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        activeChatsStore.getSnapshot()['session-1']?.messages,
      ).toHaveLength(1);
      retired = [
        { clientTurnId: 'discarded-while-hidden', reason: 'discarded', at: 2 },
      ];
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        activeChatsStore.getSnapshot()['session-1']?.messages,
      ).toHaveLength(1);
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() =>
        expect(activeChatsStore.getSnapshot()['session-1']?.messages).toEqual(
          [],
        ),
      );
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("another window's change refreshes this one without a flush, so two tabs holding one key never take it from each other", async () => {
    // Two renderers that share a held key: a duplicated tab copies its
    // session storage, queue and all. The other one is simulated through the
    // shared storage and the cross-window channel.
    const channels: Array<{
      name: string;
      listeners: Set<(event: { data: unknown }) => void>;
    }> = [];
    class FakeChannel {
      readonly listeners = new Set<(event: { data: unknown }) => void>();
      constructor(readonly name: string) {
        channels.push(this);
      }
      addEventListener(_t: string, l: (event: { data: unknown }) => void) {
        this.listeners.add(l);
      }
      removeEventListener(_t: string, l: (event: { data: unknown }) => void) {
        this.listeners.delete(l);
      }
      postMessage(data: unknown) {
        for (const channel of channels)
          if (channel !== this && channel.name === this.name)
            for (const listener of channel.listeners) listener({ data });
      }
      close() {}
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    let stored: unknown;
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    activeChatsStore.updateChat('session-1', {
      queuedMessages: ['held in both tabs'],
      queuedMessageMetadata: [{ id: 'shared-held-key' }],
    } as never);
    const heldBy = () => {
      const record = stored as { turns?: Array<Record<string, unknown>> };
      return (record?.turns ?? []).find(
        (turn) => turn.clientTurnId === 'shared-held-key',
      )?.heldBy as { bootId: string } | undefined;
    };
    try {
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      // This tab holds its copy of the follow-up in the outbox.
      await waitFor(() => expect(heldBy()).toBeDefined());
      await new Promise((resolve) => setTimeout(resolve, 100));
      const reads = vi.spyOn(outboundDispatch, 'open');
      const passes = vi.spyOn(outboundDispatch, 'reconcile');
      const holds = vi.spyOn(outboundDispatch, 'syncHeld');
      // The other tab holds the same key now, and says the queue changed.
      const record = stored as { turns: Array<Record<string, unknown>> };
      stored = {
        ...record,
        turns: record.turns.map((turn) =>
          turn.clientTurnId === 'shared-held-key'
            ? { ...turn, heldBy: { bootId: 'other-tab', heldAt: Date.now() } }
            : turn,
        ),
      };
      new FakeChannel('station-outbound-queue').postMessage('changed');
      // What this window shows is read again...
      await waitFor(() => expect(reads).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 300));
      // ...and nothing takes the key back, which would tell the other tab
      // to take it again in turn.
      expect(passes).not.toHaveBeenCalled();
      expect(holds).not.toHaveBeenCalled();
      expect(heldBy()?.bootId).toBe('other-tab');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      _resetOutboundQueueChangeChannel();
      activeChatsStore.updateChat('session-1', {
        queuedMessages: [],
        queuedMessageMetadata: [],
      } as never);
    }
  });

  it("shows another window's send as under way only while that window runs, and notices when it stops", async () => {
    // That window holds its renderer lock while it runs.
    const held = new Set(['station-outbound-renderer:other-window']);
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: async (
          _name: string,
          optionsOrCallback: unknown,
          maybeCallback?: () => Promise<unknown>,
        ) =>
          (
            (typeof optionsOrCallback === 'function'
              ? optionsOrCallback
              : maybeCallback) as () => Promise<unknown>
          )(),
        query: async () => ({ held: [...held].map((name) => ({ name })) }),
      },
    });
    const now = Date.now();
    let stored: unknown = [
      {
        clientTurnId: 'sending-elsewhere',
        sessionId: 'session-1',
        conversationId: 'session-1',
        agentSlug: 'codex',
        content: 'sent from the other window',
        createdAt: now,
        attempts: 1,
        status: 'invoking',
        dispatchBootId: 'other-window',
        claimedAt: now,
      },
    ];
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    const row = () =>
      activeChatsStore
        .getSnapshot()
        ['session-1']?.outboundQueuedTurns?.find(
          (turn) => turn.clientTurnId === 'sending-elsewhere',
        );
    try {
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(() =>
        expect(row()).toMatchObject({
          status: 'invoking',
          sendUnderWay: true,
        }),
      );
      // That window crashes: nothing announces it, yet the row stops
      // reading as under way.
      held.clear();
      await waitFor(
        () => {
          expect(row()).toMatchObject({ status: 'invoking' });
          expect(row()?.sendUnderWay).toBeUndefined();
        },
        { timeout: 10_000 },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);

  it("sends a message held back by another window's send once that send settles there, even with that window closed", async () => {
    const channels: Array<{
      name: string;
      listeners: Set<(event: { data: unknown }) => void>;
    }> = [];
    class FakeChannel {
      readonly listeners = new Set<(event: { data: unknown }) => void>();
      constructor(readonly name: string) {
        channels.push(this);
      }
      addEventListener(_t: string, l: (event: { data: unknown }) => void) {
        this.listeners.add(l);
      }
      removeEventListener(_t: string, l: (event: { data: unknown }) => void) {
        this.listeners.delete(l);
      }
      postMessage(data: unknown) {
        for (const channel of channels)
          if (channel !== this && channel.name === this.name)
            for (const listener of channel.listeners) listener({ data });
      }
      close() {}
    }
    // An earlier test may have left the queue's channel open on another
    // implementation; this one listens on the fake.
    _resetOutboundQueueChangeChannel();
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    // Window B is running, so its send blocks this chat's later message.
    const held = new Set(['station-outbound-renderer:window-b']);
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: async (
          _name: string,
          optionsOrCallback: unknown,
          maybeCallback?: () => Promise<unknown>,
        ) =>
          (
            (typeof optionsOrCallback === 'function'
              ? optionsOrCallback
              : maybeCallback) as () => Promise<unknown>
          )(),
        query: async () => ({ held: [...held].map((name) => ({ name })) }),
      },
    });
    const now = Date.now();
    const base = {
      sessionId: 'session-1',
      conversationId: 'session-1',
      agentSlug: 'codex',
    };
    let stored: unknown = [
      {
        ...base,
        clientTurnId: 'b-sending',
        content: 'sent from window B',
        createdAt: now,
        attempts: 1,
        status: 'invoking',
        dispatchBootId: 'window-b',
        claimedAt: now,
      },
      {
        ...base,
        clientTurnId: 'a-waiting',
        content: 'written in this window, after it',
        createdAt: now + 1,
        attempts: 0,
        status: 'pending',
      },
    ];
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    sendMessage.mockResolvedValue({
      kind: 'accepted',
      providerTurnId: 'provider-turn-a',
    });
    // A follow-up this tab and a duplicate of it both hold.
    activeChatsStore.updateChat('session-1', {
      queuedMessages: ['held in both tabs'],
      queuedMessageMetadata: [{ id: 'shared-held-key' }],
    } as never);
    const heldBy = () =>
      ((stored as { turns?: Array<Record<string, unknown>> }).turns ?? []).find(
        (turn) => turn.clientTurnId === 'shared-held-key',
      )?.heldBy as { bootId: string } | undefined;
    try {
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(() => expect(heldBy()).toBeDefined());
      await waitFor(() =>
        expect(
          activeChatsStore
            .getSnapshot()
            ['session-1']?.outboundQueuedTurns?.some(
              (turn) => turn.clientTurnId === 'a-waiting',
            ),
        ).toBe(true),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sendMessage).not.toHaveBeenCalled();
      const reconciles = vi.spyOn(outboundDispatch, 'reconcile');
      // B's send settles there (its row leaves the outbox), B closes, and
      // B's notice is the only thing this window hears.
      const record = stored as { turns: Array<Record<string, unknown>> };
      stored = {
        ...record,
        turns: record.turns
          .filter((turn) => turn.clientTurnId !== 'b-sending')
          // Meanwhile the duplicate tab holds the shared follow-up.
          .map((turn) =>
            turn.clientTurnId === 'shared-held-key'
              ? { ...turn, heldBy: { bootId: 'other-tab', heldAt: now } }
              : turn,
          ),
      };
      held.clear();
      new FakeChannel('station-outbound-queue').postMessage('changed');
      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      expect(sendMessage.mock.calls[0]?.[6]).toBe('a-waiting');
      // That pass did not take the shared key back from the duplicate tab,
      // and asked Station about nothing (which can release a duplicate
      // tab's held follow-up to pending, for this pass to send).
      expect(heldBy()?.bootId).toBe('other-tab');
      expect(reconciles).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      _resetOutboundQueueChangeChannel();
      activeChatsStore.updateChat('session-1', {
        queuedMessages: [],
        queuedMessageMetadata: [],
      } as never);
    }
  });

  it("another window's notices never re-send a message this window cannot send yet, so its attempts do not wear out", async () => {
    const channels: Array<{
      name: string;
      listeners: Set<(event: { data: unknown }) => void>;
    }> = [];
    class FakeChannel {
      readonly listeners = new Set<(event: { data: unknown }) => void>();
      constructor(readonly name: string) {
        channels.push(this);
      }
      addEventListener(_t: string, l: (event: { data: unknown }) => void) {
        this.listeners.add(l);
      }
      removeEventListener(_t: string, l: (event: { data: unknown }) => void) {
        this.listeners.delete(l);
      }
      postMessage(data: unknown) {
        for (const channel of channels)
          if (channel !== this && channel.name === this.name)
            for (const listener of channel.listeners) listener({ data });
      }
      close() {}
    }
    _resetOutboundQueueChangeChannel();
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    let stored: unknown = [
      {
        clientTurnId: 'busy-chat-message',
        sessionId: 'session-1',
        conversationId: 'session-1',
        agentSlug: 'codex',
        content: 'waits for the running turn',
        createdAt: Date.now(),
        attempts: 0,
        status: 'pending',
      },
    ];
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    // The chat's turn is running: every send is refused before the provider.
    sendMessage.mockResolvedValue({ kind: 'not-invoked' });
    const attempts = () =>
      ((stored as { turns?: Array<{ attempts: number; status: string }> })
        .turns ?? [])[0];
    try {
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      // Whatever this window's own triggers send at mount, then it settles.
      await waitFor(() => expect(sendMessage).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 300));
      const before = { calls: sendMessage.mock.calls.length, ...attempts() };
      // The other window notices (no-op changes there) three times.
      for (let notice = 0; notice < 3; notice += 1) {
        new FakeChannel('station-outbound-queue').postMessage('changed');
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(sendMessage).toHaveBeenCalledTimes(before.calls);
      expect(attempts()).toMatchObject({
        status: 'pending',
        attempts: before.attempts,
      });
    } finally {
      vi.unstubAllGlobals();
      _resetOutboundQueueChangeChannel();
    }
  });

  it('replays the model and provider options captured when the turn was queued', async () => {
    let stored: unknown;
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    await outboundDispatch.enqueue({
      clientTurnId: 'queued-model-x',
      sessionId: 'session-1',
      agentSlug: 'codex',
      content: 'keep my model',
      requestedModel: 'model-x',
      requestedProviderOptions: { effort: 'high' },
      model: 'model-x-resolved',
      providerOptions: { effort: 'high', fastMode: true },
    });
    activeChatsStore.updateChat('session-1', {
      requestedModel: 'model-y',
      providerOptions: { effort: 'low' },
    });
    sendMessage.mockResolvedValue({
      kind: 'accepted',
      providerTurnId: 'provider-turn-1',
    });

    renderHook(() => useOutboundQueueFlush('http://api.test'));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[7]).toMatchObject({
      executionSnapshot: {
        requestedModel: 'model-x',
        requestedProviderOptions: { effort: 'high' },
        model: 'model-x-resolved',
        providerOptions: { effort: 'high', fastMode: true },
      },
    });
  });

  it('sends a waiting row once its chat becomes writable, after the pass that deferred it', async () => {
    let stored: unknown;
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    // A reloaded chat re-proves its conversation before it may send.
    activeChatsStore.updateChat('session-1', { conversationOpenPending: true });
    await outboundDispatch.enqueue({
      clientTurnId: 'waits-for-open',
      sessionId: 'session-1',
      agentSlug: 'codex',
      content: 'send me when writable',
    });
    sendMessage.mockResolvedValue({
      kind: 'accepted',
      providerTurnId: 'provider-turn-open',
    });
    renderHook(() => useOutboundQueueFlush('http://api.test'));
    await waitFor(() =>
      expect(
        activeChatsStore.getSnapshot()['session-1']?.outboundQueuedTurns,
      ).toEqual([expect.objectContaining({ clientTurnId: 'waits-for-open' })]),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    activeChatsStore.updateChat('session-1', {
      conversationOpenPending: false,
    });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[6]).toBe('waits-for-open');
  });

  it("keeps a durable copy of each follow-up held in a chat's queue, and drops it when the queue no longer holds it", async () => {
    let stored: unknown;
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    activeChatsStore.updateChat('session-1', {
      queuedMessages: ['held one', 'steering one'],
      queuedMessageMetadata: [
        { id: 'held-key', mode: 'queue' },
        { id: 'steer-key', mode: 'steer', delivery: 'steering' },
      ],
    });
    renderHook(() => useOutboundQueueFlush('http://api.test'));
    await waitFor(async () =>
      expect(await outboundDispatch.snapshot()).toEqual([
        expect.objectContaining({
          clientTurnId: 'held-key',
          content: 'held one',
          status: 'pending',
          heldBy: expect.objectContaining({ bootId: expect.any(String) }),
          station: { apiBase: 'http://api.test' },
        }),
      ]),
    );
    // Held rows are the queue's to send while this app lives.
    expect(sendMessage).not.toHaveBeenCalled();
    activeChatsStore.updateChat('session-1', {
      queuedMessages: [],
      queuedMessageMetadata: [],
    });
    await waitFor(async () =>
      expect(await outboundDispatch.snapshot()).toEqual([]),
    );
  });

  describe('a reload while messages were held or mid-drain', () => {
    function storedRows(turns: unknown[]) {
      let stored: unknown = {
        version: 2,
        terminalEvidence: [],
        completedTerminals: [],
        turns,
      };
      _setOutboundQueueStorage({
        getItem: async () => stored,
        setItem: async (_key, value) => {
          stored = value;
        },
        updateItem: async (_key, updater) => {
          stored = updater(stored);
        },
      });
    }
    const longAgo = Date.now() - 10 * 60_000;

    it("the restored queue takes back a held copy before the flush could send it, so the queue's edit is the only sender", async () => {
      storedRows([
        {
          clientTurnId: 'held-key',
          sessionId: 'session-1',
          conversationId: 'session-1',
          agentSlug: 'codex',
          content: 'original text',
          createdAt: longAgo,
          attempts: 0,
          status: 'pending',
          // The previous page's renderer, gone well past the grace period.
          heldBy: {
            bootId: 'renderer-before-reload',
            heldAt: longAgo,
            orphanSince: longAgo,
          },
        },
      ]);
      activeChatsStore.updateChat('session-1', {
        queuedMessages: ['edited text'],
        queuedMessageMetadata: [{ id: 'held-key', mode: 'queue' }],
      });
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(async () =>
        expect(await outboundDispatch.snapshot()).toEqual([
          expect.objectContaining({
            clientTurnId: 'held-key',
            content: 'edited text',
            heldBy: expect.objectContaining({
              bootId: expect.not.stringMatching(/^renderer-before-reload$/),
            }),
          }),
        ]),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('a send that was mid-drain at the reload is taken back by the restored queue when Station never received it, not also flushed', async () => {
      storedRows([
        {
          clientTurnId: 'drained-key',
          sessionId: 'session-1',
          conversationId: 'session-1',
          agentSlug: 'codex',
          content: 'mid drain',
          createdAt: longAgo,
          attempts: 1,
          status: 'invoking',
          origin: 'live',
          dispatchBootId: 'renderer-before-reload',
          claimedAt: longAgo,
        },
      ]);
      // The reload restored it to the head of the chat's queue.
      activeChatsStore.updateChat('session-1', {
        queuedMessages: ['mid drain'],
        queuedMessageMetadata: [{ id: 'drained-key', mode: 'queue' }],
      });
      getTurnDelivery.mockImplementation(
        async (_apiBase, conversationId, clientTurnId) => ({
          outcome: 'not-received',
          conversationId,
          clientTurnId,
        }),
      );
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(() => expect(getTurnDelivery).toHaveBeenCalled());
      await waitFor(async () =>
        expect(await outboundDispatch.snapshot()).toEqual([
          expect.objectContaining({
            clientTurnId: 'drained-key',
            status: 'pending',
            heldBy: expect.objectContaining({ bootId: expect.any(String) }),
          }),
        ]),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('a send the app was closed during', () => {
    async function orphanedLiveRow(reconciliationLeases: unknown[] = []) {
      let stored: unknown = {
        version: 2,
        terminalEvidence: [],
        completedTerminals: [],
        reconciliationLeases,
        turns: [
          {
            clientTurnId: 'key-orphan',
            station: { apiBase: 'http://api.test' },
            sessionId: 'session-1',
            conversationId: 'session-1',
            agentSlug: 'codex',
            content: 'sent as the app closed',
            createdAt: Date.now() - 10 * 60_000,
            attempts: 1,
            status: 'invoking',
            origin: 'live',
            // A renderer that no longer exists; this platform has no Web
            // Locks, so the row's age decides it is abandoned.
            dispatchBootId: 'renderer-that-was-killed',
            claimedAt: Date.now() - 10 * 60_000,
          },
        ],
      };
      _setOutboundQueueStorage({
        getItem: async () => stored,
        setItem: async (_key, value) => {
          stored = value;
        },
      });
      projectOutboundQueueEntries(await outboundDispatch.open());
    }

    const settleImports = async () => {
      await act(async () => {
        await vi.dynamicImportSettled();
      });
    };

    it.each([
      'hidden',
      'browser offline',
      'connection unreachable',
      'pagehide',
      'pagehide then hidden pageshow',
      'pagehide then reconnect',
    ] as const)(
      'pauses lookup backoff while %s and resumes immediately at two seconds',
      async (pause) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        let visibility: DocumentVisibilityState = 'visible';
        let online = true;
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
          () => visibility,
        );
        vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
        await orphanedLiveRow();
        getTurnDelivery.mockRejectedValue(new Error('lookup unavailable'));
        const view = renderHook(() => useOutboundQueueFlush('http://api.test'));
        try {
          await settleImports();
          await act(async () => {
            await vi.advanceTimersByTimeAsync(2_000);
          });
          await settleImports();
          expect(getTurnDelivery).toHaveBeenCalledTimes(2);
          await act(async () => {
            if (pause === 'hidden') {
              visibility = 'hidden';
              document.dispatchEvent(new Event('visibilitychange'));
            } else if (pause === 'browser offline') {
              online = false;
              window.dispatchEvent(new Event('offline'));
            } else if (pause.startsWith('pagehide')) {
              window.dispatchEvent(new Event('pagehide'));
            } else {
              connection.status = 'error';
              view.rerender();
            }
          });
          await settleImports();
          if (pause === 'pagehide then reconnect') {
            act(() => {
              connection.status = 'error';
              view.rerender();
            });
            await settleImports();
            act(() => {
              connection.status = 'connected';
              view.rerender();
              window.dispatchEvent(new Event('online'));
            });
            await settleImports();
          }
          expect(vi.getTimerCount()).toBe(0);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(120_000);
          });
          await settleImports();
          expect(getTurnDelivery).toHaveBeenCalledTimes(2);
          expect((await outboundDispatch.snapshot())[0]).toMatchObject({
            status: 'invoking',
          });
          await act(async () => {
            if (pause === 'hidden') {
              visibility = 'visible';
              document.dispatchEvent(new Event('visibilitychange'));
            } else if (pause === 'browser offline') {
              online = true;
              window.dispatchEvent(new Event('online'));
            } else if (
              pause === 'pagehide' ||
              pause === 'pagehide then reconnect'
            ) {
              window.dispatchEvent(new Event('pageshow'));
            } else if (pause === 'pagehide then hidden pageshow') {
              visibility = 'hidden';
              window.dispatchEvent(new Event('pageshow'));
            } else {
              connection.status = 'connected';
              view.rerender();
            }
          });
          await settleImports();
          if (pause === 'pagehide then hidden pageshow') {
            await act(async () => {
              await vi.advanceTimersByTimeAsync(120_000);
            });
            await settleImports();
            expect(getTurnDelivery).toHaveBeenCalledTimes(2);
            await act(async () => {
              visibility = 'visible';
              document.dispatchEvent(new Event('visibilitychange'));
            });
            await settleImports();
          }
          expect(getTurnDelivery).toHaveBeenCalledTimes(3);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(1_999);
          });
          expect(getTurnDelivery).toHaveBeenCalledTimes(3);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
          });
          await settleImports();
          expect(getTurnDelivery).toHaveBeenCalledTimes(4);
          expect(sendMessage).not.toHaveBeenCalled();
        } finally {
          view.unmount();
          await settleImports();
          vi.restoreAllMocks();
          vi.useRealTimers();
        }
      },
    );

    it('ignores an already-persisted reconciliation lease and retries locally', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      await orphanedLiveRow([
        {
          owner: 'renderer-that-disappeared',
          station: { apiBase: 'http://api.test' },
          expiresAt: Date.now() + 15_000,
        },
      ]);
      getTurnDelivery.mockRejectedValue(new Error('lookup unavailable'));
      const view = renderHook(() => useOutboundQueueFlush('http://api.test'));
      try {
        await settleImports();
        expect(getTurnDelivery).toHaveBeenCalledTimes(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
        });
        await settleImports();
        expect(getTurnDelivery).toHaveBeenCalledTimes(2);
        expect(sendMessage).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        await settleImports();
        vi.useRealTimers();
      }
    });

    it('recovers a failed delivery lookup without another queue event or resend', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      await orphanedLiveRow();
      getTurnDelivery
        .mockRejectedValueOnce(new Error('lookup timed out'))
        .mockImplementation(async (_apiBase, conversationId, clientTurnId) => ({
          outcome: 'started',
          conversationId,
          clientTurnId,
          sessionId: 'session-1',
          turnId: 'provider-turn-orphan',
        }));
      const view = renderHook(() => useOutboundQueueFlush('http://api.test'));
      try {
        await settleImports();
        expect(getTurnDelivery).toHaveBeenCalledTimes(1);
        expect((await outboundDispatch.snapshot())[0]).toMatchObject({
          status: 'invoking',
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_999);
        });
        expect(getTurnDelivery).toHaveBeenCalledTimes(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        await settleImports();
        expect(getTurnDelivery).toHaveBeenCalledTimes(2);
        expect(await outboundDispatch.snapshot()).toEqual([]);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(120_000);
        });
        await settleImports();
        expect(getTurnDelivery).toHaveBeenCalledTimes(2);
        expect(sendMessage).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        vi.useRealTimers();
      }
    });

    it('a connected StrictMode mount still reconciles after its first effect lifetime ends', async () => {
      await orphanedLiveRow();
      getTurnDelivery.mockImplementation(
        async (_apiBase, conversationId, clientTurnId) => ({
          outcome: 'started',
          conversationId,
          clientTurnId,
          sessionId: 'session-1',
          turnId: 'provider-turn-orphan',
        }),
      );
      renderHook(() => useOutboundQueueFlush('http://api.test'), {
        wrapper: ({ children }) => createElement(StrictMode, null, children),
      });
      await waitFor(async () =>
        expect(await outboundDispatch.snapshot()).toEqual([]),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('a new mount recovers after the old mount unmounts during its lookup', async () => {
      await orphanedLiveRow();
      let rejectLookup!: (error: Error) => void;
      getTurnDelivery
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectLookup = reject;
            }),
        )
        .mockImplementation(async (_apiBase, conversationId, clientTurnId) => ({
          outcome: 'started',
          conversationId,
          clientTurnId,
          sessionId: 'session-1',
          turnId: 'provider-turn-orphan',
        }));
      const first = renderHook(() => useOutboundQueueFlush('http://api.test'));
      await settleImports();
      expect(getTurnDelivery).toHaveBeenCalledTimes(1);
      first.unmount();
      const next = renderHook(() => useOutboundQueueFlush('http://api.test'));
      rejectLookup(new Error('late failure from the old mount'));
      await waitFor(async () =>
        expect(await outboundDispatch.snapshot()).toEqual([]),
      );
      expect(getTurnDelivery).toHaveBeenCalledTimes(2);
      expect(sendMessage).not.toHaveBeenCalled();
      next.unmount();
    });

    it('backs failed lookups off to 60 seconds and cancels on unmount', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      await orphanedLiveRow();
      getTurnDelivery.mockRejectedValue(new Error('lookup unavailable'));
      const view = renderHook(() => useOutboundQueueFlush('http://api.test'));
      try {
        await settleImports();
        let calls = 1;
        for (const delay of [
          2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
        ]) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(delay - 1);
          });
          await settleImports();
          expect(getTurnDelivery).toHaveBeenCalledTimes(calls);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
          });
          await settleImports();
          expect(getTurnDelivery).toHaveBeenCalledTimes(++calls);
        }
        view.unmount();
        await vi.advanceTimersByTimeAsync(120_000);
        await settleImports();
        expect(getTurnDelivery).toHaveBeenCalledTimes(calls);
        expect(sendMessage).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        vi.useRealTimers();
      }
    });

    it('cancels an armed lookup retry when the Station changes', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      await orphanedLiveRow();
      getTurnDelivery.mockRejectedValue(new Error('lookup unavailable'));
      const view = renderHook(({ apiBase }) => useOutboundQueueFlush(apiBase), {
        initialProps: { apiBase: 'http://api.test' },
      });
      try {
        await settleImports();
        expect(getTurnDelivery).toHaveBeenCalledTimes(1);
        view.rerender({ apiBase: 'http://other-station.test' });
        await settleImports();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(120_000);
        });
        await settleImports();
        expect(getTurnDelivery).toHaveBeenCalledTimes(1);
        expect(sendMessage).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        vi.useRealTimers();
      }
    });

    it.each(['unmount', 'authority change', 'pagehide'] as const)(
      'a failed lookup settling after %s cannot rearm its retry',
      async (change) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await orphanedLiveRow();
        let rejectLookup!: (error: Error) => void;
        getTurnDelivery.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              rejectLookup = reject;
            }),
        );
        const view = renderHook(
          ({ apiBase }) => useOutboundQueueFlush(apiBase),
          {
            initialProps: { apiBase: 'http://api.test' },
          },
        );
        try {
          await settleImports();
          expect(getTurnDelivery).toHaveBeenCalledTimes(1);
          if (change === 'unmount') view.unmount();
          else if (change === 'pagehide')
            window.dispatchEvent(new Event('pagehide'));
          else view.rerender({ apiBase: 'http://other-station.test' });
          rejectLookup(new Error('late lookup failure'));
          await settleImports();
          await act(async () => {
            await vi.advanceTimersByTimeAsync(120_000);
          });
          await settleImports();
          expect(getTurnDelivery).toHaveBeenCalledTimes(1);
          expect(sendMessage).not.toHaveBeenCalled();
        } finally {
          view.unmount();
          vi.useRealTimers();
        }
      },
    );

    it('Station never received it: sent again on launch with the same key, once', async () => {
      await orphanedLiveRow();
      getTurnDelivery.mockImplementation(
        async (_apiBase, conversationId, clientTurnId) => ({
          outcome: 'not-received',
          conversationId,
          clientTurnId,
        }),
      );
      sendMessage.mockResolvedValue({
        kind: 'accepted',
        providerTurnId: 'provider-turn-orphan',
      });
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      expect(getTurnDelivery).toHaveBeenCalledWith(
        'http://api.test',
        'session-1',
        'key-orphan',
        undefined,
      );
      expect(sendMessage.mock.calls[0]?.[6]).toBe('key-orphan');
      expect(sendMessage.mock.calls[0]?.[3]).toBe('sent as the app closed');
    });

    it('Station started it: delivered, nothing is sent', async () => {
      await orphanedLiveRow();
      getTurnDelivery.mockImplementation(
        async (_apiBase, conversationId, clientTurnId) => ({
          outcome: 'started',
          conversationId,
          clientTurnId,
          sessionId: 'session-1',
          turnId: 'provider-turn-orphan',
        }),
      );
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(async () =>
        expect(await outboundDispatch.snapshot()).toEqual([]),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});

describe('useOutboundQueueFlush: a message deferred because a turn is running', () => {
  const channels: Array<{
    name: string;
    listeners: Set<(event: { data: unknown }) => void>;
  }> = [];
  class FakeChannel {
    readonly listeners = new Set<(event: { data: unknown }) => void>();
    constructor(readonly name: string) {
      channels.push(this);
    }
    addEventListener(_t: string, l: (event: { data: unknown }) => void) {
      this.listeners.add(l);
    }
    removeEventListener(_t: string, l: (event: { data: unknown }) => void) {
      this.listeners.delete(l);
    }
    postMessage(data: unknown) {
      for (const channel of channels)
        if (channel !== this && channel.name === this.name)
          for (const listener of channel.listeners) listener({ data });
    }
    close() {}
  }
  let stored: unknown;
  const row = () =>
    ((stored as { turns?: Array<Record<string, unknown>> }).turns ?? [])[0];
  const settle = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    vi.clearAllMocks();
    channels.length = 0;
    _resetOutboundQueueChangeChannel();
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    stored = [
      {
        clientTurnId: 'busy',
        sessionId: 'session-1',
        conversationId: 'session-1',
        agentSlug: 'codex',
        content: 'after the running turn',
        createdAt: Date.now(),
        attempts: 0,
        status: 'pending',
      },
    ];
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    activeChatsStore.initChat('session-1', {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Queued chat',
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetOutboundQueueChangeChannel();
    activeChatsStore.removeChat('session-1');
    _resetOutboundQueueStorage();
  });

  it('a slow deferred send is not re-sent by its own release: at most 2 sends in 2s', async () => {
    sendMessage.mockImplementation(async () => {
      await settle(60);
      return { kind: 'deferred' };
    });
    renderHook(() => useOutboundQueueFlush('http://api.test'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    await settle(2_000);
    expect(sendMessage.mock.calls.length).toBeLessThanOrEqual(2);
    expect(row()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it("another window's claim and deferral of a message start no send here", async () => {
    // The other window holds the send from the start: this window never
    // deferred it, so only the trigger rule (not the deferral backstop)
    // keeps it from sending when that window releases the row.
    const setRow = (patch: Record<string, unknown>) => {
      const turns = Array.isArray(stored)
        ? (stored as Array<Record<string, unknown>>)
        : (stored as { turns: Array<Record<string, unknown>> }).turns;
      const next = [{ ...turns[0], ...patch }];
      stored = Array.isArray(stored)
        ? next
        : { ...(stored as object), turns: next };
    };
    setRow({
      status: 'invoking',
      attempts: 1,
      dispatchBootId: 'other-window',
      claimedAt: Date.now(),
    });
    sendMessage.mockResolvedValue({ kind: 'deferred' });
    renderHook(() => useOutboundQueueFlush('http://api.test'));
    await waitFor(() =>
      expect(
        activeChatsStore.getSnapshot()['session-1']?.outboundQueuedTurns,
      ).toHaveLength(1),
    );
    await settle(300);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      // That window's send was deferred (a turn runs there): released...
      setRow({
        status: 'pending',
        dispatchBootId: undefined,
        claimedAt: undefined,
      });
      new FakeChannel('station-outbound-queue').postMessage('changed');
      await settle(150);
      // ...and claimed again by it.
      setRow({
        status: 'invoking',
        dispatchBootId: 'other-window',
        claimedAt: Date.now(),
      });
      new FakeChannel('station-outbound-queue').postMessage('changed');
      await settle(150);
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a message deferred moments before the turn completes is sent once afterwards', async () => {
    sendMessage.mockResolvedValue({ kind: 'deferred' });
    renderHook(() => useOutboundQueueFlush('http://api.test'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    await settle(300);
    const before = sendMessage.mock.calls.length;
    sendMessage.mockResolvedValue({
      kind: 'accepted',
      providerTurnId: 'provider-after',
    });
    // The running turn completes (turn.completed -> reconcileDurableTurn),
    // inside the deferral's wait: that pass skips it, and the retry sends it.
    await outboundDispatch.completeAcceptedTurn('session-1', 'running-turn');
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(before + 1), {
      timeout: OUTBOUND_DEFER_RETRY_MS + 3_000,
    });
    await waitFor(() => expect(row()).toMatchObject({ status: 'accepted' }));
    await settle(OUTBOUND_DEFER_RETRY_MS);
    expect(sendMessage).toHaveBeenCalledTimes(before + 1);
  }, 15_000);

  it("a second deferred row is not stranded when the first one's retry finds its chat blocked", async () => {
    const now = Date.now();
    const row = (
      clientTurnId: string,
      sessionId: string,
      deferredAt: number,
    ) => ({
      clientTurnId,
      sessionId,
      conversationId: sessionId,
      agentSlug: 'codex',
      content: clientTurnId,
      createdAt: now - 1_000,
      attempts: 0,
      status: 'pending',
      deferredAt,
    });
    // X (chat 1) was deferred first, Y (chat 2) 150ms later.
    stored = [row('x', 'session-1', now - 150), row('y', 'session-2', now)];
    // X's chat now has a turn running, so X's retry finds it blocked.
    activeChatsStore.updateChat('session-1', {
      conversationId: 'session-1',
      conversationActivity: {
        conversationId: 'session-1',
        asOfSequence: 1,
        openTurn: {
          turnId: 'running-turn',
          threadId: 'thread-1',
          startedAt: '2026-10-15T00:00:00.000Z',
          trigger: 'user',
        },
      },
    } as never);
    // Y's chat is free (its turn ended inside Y's wait): the pass that
    // starts now skips Y, which is still waiting.
    activeChatsStore.initChat('session-2', {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Second chat',
    });
    sendMessage.mockResolvedValue({
      kind: 'accepted',
      providerTurnId: 'provider-y',
    });
    try {
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), {
        timeout: OUTBOUND_DEFER_RETRY_MS + 4_000,
      });
      expect(sendMessage.mock.calls[0]?.[6]).toBe('y');
      await settle(OUTBOUND_DEFER_RETRY_MS);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      activeChatsStore.removeChat('session-2');
    }
  }, 15_000);

  it('unmounting during a deferral wait stops every later queue read', async () => {
    sendMessage.mockResolvedValue({ kind: 'deferred' });
    const view = renderHook(() => useOutboundQueueFlush('http://api.test'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    // The deferral's retry is armed; leave before it fires.
    await settle(200);
    const reads = vi.spyOn(outboundDispatch, 'open');
    view.unmount();
    await settle(OUTBOUND_DEFER_RETRY_MS + 500);
    expect(reads).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    reads.mockRestore();
  }, 10_000);

  it('a chat with a turn running is not sent to, and its message goes as soon as the turn ends', async () => {
    sendMessage.mockResolvedValue({
      kind: 'accepted',
      providerTurnId: 'provider-after',
    });
    // The server's record: a turn is open in this conversation.
    activeChatsStore.updateChat('session-1', {
      conversationId: 'session-1',
      conversationActivity: {
        conversationId: 'session-1',
        asOfSequence: 1,
        openTurn: {
          turnId: 'running-turn',
          threadId: 'thread-1',
          startedAt: '2026-10-15T00:00:00.000Z',
          trigger: 'user',
        },
      },
    } as never);
    renderHook(() => useOutboundQueueFlush('http://api.test'));
    await waitFor(() =>
      expect(
        activeChatsStore.getSnapshot()['session-1']?.outboundQueuedTurns,
      ).toHaveLength(1),
    );
    await settle(500);
    expect(sendMessage).not.toHaveBeenCalled();
    // The turn ends: the record no longer has an open turn.
    activeChatsStore.updateChat('session-1', {
      conversationActivity: { conversationId: 'session-1', asOfSequence: 2 },
    } as never);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[6]).toBe('busy');
  });
});
