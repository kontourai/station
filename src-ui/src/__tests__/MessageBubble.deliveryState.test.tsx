/**
 * @vitest-environment jsdom
 *
 * The user's own bubble says where its message stands until the agent has it:
 * outlined (no fill) with a short label, and the actions that state allows.
 * Uses the REAL MessageBubble, delivery hook and derivation over the REAL chat
 * store; only the outbox writes, the delivery lookup and the platform's
 * "does Station outlive the app" answer are scripted.
 */

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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatUIState } from '../contexts/active-chats-state';
import type { ChatMessage } from '../types';

const outbox = vi.hoisted(() => ({
  retry: vi.fn(async (_key: string) => undefined),
  discard: vi.fn(async (_key: string) => undefined),
  dismissUnconfirmed: vi.fn(async (_key: string) => undefined),
  enqueue: vi.fn(),
}));
const recheckOutboundTurn = vi.hoisted(() =>
  vi.fn(async (_key: string) => 'indeterminate' as const),
);
const platform = vi.hoisted(() => ({ outlives: true as boolean | undefined }));

vi.mock('../lib/outboundQueue', () => ({ outboundDispatch: outbox }));
vi.mock('../lib/deliveryLookup', () => ({ recheckOutboundTurn }));
vi.mock('../hooks/useStationOutlivesApp', () => ({
  useStationOutlivesApp: () => platform.outlives,
}));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../highlight/highlight-client', () => ({
  highlightCode: () => new Promise<string>(() => {}),
}));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));

const { MessageBubble } = await import('../components/chat/MessageBubble');
const { activeChatsStore } = await import('../contexts/active-chats-store');

const CHAT = 'chat-delivery-bubble';
const KEY = 'send-key-1';
const TEXT = 'Please keep this message';

function bubbleMessage(extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: KEY,
    clientId: KEY,
    role: 'user',
    content: TEXT,
    timestamp: 1,
    ...extra,
  } as ChatMessage;
}

function setChat(facts: Partial<ChatUIState>, message = bubbleMessage()) {
  activeChatsStore.updateChat(CHAT, { messages: [message], ...facts });
}

function renderBubble(message = bubbleMessage()) {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageBubble
        msg={message}
        idx={0}
        activeSession={{
          id: CHAT,
          agentSlug: 'codex',
          agentName: 'Codex',
          messageCount: 1,
        }}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const bubble = view.container.querySelector('.message.user') as HTMLElement;
  return { bubble };
}

function expectOutlined(bubble: HTMLElement, state: string) {
  expect(bubble.classList.contains('message--undelivered')).toBe(true);
  expect(bubble.classList.contains(`message--delivery-${state}`)).toBe(true);
  expect(
    bubble
      .querySelector('.message-delivery')
      ?.getAttribute('data-delivery-state'),
  ).toBe(state);
}

