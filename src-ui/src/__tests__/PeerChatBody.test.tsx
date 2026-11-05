import { readPeerChatBinding } from '../lib/peer-chat';
// @vitest-environment jsdom

import { webcrypto } from 'node:crypto';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { LoadFullContent } from '../components/chat/LoadFullContent';
import { PeerChatBody } from '../components/chat-dock/PeerChatBody';
import { serializeActiveChats } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  type NewChatIntent,
  OPEN_NEW_CHAT_EVENT,
  readNewChatIntent,
} from '../lib/newChatIntent';
import type { PeerChatBinding } from '../lib/peer-chat';

const authority = {
  apiBase: 'http://source.test',
  authorityKey: 'source-authority',
  isCurrent: () => true,
};
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => authority,
  useApiBase: () => ({ apiBase: authority.apiBase }),
}));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set(['paired-station-chats']),
}));
vi.mock('../contexts/ActiveChatsContext', async () => {
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  const actions = {
    updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
  };
  return { activeChatsStore, useActiveChatActions: () => actions };
});
// SessionTranscript.test.tsx owns window rendering; keep its content controls real here.
vi.mock('../components/session-detail/SessionTranscript', () => ({
  SessionTranscript: () => (
    <LoadFullContent threadId="remote-session" value={spilled}>
      {(full) => (
        <p>{typeof full === 'string' ? full : 'Remote output preview'}</p>
      )}
    </LoadFullContent>
  ),
}));

