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
  rowStatus: vi.fn(
    async (_key: string): Promise<string | undefined> => undefined,
  ),
  subscribe: vi.fn((_listener: () => void) => () => undefined),
  retiredKeys: vi.fn(async () => ({
    discarded: [] as string[],
    accepted: [] as string[],
  })),
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
const chatStatus = await import('../components/status/chatStatus');
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

/** The delivery note's one status region (its fact, once past Sending). */
function statusText(bubble: HTMLElement): string | null | undefined {
  const region = bubble.querySelector('.message-delivery__status');
  expect(region?.getAttribute('role')).toBe('status');
  return region?.textContent;
}

/** The glyph's tooltip: its SVG title, which also names it. */
function glyphTitle(bubble: HTMLElement): string | null | undefined {
  return glyph(bubble).querySelector('title')?.textContent;
}

/** The happy-path glyph beside the bubble (its name is the state's fact). */
function glyph(bubble: HTMLElement): HTMLElement {
  const element = bubble.querySelector<HTMLElement>('.message-delivery__glyph');
  expect(element).not.toBeNull();
  return element!;
}

/** The exception line: open with its words, or folded away with none. */
function lineText(bubble: HTMLElement): string | null {
  const reveal = bubble.querySelector('.message-delivery__reveal');
  if (!reveal?.hasAttribute('data-open')) return null;
  return reveal.querySelector('.message-delivery__label')?.textContent ?? '';
}

