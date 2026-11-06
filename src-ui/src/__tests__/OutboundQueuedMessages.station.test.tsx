// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { OutboundQueuedMessages } from '../components/chat/OutboundQueuedMessages';
import { UnsentMessages } from '../components/chat/UnsentMessages';
import { conversationConnection } from '../components/conversation/__tests__/fixtures';
import { ConversationConnectionProvider } from '../components/conversation/ConversationConnectionContext';
import { outboundStationIdentity } from '../connections/station-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  noteCurrentStation,
  outboundDispatch,
} from '../lib/outboundQueue';

const host = outboundStationIdentity(conversationConnection('host'));
const peer = conversationConnection('relay');
const owner = outboundStationIdentity(peer);
const sessionId = 'peer-tab';
const conversationId = 'peer-conversation';
const errors = vi.fn();
const read = async () =>
  (await outboundDispatch.snapshot()).filter(
    (row) =>
      row.station?.environmentId === owner.environmentId &&
      row.conversationId === conversationId,
  );

beforeEach(async () => {
  const values = new Map<string, unknown>();
  _setOutboundQueueStorage({
    getItem: async (key) => values.get(key),
    setItem: async (key, value) => {
      values.set(key, value);
    },
    updateItem: async (key, update) => {
      values.set(key, update(values.get(key)));
    },
  });
  noteCurrentStation(host);
  errors.mockReset();
  activeChatsStore.initChat(sessionId, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Peer chat',
    conversationId,
    stationBinding: peer.binding,
  });
  for (const [station, conversation, id] of [
    [host, 'host-conversation', 'one'],
    [owner, 'other-peer-conversation', 'one'],
    [owner, conversationId, 'one'],
    [owner, conversationId, 'two'],
  ] as const) {
    await outboundDispatch.enqueue({
      clientTurnId: id,
      sessionId,
      conversationId: conversation,
      station,
      agentSlug: 'codex',
      content: `${conversation}-${id}`,
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  activeChatsStore.removeChat(sessionId);
  noteCurrentStation(undefined);
  _resetOutboundQueueStorage();
});

function bound(children: React.ReactNode) {
  return (
    <ConversationConnectionProvider
      value={{
        apiBase: peer.targetApiBase,
        station: peer,
        requestScope: { ...peer.requestScope, isCurrent: peer.isCurrent },
      }}
    >
      {children}
    </ConversationConnectionProvider>
  );
}
async function mountRows() {
  const viewFor = (turns: Awaited<ReturnType<typeof read>>) =>
    bound(
      <OutboundQueuedMessages
        sessionId={sessionId}
        turns={turns}
        onError={errors}
        onRetry={vi.fn()}
      />,
    );
  const view = render(viewFor(await read()));
  return { ...view, refresh: async () => view.rerender(viewFor(await read())) };
}
async function expectDecoys() {
  const rows = await outboundDispatch.snapshot();
  expect(
    rows
      .filter((row) => row.conversationId !== conversationId)
      .map((row) => row.content),
  ).toEqual(['host-conversation-one', 'other-peer-conversation-one']);
  expect(errors).not.toHaveBeenCalled();
}

test('peer Edit changes its persisted row without touching colliding host or conversation keys', async () => {
  await mountRows();
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit message' })[0]!);
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Edit queued message' }),
    { target: { value: 'edited peer text' } },
  );
  fireEvent.keyDown(
    screen.getByRole('textbox', { name: 'Edit queued message' }),
    { key: 'Enter' },
  );
  await waitFor(async () =>
    expect((await read())[0]?.content).toBe('edited peer text'),
  );
  await expectDecoys();
});

test('peer reorder, merge and undo persist within the owning conversation', async () => {
  const view = await mountRows();
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Move message up' })[1]!,
  );
  await waitFor(async () =>
    expect((await read()).map((row) => row.clientTurnId)).toEqual([
      'two',
      'one',
    ]),
  );
  await view.refresh();
  fireEvent.click(screen.getByRole('button', { name: 'Preview merge' }));
  fireEvent.click(screen.getByRole('button', { name: 'Merge messages' }));
  await waitFor(async () => expect(await read()).toHaveLength(1));
  expect((await read())[0]?.content).toBe(
    'peer-conversation-two\n\npeer-conversation-one',
  );
  await view.refresh();
  fireEvent.click(screen.getByRole('button', { name: 'Undo merge' }));
  await waitFor(async () =>
    expect((await read()).map((row) => row.clientTurnId)).toEqual([
      'two',
      'one',
    ]),
  );
  await expectDecoys();
});

test('peer Discard retires its exact saved row and then reports the remaining count', async () => {
  const discarded = vi.fn();
  render(
    bound(
      <OutboundQueuedMessages
        sessionId={sessionId}
        turns={await read()}
        onError={errors}
        onRetry={vi.fn()}
        onDiscarded={discarded}
      />,
    ),
  );
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Discard message' })[0]!,
  );
  await waitFor(() => expect(discarded).toHaveBeenCalledWith(1));
  expect((await read()).map((row) => row.clientTurnId)).toEqual(['two']);
  expect((await outboundDispatch.retiredKeys(owner)).discarded).toContain(
    'one',
  );
  await expectDecoys();
});

test('peer unsent Dismiss removes the matching durable copy as well as the local record', async () => {
  const messages = [
    { id: 'one', content: 'refused peer text', reason: 'Refused', at: 1 },
  ];
  activeChatsStore.updateChat(sessionId, { unsentMessages: messages });
  render(bound(<UnsentMessages sessionId={sessionId} messages={messages} />));
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Unsent messages' })).getByRole(
      'button',
      { name: 'Dismiss unsent message' },
    ),
  );
  await waitFor(async () =>
    expect((await read()).map((row) => row.clientTurnId)).toEqual(['two']),
  );
  expect(activeChatsStore.getSnapshot()[sessionId]?.unsentMessages).toEqual([]);
  await expectDecoys();
});

test('a retired peer lease cannot discard a saved turn or dismiss its unsent record', async () => {
  const messages = [
    { id: 'one', content: 'refused peer text', reason: 'Refused', at: 1 },
  ];
  activeChatsStore.updateChat(sessionId, { unsentMessages: messages });
  vi.spyOn(peer, 'isCurrent').mockReturnValue(false);
  const discarded = vi.fn();
  render(
    bound(
      <>
        <OutboundQueuedMessages
          sessionId={sessionId}
          turns={await read()}
          onError={errors}
          onRetry={vi.fn()}
          onDiscarded={discarded}
        />
        <UnsentMessages sessionId={sessionId} messages={messages} />
      </>,
    ),
  );
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Discard message' })[0]!,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Dismiss unsent message' }),
  );
  await waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
  expect(discarded).not.toHaveBeenCalled();
  expect(await read()).toHaveLength(2);
  expect(activeChatsStore.getSnapshot()[sessionId]?.unsentMessages).toEqual(
    messages,
  );
});