describe('MessageBubble delivery state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.outlives = true;
    activeChatsStore.initChat(CHAT, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Delivery',
    });
  });
  afterEach(() => {
    cleanup();
    activeChatsStore.removeChat(CHAT);
  });

  it('sending: outlined, "Sending…", and not announced on every send', () => {
    setChat({
      status: 'sending',
      pendingClientTurnId: KEY,
      sendAwaitingTurnStart: true,
    });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'sending');
    const label = within(bubble).getByText('Sending…');
    expect(label.closest('[role="status"]')).toBeNull();
  });

  it('received: says it is safe to close only when Station outlives the app', () => {
    setChat({
      status: 'sending',
      pendingClientTurnId: KEY,
      sendAwaitingTurnStart: true,
      deliveryChecks: { [KEY]: 'received' },
    });
    const first = renderBubble();
    expectOutlined(first.bubble, 'received');
    const status = within(first.bubble).getByRole('status');
    expect(status.textContent).toBe('Received · safe to close');
    cleanup();

    platform.outlives = false;
    const second = renderBubble();
    expect(within(second.bubble).getByRole('status').textContent).toBe(
      'Received · keep the app open',
    );
    cleanup();

    platform.outlives = undefined;
    const third = renderBubble();
    expect(within(third.bubble).getByRole('status').textContent).toBe(
      'Received',
    );
  });

  it('waiting-to-send: saved on this device and sent when connected', () => {
    setChat({
      outboundQueuedTurns: [
        { clientTurnId: KEY, content: TEXT, createdAt: 1, status: 'pending' },
      ],
    });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'waiting-to-send');
    expect(within(bubble).getByRole('status').textContent).toBe(
      'Saved on this device · sends when connected',
    );
  });

  it('not-sent: Retry resends the same key; no Check', async () => {
    setChat({
      outboundQueuedTurns: [
        { clientTurnId: KEY, content: TEXT, createdAt: 1, status: 'failed' },
      ],
    });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'not-sent');
    expect(within(bubble).getByRole('status').textContent).toBe('Not sent');
    expect(within(bubble).queryByRole('button', { name: 'Check' })).toBeNull();
    fireEvent.click(within(bubble).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(outbox.retry).toHaveBeenCalledWith(KEY));
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('not-sent: Edit puts the text back in the composer and takes the unsent bubble out', async () => {
    setChat({
      input: '',
      outboundQueuedTurns: [
        { clientTurnId: KEY, content: TEXT, createdAt: 1, status: 'failed' },
      ],
    });
    const { bubble } = renderBubble();
    fireEvent.click(within(bubble).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(outbox.discard).toHaveBeenCalledWith(KEY));
    const chat = activeChatsStore.getSnapshot()[CHAT];
    expect(chat?.input).toBe(TEXT);
    expect(chat?.messages?.some((message) => message.clientId === KEY)).toBe(
      false,
    );
  });

  it('not-sent: Edit never overwrites a draft already in the composer', async () => {
    setChat({
      input: 'something newer',
      outboundQueuedTurns: [
        { clientTurnId: KEY, content: TEXT, createdAt: 1, status: 'failed' },
      ],
    });
    const { bubble } = renderBubble();
    fireEvent.click(within(bubble).getByRole('button', { name: 'Edit' }));
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[CHAT]?.input).toBe(
        `something newer\n\n${TEXT}`,
      ),
    );
  });

  it('not-sent: a Discard the outbox refuses keeps the bubble and says why', async () => {
    outbox.discard.mockRejectedValueOnce(new Error('storage is unavailable'));
    setChat({
      outboundQueuedTurns: [
        { clientTurnId: KEY, content: TEXT, createdAt: 1, status: 'failed' },
      ],
    });
    const { bubble } = renderBubble();
    fireEvent.click(within(bubble).getByRole('button', { name: 'Discard' }));
    expect((await within(bubble).findByRole('alert')).textContent).toContain(
      'storage is unavailable',
    );
    expect(
      activeChatsStore
        .getSnapshot()
        [CHAT]?.messages?.some((message) => message.clientId === KEY),
    ).toBe(true);
  });

  it('unconfirmed: "May have reached the agent", Check asks again and never resends', async () => {
    setChat({ deliveryChecks: { [KEY]: 'indeterminate' } });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'unconfirmed');
    expect(within(bubble).getByRole('status').textContent).toBe(
      'May have reached the agent',
    );
    expect(within(bubble).queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(within(bubble).getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(recheckOutboundTurn).toHaveBeenCalledWith(KEY));
    expect((await within(bubble).findByRole('alert')).textContent).toBe(
      'Station still can’t confirm it.',
    );
    expect(outbox.retry).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('unconfirmed: discarding states the risk first, and only the explicit confirmation dismisses it (#3596)', async () => {
    setChat({ deliveryChecks: { [KEY]: 'indeterminate' } });
    const { bubble } = renderBubble();
    fireEvent.click(within(bubble).getByRole('button', { name: 'Discard…' }));
    const confirm = within(bubble).getByRole('group', {
      name: 'Discard this message?',
    });
    expect(confirm.textContent).toContain(
      'It may already have reached the agent.',
    );
    expect(outbox.dismissUnconfirmed).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    expect(
      within(bubble).queryByRole('group', { name: 'Discard this message?' }),
    ).toBeNull();
    fireEvent.click(within(bubble).getByRole('button', { name: 'Discard…' }));
    fireEvent.click(
      within(bubble).getByRole('button', { name: 'I checked, discard it' }),
    );
    await waitFor(() =>
      expect(outbox.dismissUnconfirmed).toHaveBeenCalledWith(KEY),
    );
    expect(outbox.discard).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        activeChatsStore.getSnapshot()[CHAT]?.deliveryChecks?.[KEY],
      ).toBeUndefined(),
    );
  });

  it('delivered: a normal filled bubble with no label', () => {
    setChat({ deliveryChecks: { [KEY]: 'started' } });
    const { bubble } = renderBubble();
    expect(bubble.classList.contains('message--undelivered')).toBe(false);
    expect(bubble.querySelector('.message-delivery')).toBeNull();
  });

  it('follows the chat live: the label goes once the turn starts', () => {
    setChat({
      status: 'sending',
      pendingClientTurnId: KEY,
      sendAwaitingTurnStart: true,
    });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'sending');
    act(() => {
      activeChatsStore.updateChat(CHAT, {
        deliveryChecks: { [KEY]: 'started' },
      });
    });
    expect(bubble.classList.contains('message--undelivered')).toBe(false);
    expect(bubble.querySelector('.message-delivery')).toBeNull();
  });

  it("another device's or a historical message carries no delivery label", () => {
    setChat({}, bubbleMessage({ clientId: undefined, turnId: 'turn-1' }));
    const { bubble } = renderBubble(
      bubbleMessage({ clientId: undefined, turnId: 'turn-1' }),
    );
    expect(bubble.classList.contains('message--undelivered')).toBe(false);
  });
});

describe('MessageDeliveryNote held-on-device', () => {
  afterEach(cleanup);

  // A transcript bubble never derives this state (a held follow-up is listed
  // in the chat's queue, not the transcript), so its label is pinned on the
  // note itself.
  it('says it is queued on this device', async () => {
    const { MessageDeliveryNote } = await import(
      '../components/chat/message-bubble/MessageDeliveryNote'
    );
    render(
      <MessageDeliveryNote
        chatKey={CHAT}
        clientTurnId={KEY}
        state="held-on-device"
        text={TEXT}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Queued on this device',
    );
  });
});