/** Exception: the line shows the words the status region announces. */
function expectLine(bubble: HTMLElement, text: string) {
  expect(lineText(bubble)).toBe(text);
  expect(statusText(bubble)).toBe(text);
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

  it('sending: outlined with a turning glyph, no text line, and not announced on every send', () => {
    setChat({
      status: 'sending',
      pendingClientTurnId: KEY,
      sendAwaitingTurnStart: true,
    });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'sending');
    expect(glyph(bubble).getAttribute('data-glyph')).toBe('sending');
    expect(within(bubble).getByRole('img', { name: 'Sending' })).toBeTruthy();
    expect(lineText(bubble)).toBeNull();
    expect(statusText(bubble)).toBe('');
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
    // No text line: the check glyph names the fact, and it is announced.
    expect(lineText(first.bubble)).toBeNull();
    expect(glyph(first.bubble).getAttribute('data-glyph')).toBe('received');
    expect(glyphTitle(first.bubble)).toBe('Received. Safe to close the app.');
    expect(statusText(first.bubble)).toBe('Received. Safe to close the app.');
    cleanup();

    platform.outlives = false;
    const second = renderBubble();
    expect(statusText(second.bubble)).toBe('Received. Keep the app open.');
    cleanup();

    platform.outlives = undefined;
    const third = renderBubble();
    expect(statusText(third.bubble)).toBe('Received');
  });

  it('the composer pill says what the received bubble says', () => {
    const { deriveChatStatus } = chatStatus;
    for (const outlives of [true, false, undefined]) {
      platform.outlives = outlives;
      setChat({
        status: 'sending',
        pendingClientTurnId: KEY,
        sendAwaitingTurnStart: true,
        deliveryChecks: { [KEY]: 'received' },
      });
      const { bubble } = renderBubble();
      const pill = deriveChatStatus({
        approvalCount: 0,
        turnLive: true,
        waitingOnUser: false,
        sendAwaitingTurnStart: true,
        stationHasSend: true,
        stationOutlivesApp: outlives,
      });
      expect(pill?.label).toBe('Starting');
      expect(pill?.details).toEqual([{ text: statusText(bubble) }]);
      cleanup();
    }
  });

  it('waiting-to-send: saved on this device and sent when connected', () => {
    setChat({
      outboundQueuedTurns: [
        { clientTurnId: KEY, content: TEXT, createdAt: 1, status: 'pending' },
      ],
    });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'waiting-to-send');
    expectLine(bubble, 'Sends when connected');
  });

  it('not-sent: Retry resends the same key; no Check', async () => {
    setChat({
      outboundQueuedTurns: [
        { clientTurnId: KEY, content: TEXT, createdAt: 1, status: 'failed' },
      ],
    });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'not-sent');
    expectLine(bubble, 'Not sent');
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

  it('not-sent: Discard drops its outbox row and its unsent bubble', async () => {
    setChat({
      outboundQueuedTurns: [
        { clientTurnId: KEY, content: TEXT, createdAt: 1, status: 'failed' },
      ],
    });
    const { bubble } = renderBubble();
    // Discard sits in the bubble's own ⋯ menu, not a second overflow.
    fireEvent.click(
      await within(bubble).findByRole('button', {
        name: 'More message actions',
      }),
    );
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Discard unsent message' }),
    );
    await waitFor(() =>
      expect(
        activeChatsStore
          .getSnapshot()
          [CHAT]?.messages?.some((message) => message.clientId === KEY),
      ).toBe(false),
    );
    expect(outbox.discard).toHaveBeenCalledWith(KEY);
    expect(outbox.dismissUnconfirmed).not.toHaveBeenCalled();
  });

  it('not-sent: a Discard the outbox refuses keeps the bubble and says why', async () => {
    outbox.discard.mockRejectedValueOnce(new Error('storage is unavailable'));
    setChat({
      outboundQueuedTurns: [
        { clientTurnId: KEY, content: TEXT, createdAt: 1, status: 'failed' },
      ],
    });
    const { bubble } = renderBubble();
    // Discard is the row's third action, behind its overflow menu.
    // Discard sits in the bubble's own ⋯ menu, not a second overflow.
    fireEvent.click(
      await within(bubble).findByRole('button', {
        name: 'More message actions',
      }),
    );
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Discard unsent message' }),
    );
    await waitFor(() => expect(outbox.discard).toHaveBeenCalledWith(KEY));
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
    expectLine(bubble, 'May have reached the agent');
    expect(within(bubble).queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(within(bubble).getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(recheckOutboundTurn).toHaveBeenCalledWith(KEY));
    // An informational result is polite, never an alert.
    const result = await within(bubble).findByText(
      'Station still can’t confirm it.',
    );
    expect(result.getAttribute('role')).toBe('status');
    expect(within(bubble).queryByRole('alert')).toBeNull();
    expect(outbox.retry).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('unconfirmed: discarding states the risk first, and only the explicit confirmation dismisses it (#3596)', async () => {
    setChat({ deliveryChecks: { [KEY]: 'indeterminate' } });
    const { bubble } = renderBubble();
    const discard = await within(bubble).findByRole('button', {
      name: 'Discard…',
    });
    discard.focus();
    fireEvent.click(discard);
    const confirm = within(bubble).getByRole('group', {
      name: 'Discard this message?',
    });
    expect(confirm.textContent).toContain(
      'It may already have reached the agent.',
    );
    // Focus moves into the question, and comes back to Discard… on Keep it.
    expect(discard.getAttribute('aria-controls')).toBe(confirm.id);
    expect(document.activeElement).toBe(
      within(confirm).getByRole('button', { name: 'Keep it' }),
    );
    expect(outbox.dismissUnconfirmed).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    expect(
      within(bubble).queryByRole('group', { name: 'Discard this message?' }),
    ).toBeNull();
    expect(document.activeElement).toBe(discard);
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

  it('sending: promises the device keeps it only when its outbox row was written', () => {
    setChat({
      status: 'sending',
      pendingClientTurnId: KEY,
      sendAwaitingTurnStart: true,
      durableClientTurnId: KEY,
    });
    const saved = renderBubble();
    expect(glyphTitle(saved.bubble)).toBe(
      'Sending. Kept on this device if the app closes.',
    );
    cleanup();
    // Attachments, a visual skill, or storage that failed: no row was written.
    activeChatsStore.updateChat(CHAT, { durableClientTurnId: undefined });
    const unsaved = renderBubble();
    expect(glyphTitle(unsaved.bubble)).toBe('Sending');
  });

  it('one status region stays mounted, and only its text changes when Sending becomes Received', () => {
    setChat({
      status: 'sending',
      pendingClientTurnId: KEY,
      sendAwaitingTurnStart: true,
    });
    const { bubble } = renderBubble();
    const region = bubble.querySelector('.message-delivery__status');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.textContent).toBe('');
    act(() => {
      activeChatsStore.updateChat(CHAT, {
        deliveryChecks: { [KEY]: 'received' },
      });
    });
    expect(bubble.querySelector('.message-delivery__status')).toBe(region);
    expect(region?.textContent).toBe('Received. Safe to close the app.');
  });

  it('a send with no answer reads as waiting for Station, in the words the list uses', () => {
    setChat({
      outboundQueuedTurns: [
        {
          clientTurnId: KEY,
          content: TEXT,
          createdAt: 1,
          status: 'invoking',
          awaitingLookup: true,
        },
      ],
    });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'awaiting-confirmation');
    expectLine(bubble, 'No answer yet. Resends only if it never arrived.');
  });

  it("another running window's send reads Sending…; once that window is gone it waits for Station, as the list says", () => {
    const row = {
      clientTurnId: KEY,
      content: TEXT,
      createdAt: 1,
      status: 'invoking' as const,
    };
    setChat({ outboundQueuedTurns: [{ ...row, sendUnderWay: true }] });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'sending');
    expect(glyph(bubble).getAttribute('data-glyph')).toBe('sending');
    act(() => {
      activeChatsStore.updateChat(CHAT, { outboundQueuedTurns: [row] });
    });
    expectOutlined(bubble, 'awaiting-confirmation');
    expectLine(bubble, 'No answer yet. Resends only if it never arrived.');
  });

  it('waiting behind an earlier unsent message says so, not "sends when connected"', () => {
    setChat({
      outboundQueuedTurns: [
        {
          clientTurnId: KEY,
          content: TEXT,
          createdAt: 1,
          status: 'pending',
          behindUnsent: true,
        },
      ],
    });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'waiting-behind-unsent');
    expectLine(bubble, 'Waits for the unsent message above');
  });

  it('a message written for another Station says it waits for that Station', () => {
    setChat({
      outboundQueuedTurns: [
        {
          clientTurnId: KEY,
          content: TEXT,
          createdAt: 1,
          status: 'pending',
          waitingForStation: 'http://other.test',
        },
      ],
    });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'waiting-for-station');
    expectLine(bubble, 'Waits for its own Station');
  });

  it("this device's own message with no answer reads Not confirmed; another device's never does", () => {
    setChat({ localSendKeys: [KEY] });
    const own = renderBubble();
    expectOutlined(own.bubble, 'unanswered');
    expectLine(own.bubble, 'Not confirmed');
    cleanup();
    activeChatsStore.updateChat(CHAT, { localSendKeys: [] });
    const other = renderBubble();
    expect(other.bubble.classList.contains('message--undelivered')).toBe(false);
    expect(other.bubble.querySelector('.message-delivery')).toBeNull();
  });

  it('unconfirmed: no Discard… while its outbox row is still a send under way', async () => {
    outbox.rowStatus.mockResolvedValue('invoking');
    setChat({ deliveryChecks: { [KEY]: 'indeterminate' } });
    const { bubble } = renderBubble();
    await waitFor(() => expect(outbox.rowStatus).toHaveBeenCalledWith(KEY));
    await act(async () => {
      await Promise.resolve();
    });
    expect(within(bubble).getByRole('button', { name: 'Check' })).toBeTruthy();
    expect(
      within(bubble).queryByRole('button', { name: 'Discard…' }),
    ).toBeNull();
    outbox.rowStatus.mockResolvedValue(undefined);
  });

  it('a discard that finds Station already started the message keeps the bubble as delivered', async () => {
    outbox.retiredKeys.mockResolvedValueOnce({
      discarded: [],
      accepted: [KEY],
    });
    setChat({
      deliveryChecks: { [KEY]: 'indeterminate' },
      localSendKeys: [KEY],
    });
    const { bubble } = renderBubble();
    fireEvent.click(
      await within(bubble).findByRole('button', { name: 'Discard…' }),
    );
    fireEvent.click(
      within(bubble).getByRole('button', { name: 'I checked, discard it' }),
    );
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[CHAT]?.deliveryChecks?.[KEY]).toBe(
        'started',
      ),
    );
    const chat = activeChatsStore.getSnapshot()[CHAT];
    expect(chat?.messages?.some((message) => message.clientId === KEY)).toBe(
      true,
    );
    expect(chat?.localSendKeys).toEqual([]);
  });

  it('delivered: a normal filled bubble with no label', () => {
    setChat({ deliveryChecks: { [KEY]: 'started' } });
    const { bubble } = renderBubble();
    expect(bubble.classList.contains('message--undelivered')).toBe(false);
    expect(bubble.querySelector('.message-delivery')).toBeNull();
  });

  it('follows the chat live: once the turn starts the bubble fills and the glyph fades out in place', () => {
    setChat({
      status: 'sending',
      pendingClientTurnId: KEY,
      sendAwaitingTurnStart: true,
    });
    const { bubble } = renderBubble();
    expectOutlined(bubble, 'sending');
    const mark = glyph(bubble);
    act(() => {
      activeChatsStore.updateChat(CHAT, {
        deliveryChecks: { [KEY]: 'received' },
      });
    });
    act(() => {
      activeChatsStore.updateChat(CHAT, {
        deliveryChecks: { [KEY]: 'started' },
      });
    });
    expect(bubble.classList.contains('message--undelivered')).toBe(false);
    // The same glyph stays mounted (its fade is CSS on the delivered state),
    // out of the accessibility tree, with nothing announced or shown.
    expect(glyph(bubble)).toBe(mark);
    expect(
      bubble
        .querySelector('.message-delivery')
        ?.getAttribute('data-delivery-state'),
    ).toBe('delivered');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(statusText(bubble)).toBe('');
    expect(lineText(bubble)).toBeNull();
    expect(glyphTitle(bubble)).toBe('Delivered');
  });

  it('an exception line folds away in place when the message is delivered', () => {
    setChat({ localSendKeys: [KEY] });
    const { bubble } = renderBubble();
    expectLine(bubble, 'Not confirmed');
    const reveal = bubble.querySelector('.message-delivery__reveal');
    act(() => {
      activeChatsStore.updateChat(CHAT, {
        deliveryChecks: { [KEY]: 'started' },
      });
    });
    // Same element, closed and inert, still holding its words while the CSS
    // fold runs, so the band never empties before it collapses.
    expect(bubble.querySelector('.message-delivery__reveal')).toBe(reveal);
    expect(reveal?.hasAttribute('data-open')).toBe(false);
    expect(reveal?.hasAttribute('inert')).toBe(true);
    expect(reveal?.textContent).toContain('Not confirmed');
    expect(statusText(bubble)).toBe('');
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
    expect(
      document.querySelector('.message-delivery__status')?.textContent,
    ).toBe('Queued. Sends after this reply.');
  });
});
