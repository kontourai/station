// @vitest-environment jsdom

import { AUTHORITY_OBSERVATION_SCHEMA_VERSION } from '@kontourai/station-contracts/authority-observation';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyConversationRecovery } from '../components/conversation/LegacyConversationRecovery';
import {
  conversationCapabilitiesFromAuthority,
  type StationConnection,
} from '../connections/station-connection';
import {
  chatBelongsToStation,
  outboundStationIdentity,
} from '../connections/station-state';
import {
  ActiveChatsStore,
  activeChatsStore,
} from '../contexts/active-chats-store';
import { lookupTurnDelivery } from '../lib/deliveryLookup';
import { dispatchForeground } from '../lib/foregroundMessageDispatch';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  type OutboundDispatchTransport,
  outboundDispatch,
} from '../lib/outboundQueue';

const recovery = vi.hoisted(() => ({ enabled: true, resolve: vi.fn() }));
vi.mock('../connections/StationConnectionsContext', () => ({
  useStationConnectionsOptional: () => ({
    remoteEnabled: recovery.enabled,
    resolve: recovery.resolve,
  }),
}));

const connection: StationConnection = {
  environmentId: 'receiver',
  stationName: 'Receiver',
  stationKey: 'receiver',
  runtimeKey: 'relay:receiver',
  routeKind: 'relay',
  targetApiBase: 'https://source.test/api/environments/peers/receiver/chat-api',
  authorityNamespace: 'source-owner:delegation',
  requestScope: {
    apiBase: 'https://source.test',
    authorityKey: 'source-owner',
  },
  binding: {
    version: 1,
    environmentId: 'receiver',
    stationName: 'Receiver',
    affinity: {
      kind: 'peer',
      sourceEnvironmentId: 'source',
      sourceConnectionId: 'source-profile',
      principalNamespace: 'delegation',
    },
  },
  capabilities: conversationCapabilitiesFromAuthority(
    {
      schemaVersion: AUTHORITY_OBSERVATION_SCHEMA_VERSION,
      environmentId: 'receiver',
      principal: { kind: 'human', id: 'human:owner' },
      grant: {
        kind: 'device',
        deviceId: 'device',
        grantedScopes: ['orchestration:read', 'orchestration:operate'],
      },
    },
    { remote: true, mutationAllowed: true },
  ),
  isCurrent: () => true,
};
const station = outboundStationIdentity(connection);
const legacy = (dispatched?: boolean) => ({
  environmentId: 'receiver',
  stationName: 'Receiver',
  conversationId: 'conversation',
  sessionId: 'execution',
  agentId: 'agent',
  executionAgentId: 'override',
  expectedDefinitionFingerprint: 'fingerprint',
  projectSlug: 'project',
  projectName: 'Project',
  model: 'target-model',
  providerOptions: { effort: 'high' },
  pending: {
    id: 'original-key',
    text: 'original message',
    ...(dispatched === undefined ? {} : { dispatched }),
  },
});
function chatStorage(peerChat: unknown) {
  let value = JSON.stringify([
    {
      sessionId: 'tab',
      agentSlug: 'agent',
      title: 'My title',
      createdAt: 123,
      input: 'unsent draft',
      requestedModel: 'requested-model',
      requestedProviderOptions: { temperature: 0.5 },
      queuedMessages: [],
      peerChat,
    },
  ]);
  let fail = false;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      if (fail) throw new Error('storage refused');
      value = next;
    },
    fail: (next: boolean) => {
      fail = next;
    },
    read: (): unknown => JSON.parse(value),
  };
}
let queue: unknown;
let failImport = false;
beforeEach(() => {
  recovery.enabled = true;
  recovery.resolve.mockReset();
  queue = undefined;
  failImport = false;
  _setOutboundQueueStorage({
    getItem: async () => queue,
    setItem: async (_key, next) => {
      queue = next;
    },
    updateItem: async (_key, update) => {
      if (failImport) throw new Error('queue refused');
      queue = update(queue);
    },
  });
});
afterEach(() => {
  cleanup();
  activeChatsStore.removeChat('tab');
  _resetOutboundQueueStorage();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

describe('legacy peer chat durable migration', () => {
  it.each([true, undefined])(
    'holds unattributed dispatched=%s text until confirmed recovery, then looks up before any POST',
    async (dispatched) => {
      const pending = legacy(dispatched);
      activeChatsStore.initChat('tab', {
        agentSlug: 'agent',
        agentName: 'Agent',
        title: 'Legacy',
      });
      const restored = new ActiveChatsStore({
        storage: chatStorage(pending),
      }).getSnapshot().tab;
      activeChatsStore.updateChat('tab', {
        ...restored,
        input: 'retained draft',
        messages: [
          { id: 'old-text', role: 'assistant', content: 'retained transcript' },
        ],
      });
      recovery.resolve.mockResolvedValue({ connection, release: vi.fn() });
      const order: string[] = [];
      setClientCredentialResolver(async () => ({
        origin: connection.requestScope.apiBase,
        credential: 'source-device',
        requestAuthority: {
          ...connection.requestScope,
          isCurrent: connection.isCurrent,
        },
      }));
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (input, init) => {
          const url = String(input);
          expect(url.startsWith(connection.targetApiBase)).toBe(true);
          expect(new Headers(init?.headers).get('Authorization')).toBe(
            'Bearer source-device',
          );
          if (init?.method === 'POST') {
            order.push('post');
            expect(JSON.parse(String(init.body))).toMatchObject({
              clientTurnId: 'original-key',
              conversationId: 'conversation',
              message: 'original message',
            });
            return Response.json({
              success: true,
              data: {
                conversationId: 'conversation',
                sessionId: 'execution',
                providerTurnId: 'recovered-turn',
                target: { kind: 'agent', id: 'agent' },
                resolution: {},
              },
            });
          }
          expect(url).toContain('/turn-deliveries/original-key');
          order.push('lookup');
          return Response.json({
            success: true,
            data: {
              outcome: 'not-received',
              conversationId: 'conversation',
              clientTurnId: 'original-key',
            },
          });
        }),
      );
      render(
        createElement(LegacyConversationRecovery, {
          chat: {
            id: 'tab',
            input: 'retained draft',
            messages: [],
            peerChat: activeChatsStore.getSnapshot().tab.peerChat,
          },
          onNewChat: vi.fn(),
        }),
      );
      expect(screen.getByText('retained transcript')).toBeTruthy();
      expect(screen.getByLabelText('Pending message').textContent).toBe(
        'original message',
      );
      expect(screen.getByLabelText('Draft').textContent).toBe('retained draft');
      expect(recovery.resolve).not.toHaveBeenCalled();
      expect(await outboundDispatch.snapshot()).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect chat' }));
      let dialog = screen.getByRole('dialog', { name: 'Reconnect this chat?' });
      expect(recovery.resolve).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() =>
        expect(
          screen.queryByRole('dialog', { name: 'Reconnect this chat?' }),
        ).toBeNull(),
      );
      expect(recovery.resolve).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect chat' }));
      dialog = screen.getByRole('dialog', { name: 'Reconnect this chat?' });
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Reconnect' }),
      );
      await waitFor(() =>
        expect(activeChatsStore.getSnapshot().tab.stationBinding).toEqual(
          connection.binding,
        ),
      );
      expect(recovery.resolve).toHaveBeenCalledExactlyOnceWith({
        environmentId: 'receiver',
        legacyPeer: true,
      });
      const send: OutboundDispatchTransport = async (row) => {
        const receipt = await dispatchForeground({
          apiBase: connection.targetApiBase,
          requestScope: connection.requestScope,
          sessionId: row.sessionId,
          agentSlug: row.agentSlug,
          conversationId: row.conversationId,
          clientTurnId: row.clientTurnId,
          message: row.content,
        });
        return { kind: 'accepted', providerTurnId: receipt.providerTurnId };
      };
      await outboundDispatch.flush(send, { station });
      expect(order).toEqual([]);
      await outboundDispatch.reconcile(
        lookupTurnDelivery(connection.targetApiBase, connection.requestScope),
        { station },
      );
      expect(order).toEqual(['lookup']);
      await outboundDispatch.flush(send, { station });
      expect(order).toEqual(['lookup', 'post']);
      expect(activeChatsStore.getSnapshot().tab.peerChatTranscript).toEqual([
        { id: 'old-text', role: 'assistant', content: 'retained transcript' },
      ]);
    },
  );

  it('keeps legacy text visible with the preview off and refuses unconfirmed migration', async () => {
    recovery.enabled = false;
    activeChatsStore.initChat('tab', {
      agentSlug: 'agent',
      agentName: 'Agent',
      title: 'Legacy',
    });
    activeChatsStore.updateChat('tab', {
      peerChat: {
        ...legacy(false),
        pending: {
          id: 'original-key',
          text: 'original message',
          dispatched: false,
        },
      },
      input: 'retained draft',
      messages: [{ role: 'assistant', content: 'retained transcript' }],
    });
    render(
      createElement(LegacyConversationRecovery, {
        chat: {
          id: 'tab',
          input: '',
          messages: [],
          peerChat: activeChatsStore.getSnapshot().tab.peerChat,
        },
        onNewChat: vi.fn(),
      }),
    );
    expect(screen.getByText('retained transcript')).toBeTruthy();
    expect(screen.getByLabelText('Pending message').textContent).toBe(
      'original message',
    );
    expect(
      screen.getByRole('button', { name: 'Reconnect chat' }),
    ).toHaveProperty('disabled', true);
    await expect(
      activeChatsStore.migratePeerChat('tab', connection, {
        confirmedRecovery: false,
      }),
    ).rejects.toThrow('Confirm');
    expect(recovery.resolve).not.toHaveBeenCalled();
    expect(await outboundDispatch.snapshot()).toEqual([]);
  });
  it.each([false, true, undefined])(
    'issues one scoped POST after dispatched=%s is durably migrated and reconciled',
    async (dispatched) => {
      const posts: Array<{ url: string; body: unknown }> = [];
      const lookups: string[] = [];
      setClientCredentialResolver(async () => ({
        origin: connection.requestScope.apiBase,
        credential: 'source-device',
        requestAuthority: {
          ...connection.requestScope,
          isCurrent: connection.isCurrent,
        },
      }));
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (input, init) => {
          const url = String(input);
          expect(
            url.startsWith(`${connection.targetApiBase}/api/orchestration/`),
          ).toBe(true);
          expect(new Headers(init?.headers).get('Authorization')).toBe(
            'Bearer source-device',
          );
          if (init?.method === 'POST') {
            posts.push({ url, body: JSON.parse(String(init.body)) });
            return Response.json({
              success: true,
              data: {
                conversationId: 'conversation',
                sessionId: 'execution',
                providerTurnId: 'provider-turn',
                target: { kind: 'agent', id: 'agent' },
                resolution: {},
              },
            });
          }
          expect(url).toContain(
            '/conversations/conversation/turn-deliveries/original-key',
          );
          lookups.push(url);
          return Response.json({
            success: true,
            data: {
              outcome: 'not-received',
              conversationId: 'conversation',
              clientTurnId: 'original-key',
            },
          });
        }),
      );
      const store = new ActiveChatsStore({
        storage: chatStorage(legacy(dispatched)),
      });
      await store.migratePeerChat('tab', connection, {
        confirmedRecovery: true,
      });
      const send: OutboundDispatchTransport = async (row) => {
        const receipt = await dispatchForeground({
          apiBase: connection.targetApiBase,
          requestScope: connection.requestScope,
          sessionId: row.sessionId,
          conversationId: row.conversationId,
          clientTurnId: row.clientTurnId,
          agentSlug: row.agentSlug,
          executionAgentId: row.executionAgentId,
          executionOnCurrentStation: true,
          expectedDefinitionFingerprint: row.expectedDefinitionFingerprint,
          projectSlug: row.projectSlug,
          message: row.content,
          model: row.model,
          providerOptions: row.providerOptions,
        });
        return { kind: 'accepted', providerTurnId: receipt.providerTurnId };
      };
      await outboundDispatch.flush(send, { station });
      expect(posts).toHaveLength(0);
      if (dispatched === false)
        await outboundDispatch.sendHeld(
          'original-key',
          station,
          'conversation',
        );
      else
        await outboundDispatch.reconcile(
          lookupTurnDelivery(connection.targetApiBase, connection.requestScope),
          { station },
        );
      await Promise.all([
        outboundDispatch.flush(send, { station }),
        outboundDispatch.flush(send, { station }),
      ]);
      expect(posts).toEqual([
        {
          url: `${connection.targetApiBase}/api/orchestration/chat`,
          body: expect.objectContaining({
            clientTurnId: 'original-key',
            conversationId: 'conversation',
            message: 'original message',
            target: expect.objectContaining({
              environment: { kind: 'current' },
              workspace: { kind: 'project', projectSlug: 'project' },
            }),
          }),
        },
      ]);
      expect(lookups).toHaveLength(dispatched === false ? 0 : 1);
    },
  );
  it.each([false, true, undefined])(
    'imports dispatched=%s before saving the canonical chat, retaining identity and options on reload',
    async (dispatched) => {
      const storage = chatStorage(legacy(dispatched));
      const store = new ActiveChatsStore({ storage });
      await store.migratePeerChat('tab', connection, {
        confirmedRecovery: true,
      });
      expect(queue).toMatchObject({
        version: 2,
        turns: [
          {
            station,
            clientTurnId: 'original-key',
            sessionId: 'tab',
            conversationId: 'conversation',
            content: 'original message',
            agentSlug: 'agent',
            executionAgentId: 'override',
            expectedDefinitionFingerprint: 'fingerprint',
            projectSlug: 'project',
            model: 'target-model',
            providerOptions: { effort: 'high' },
            requestedModel: 'requested-model',
            requestedProviderOptions: { temperature: 0.5 },
            status: dispatched === false ? 'pending' : 'invoking',
          },
        ],
      });
      expect(storage.read()).toMatchObject([
        {
          sessionId: 'tab',
          title: 'My title',
          createdAt: 123,
          input: 'unsent draft',
          stationBinding: connection.binding,
          conversationId: 'conversation',
          currentSessionId: 'execution',
          projectName: 'Project',
          peerChat: {
            pending: {
              id: 'original-key',
              text: 'original message',
              dispatched: true,
            },
          },
        },
      ]);
      const reloaded = new ActiveChatsStore({ storage });
      expect(reloaded.getSnapshot().tab).toMatchObject({
        stationBinding: connection.binding,
        input: 'unsent draft',
      });
      expect(reloaded.getSnapshot().tab.peerChat).toBeUndefined();
      await reloaded.migratePeerChat('tab', connection, {
        confirmedRecovery: true,
      });
      expect(await outboundDispatch.snapshot()).toHaveLength(1);
      const post = vi.fn<OutboundDispatchTransport>(async () => ({
        kind: 'queued',
      }));
      await outboundDispatch.flush(post, {
        station: {
          apiBase: 'https://source.test',
          environmentId: 'source',
          authorityNamespace: 'source-owner',
          host: true,
        },
      });
      await outboundDispatch.flush(post, { station });
      expect(post).not.toHaveBeenCalled();
      if (dispatched === false) {
        await outboundDispatch.sendHeld('original-key', station);
      } else {
        await outboundDispatch.reconcile(
          async (row) => ({
            outcome: 'not-received',
            conversationId: 'conversation',
            clientTurnId: row.clientTurnId,
          }),
          { station },
        );
      }
      await outboundDispatch.flush(post, { station });
      expect(post).toHaveBeenCalledOnce();
      expect(post.mock.calls[0]?.[0]).toMatchObject({
        station,
        clientTurnId: 'original-key',
        conversationId: 'conversation',
      });
    },
  );

  it('retries a crash after durable import, and two legacy tabs converge on one send', async () => {
    const firstStorage = chatStorage(legacy(true));
    const secondStorage = chatStorage(legacy(true));
    const first = new ActiveChatsStore({ storage: firstStorage });
    firstStorage.fail(true);
    await expect(
      first.migratePeerChat('tab', connection, { confirmedRecovery: true }),
    ).rejects.toThrow('could not be saved');
    expect(first.getSnapshot().tab.peerChat).toBeDefined();
    expect(first.getSnapshot().tab.stationBinding).toBeUndefined();
    expect(await outboundDispatch.snapshot()).toHaveLength(1);
    await outboundDispatch.syncHeld([], { station });
    const prematureLookup = vi.fn(async () => ({
      outcome: 'not-received' as const,
      conversationId: 'conversation',
      clientTurnId: 'original-key',
    }));
    await outboundDispatch.reconcile(prematureLookup, { station });
    expect(prematureLookup).not.toHaveBeenCalled();
    const prematurePost = vi.fn<OutboundDispatchTransport>(async () => ({
      kind: 'queued',
    }));
    await outboundDispatch.flush(prematurePost, { station });
    expect(prematurePost).not.toHaveBeenCalled();
    expect((await outboundDispatch.snapshot())[0]?.legacyImport).toBe(true);
    firstStorage.fail(false);
    const afterCrash = new ActiveChatsStore({ storage: firstStorage });
    const secondTab = new ActiveChatsStore({ storage: secondStorage });
    await Promise.all([
      afterCrash.migratePeerChat('tab', connection, {
        confirmedRecovery: true,
      }),
      secondTab.migratePeerChat('tab', connection, { confirmedRecovery: true }),
    ]);
    expect(await outboundDispatch.snapshot()).toHaveLength(1);
    await outboundDispatch.reconcile(
      async (row) => ({
        outcome: 'not-received',
        conversationId: 'conversation',
        clientTurnId: row.clientTurnId,
      }),
      { station },
    );
    const post = vi.fn<OutboundDispatchTransport>(async () => ({
      kind: 'queued',
    }));
    await Promise.all([
      outboundDispatch.flush(post, { station }),
      outboundDispatch.flush(post, { station }),
    ]);
    expect(post).toHaveBeenCalledOnce();
    expect(firstStorage.read()).toMatchObject([
      { stationBinding: connection.binding },
    ]);
    expect(secondStorage.read()).toMatchObject([
      { stationBinding: connection.binding },
    ]);
  });

  it('does not record migration if the durable import fails', async () => {
    const storage = chatStorage(legacy(false));
    const before = storage.read();
    const store = new ActiveChatsStore({ storage });
    failImport = true;
    await expect(
      store.migratePeerChat('tab', connection, { confirmedRecovery: true }),
    ).rejects.toThrow('queue refused');
    expect(storage.read()).toEqual(before);
    expect(store.getSnapshot().tab.stationBinding).toBeUndefined();
    expect(store.getSnapshot().tab.peerChat?.pending?.id).toBe('original-key');
  });

  it('keeps an undispatched import durable while the canonical chat write is refused', async () => {
    const storage = chatStorage(legacy(false));
    const store = new ActiveChatsStore({ storage });
    storage.fail(true);
    await expect(
      store.migratePeerChat('tab', connection, { confirmedRecovery: true }),
    ).rejects.toThrow('could not be saved');
    await outboundDispatch.syncHeld([], { station });
    const post = vi.fn<OutboundDispatchTransport>(async () => ({
      kind: 'queued',
    }));
    await outboundDispatch.flush(post, { station });
    expect(post).not.toHaveBeenCalled();
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        legacyImport: true,
        clientTurnId: 'original-key',
        status: 'pending',
        heldBy: expect.any(Object),
      }),
    ]);
    storage.fail(false);
    await store.migratePeerChat('tab', connection, { confirmedRecovery: true });
    expect(
      (await outboundDispatch.snapshot())[0]?.legacyImport,
    ).toBeUndefined();
    expect(store.getSnapshot().tab.queuedMessages).toEqual([
      'original message',
    ]);
  });

  it('commits a restored canonical chat before recovering an inactive imported row', async () => {
    await outboundDispatch.importLegacy(
      {
        station,
        sessionId: 'tab',
        conversationId: 'conversation',
        clientTurnId: 'original-key',
        agentSlug: 'agent',
        content: 'original message',
      },
      true,
    );
    let saved: unknown;
    const restored = new ActiveChatsStore({
      storage: {
        getItem: () => null,
        setItem: (_key, value) => {
          if (saved === undefined)
            expect(queue).toMatchObject({ turns: [{ legacyImport: true }] });
          saved = JSON.parse(value);
        },
      },
    });
    restored.initChat('tab', {
      agentSlug: 'agent',
      agentName: 'Agent',
      title: 'Restored',
      conversationId: 'conversation',
      stationBinding: connection.binding,
    });
    await restored.recoverLegacyImports(connection);
    expect(saved).toMatchObject([
      {
        sessionId: 'tab',
        conversationId: 'conversation',
        stationBinding: connection.binding,
      },
    ]);
    expect(
      (await outboundDispatch.snapshot())[0]?.legacyImport,
    ).toBeUndefined();
    restored.flushPendingSave();
  });

  it('retains an unknown future Station binding and its invalid marker across writes and reloads', () => {
    const future = { ...connection.binding, version: 99 };
    const storage = chatStorage(undefined);
    storage.setItem(
      'activeChats',
      JSON.stringify([
        {
          sessionId: 'tab',
          agentSlug: 'agent',
          input: 'keep this draft',
          stationBinding: future,
        },
      ]),
    );
    const store = new ActiveChatsStore({ storage });
    expect(chatBelongsToStation(store.getSnapshot().tab)).toBe(false);
    store.updateChat('tab', { title: 'Retained future chat' });
    expect(store.flushPendingSave()).toBe(true);
    expect(storage.read()).toMatchObject([
      {
        stationBinding: future,
        stationBindingInvalid: true,
        input: 'keep this draft',
      },
    ]);
    const reloaded = new ActiveChatsStore({ storage });
    expect(reloaded.getSnapshot().tab.stationBindingInvalid).toBe(true);
    expect(chatBelongsToStation(reloaded.getSnapshot().tab)).toBe(false);
  });

  it('never downgrades newer accepted evidence when an older unsent envelope returns', async () => {
    const newer = await outboundDispatch.beginLive({
      station,
      clientTurnId: 'original-key',
      sessionId: 'tab',
      conversationId: 'conversation',
      agentSlug: 'agent',
      content: 'original message',
    });
    await newer.accepted();
    const store = new ActiveChatsStore({ storage: chatStorage(legacy(false)) });
    await store.migratePeerChat('tab', connection, { confirmedRecovery: true });
    expect(store.getSnapshot().tab.queuedMessages).toEqual([]);
    await outboundDispatch.syncHeld(
      [
        {
          station,
          clientTurnId: 'original-key',
          sessionId: 'tab',
          conversationId: 'conversation',
          agentSlug: 'agent',
          content: 'original message',
        },
      ],
      { station },
    );
    expect(await outboundDispatch.snapshot()).toEqual([]);
    expect(await outboundDispatch.retiredKeys(station)).toEqual({
      accepted: ['original-key'],
      discarded: [],
    });
  });

  it.each([
    { version: 2, ...legacy(false) },
    { environmentId: 'receiver', pending: { text: 'keep me' } },
  ])(
    'retains invalid or future legacy envelopes and their unavailable marker',
    async (envelope) => {
      const storage = chatStorage(envelope);
      const store = new ActiveChatsStore({ storage });
      expect(store.getSnapshot().tab.peerChatInvalid).toBe(true);
      expect(chatBelongsToStation(store.getSnapshot().tab)).toBe(false);
      store.updateChat('tab', { title: 'Edited title' });
      expect(store.flushPendingSave()).toBe(true);
      expect(storage.read()).toMatchObject([
        { peerChat: envelope, peerChatInvalid: true },
      ]);
      const reloaded = new ActiveChatsStore({ storage });
      expect(reloaded.getSnapshot().tab.peerChatLegacy).toEqual(envelope);
      await expect(
        reloaded.migratePeerChat('tab', connection, {
          confirmedRecovery: true,
        }),
      ).resolves.toBeUndefined();
      expect(queue).toBeUndefined();
    },
  );
});