const fullOutput = 'Full output from desktop-win';
const spilled = {
  $stationContent: 1 as const,
  ref: `sha256-${'f'.repeat(64)}`,
  kind: 'string' as const,
  bytes: fullOutput.length,
  length: fullOutput.length,
  preview: 'Remote output preview',
};
const editDraft = vi.fn<(intent: NewChatIntent) => void>();
let client: QueryClient;
function Harness() {
  const chats = useSyncExternalStore(
    activeChatsStore.subscribe,
    activeChatsStore.getSnapshot,
  );
  const state = chats['peer-tab'];
  return (
    <PeerChatBody
      chat={{ id: 'peer-tab', input: state?.input ?? '', agentName: 'Codex' }}
      binding={state!.peerChat!}
      onEditDraft={editDraft}
    />
  );
}
function start() {
  const binding: PeerChatBinding = {
    environmentId: 'desktop-win',
    stationName: 'desktop-win',
    conversationId: 'remote-conversation',
    agentId: 'codex',
    projectSlug: 'windows-repo',
    model: 'remote-model',
    pending: { id: 'first-key', text: 'Which machine?', dispatched: false },
  };
  activeChatsStore.initChat('peer-tab', {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Remote chat',
    projectSlug: 'source-project',
  });
  activeChatsStore.updateChat('peer-tab', { peerChat: binding });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  setClientCredentialResolver(async () => ({
    origin: authority.apiBase,
    credential: 'source-token',
    requestAuthority: authority,
  }));
  return () =>
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
}
function wire() {
  const state = {
    uncertain: false,
    stopUncertain: false,
    accepted: false,
    busy: false,
    events: [] as CanonicalRuntimeEvent[],
  };
  const messages: Array<{
    clientTurnId: string;
    message: string;
    target: { workspace: { projectSlug: string } };
  }> = [];
  const commands: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    expect(
      path.startsWith('/api/environments/peers/desktop-win/chat-api/'),
    ).toBe(true);
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer source-token',
    );
    if (path.endsWith(`/content/${spilled.ref}`))
      return new Response(fullOutput, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Station-Content-Kind': 'string',
          'X-Station-Content-Bytes': String(fullOutput.length),
          'X-Station-Content-Complete': 'true',
        },
      });
    if (path.endsWith('/api/orchestration/chat')) {
      const body = JSON.parse(String(init?.body));
      messages.push(body);
      if (state.uncertain) throw new Error('connection lost after send');
      state.accepted = true;
      return Response.json({
        success: true,
        data: {
          conversationId: 'remote-conversation',
          sessionId: 'remote-session',
          providerTurnId: `provider-${messages.length}`,
        },
      });
    }
    if (path.endsWith('/api/orchestration/commands')) {
      commands.push(JSON.parse(String(init?.body)));
      if (state.stopUncertain) throw new Error('Stop response lost');
      state.busy = false;
      return Response.json({ success: true, data: {} });
    }
    if (path.endsWith('/event-window')) {
      if (!state.accepted)
        return Response.json(
          { success: false, error: 'Conversation not found' },
          { status: 404 },
        );
      return Response.json({
        success: true,
        data: {
          protocolVersion: 1,
          conversationId: 'remote-conversation',
          currentSessionId: 'remote-session',
          session: {
            threadId: 'remote-session',
            provider: 'codex',
            hasActiveTurn: state.busy,
            lifecycleState: state.busy ? 'running' : 'idle',
          },
          events: state.events.map((event, index) => ({
            event,
            sequence: index + 1,
          })),
          watermark: messages.length,
          hasMore: false,
          handoffs: [],
          contextBoundaries: [],
        },
      });
    }
    throw new Error(`Unexpected peer request: ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return { state, messages, commands };
}
afterEach(() => {
  cleanup();
  client?.clear();
  editDraft.mockReset();
  activeChatsStore.removeChat('peer-tab');
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('sends, continues and stops the receiver’s foreground conversation through the captured source authority', async () => {
  const { state, messages, commands } = wire();
  const mount = start();
  mount();
  await waitFor(() =>
    expect(
      activeChatsStore.getSnapshot()['peer-tab']?.peerChat?.pending,
    ).toBeUndefined(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]?.target.workspace.projectSlug).toBe('windows-repo');
  const input = screen.getByRole('textbox', { name: 'Send input to session' });
  fireEvent.change(input, { target: { value: 'Next question' } });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(messages).toHaveLength(2));
  expect(messages[1]?.message).toBe('Next question');
  expect(messages[1]?.clientTurnId).not.toBe(messages[0]?.clientTurnId);
  state.busy = true;
  await act(() =>
    client.invalidateQueries({ queryKey: ['peer-chat-history'] }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
  await waitFor(() =>
    expect(commands).toEqual([
      { type: 'interruptTurn', threadId: 'remote-session' },
    ]),
  );
});

test('an uncertain send survives remount without replay; explicit retry keeps its delivery key', async () => {
  const { state, messages } = wire();
  state.uncertain = true;
  const mount = start();
  const first = mount();
  await screen.findByRole('button', { name: 'Retry this message' });
  const [persisted] = serializeActiveChats({
    'peer-tab': activeChatsStore.getSnapshot()['peer-tab']!,
  });
  expect(readPeerChatBinding(persisted?.peerChat)?.pending).toEqual({
    id: 'first-key',
    text: 'Which machine?',
    dispatched: true,
  });
  first.unmount();
  mount();
  await screen.findByRole('button', { name: 'Retry this message' });
  expect(messages).toHaveLength(1);
  state.uncertain = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry this message' }));
  await waitFor(() =>
    expect(
      activeChatsStore.getSnapshot()['peer-tab']?.peerChat?.pending,
    ).toBeUndefined(),
  );
  expect(messages.map((message) => message.clientTurnId)).toEqual([
    'first-key',
    'first-key',
  ]);
});

test('loads expanded receiver output with the same captured authority', async () => {
  wire();
  vi.stubGlobal('crypto', webcrypto);
  start()();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Load full content' }),
  );
  expect(await screen.findByText(fullOutput)).toBeTruthy();
});

test('answers receiver tool approvals and forms through the shared controls', async () => {
  const { state, commands } = wire();
  state.events = [
    {
      method: 'request.opened',
      provider: 'codex',
      threadId: 'remote-session',
      eventId: 'remote-approval-event',
      requestId: 'remote-approval',
      createdAt: '2026-11-02T00:00:00Z',
      requestType: 'approval',
      title: 'Run command',
      payload: { command: 'git status', toolName: 'Bash' },
    },
    {
      method: 'request.opened',
      provider: 'codex',
      threadId: 'remote-session',
      eventId: 'remote-form-event',
      requestId: 'remote-form',
      createdAt: '2026-11-02T00:00:01Z',
      requestType: 'approval',
      title: 'Choose a branch',
      payload: {
        inputRequest: {
          schema: 'station.input-request/v1',
          source: 'mcp:fixture',
          requester: 'Git',
          message: 'Choose a branch',
          body: {
            kind: 'form',
            fields: [
              {
                name: 'branch',
                title: 'Branch',
                kind: 'string',
                required: true,
              },
            ],
          },
        },
      },
    },
  ];
  start()();
  fireEvent.click(await screen.findByRole('button', { name: 'Allow Once' }));
  await waitFor(() =>
    expect(commands).toContainEqual({
      type: 'respondToRequest',
      threadId: 'remote-session',
      requestId: 'remote-approval',
      expectedRequestEventId: 'remote-approval-event',
      decision: 'accept',
    }),
  );
  fireEvent.change(await screen.findByRole('textbox', { name: /Branch/ }), {
    target: { value: 'feature/windows' },
  });
  const strip = screen.getByRole('region', {
    name: 'Approvals waiting on you',
  });
  fireEvent.click(within(strip).getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(commands).toContainEqual({
      type: 'respondToRequest',
      threadId: 'remote-session',
      requestId: 'remote-form',
      expectedRequestEventId: 'remote-form-event',
      decision: 'accept',
      content: { branch: 'feature/windows' },
    }),
  );
});

test.each([true, false])(
  'a rejected message opens an editable draft with its remote selection (explicit model: %s)',
  async (explicitModel) => {
    const { state } = wire();
    state.uncertain = true;
    const mount = start();
    if (!explicitModel) {
      const binding = activeChatsStore.getSnapshot()['peer-tab']!.peerChat!;
      activeChatsStore.updateChat('peer-tab', {
        peerChat: { ...binding, model: undefined },
      });
    }
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit in New Chat' }),
    );
    const intent = readNewChatIntent(
      new CustomEvent(OPEN_NEW_CHAT_EVENT, {
        detail: editDraft.mock.calls[0]![0],
      }),
    );
    expect(intent.selectionInvalid).not.toBe(true);
    expect(intent).toMatchObject({
      initialPrompt: 'Which machine?',
      selection: {
        context: '__global__',
        agentSlug: 'codex',
        model: { environmentId: 'desktop-win' },
      },
    });
    expect(intent.selection?.model?.modelId).toBe(
      explicitModel ? 'remote-model' : undefined,
    );
    expect(intent.startWithDefault).not.toBe(true);
    expect(
      activeChatsStore.getSnapshot()['peer-tab']?.peerChat?.pending?.id,
    ).toBe('first-key');
    expect(
      screen.getByText(
        /Check the conversation before sending a changed message/,
      ),
    ).toBeTruthy();
  },
);

test('a failed Stop clears its warning once history confirms the turn finished', async () => {
  const { state, commands } = wire();
  state.busy = true;
  start()();
  const stop = await screen.findByRole('button', { name: 'Stop' });
  state.stopUncertain = true;
  fireEvent.click(stop);
  await screen.findByText('Couldn’t confirm the Station’s response');
  expect(commands).toHaveLength(1);
  state.busy = false;
  await act(() =>
    client.invalidateQueries({ queryKey: ['peer-chat-history'] }),
  );
  await waitFor(() =>
    expect(
      screen.queryByText('Couldn’t confirm the Station’s response'),
    ).toBeNull(),
  );
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});
