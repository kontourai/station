/** @vitest-environment jsdom */
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { UIFormBlock } from '@kontourai/station-contracts/ui-block';
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
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ChatContentPart } from '../contexts/active-chats-state';
import type { useSendMessage } from '../hooks/useActiveChatSessionMessaging';
import type { ChatSession } from '../types';

const { send, stream, connection } = vi.hoisted(() => ({
  send: vi.fn(),
  stream: { parts: [] as ChatContentPart[] },
  connection: { apiBase: 'http://localhost:3242' },
}));
vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../contexts/ApiBaseContext', () => ({ useApiBase: () => connection }));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../hooks/useToolApproval', () => ({ useToolApproval: () => vi.fn() }));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => send,
}));
// Provider content is the fixture seam; both transcript renderers and form ownership are real.
vi.mock('../hooks/useStreamingContent', () => ({
  useStreamingContent: () => ({
    contentParts: stream.parts,
    streamingText: '',
    hasContent: true,
    contentRevision: 1,
  }),
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import { activeChatsStore } from '../contexts/active-chats-store';

const form: UIFormBlock = {
  type: 'form',
  id: 'review',
  title: 'Review',
  fields: [
    { name: 'reviewer', label: 'Reviewer', type: 'text', required: true },
    { name: 'sign_off', label: 'Sign off', type: 'checkbox' },
  ],
};
function part(
  sourceEventId: string,
  block: UIFormBlock = form,
): ChatContentPart {
  return {
    type: 'ui-block',
    sourceEventId,
    toolCallId: `tool-${sourceEventId}`,
    uiBlock: block,
  };
}
function session(
  id: string,
  parts: ChatContentPart[],
  live = false,
): ChatSession {
  return {
    id,
    conversationId: `conv-${id}`,
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Review chat',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    status: 'idle',
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
    orchestrationSessionStarted: true,
    orchestrationTurnOpen: live,
    messages: live
      ? []
      : [
          {
            role: 'assistant',
            content: '',
            turnId: 'turn-review',
            contentParts: parts,
          },
        ],
  };
}
function view(chat: ChatSession, mount = 'first') {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ChatMessageList
        key={mount}
        activeSession={chat}
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
      />
    </QueryClientProvider>
  );
}
function controls(title = 'Review') {
  const heading = screen.getByRole('heading', { name: title });
  const formElement = heading.closest('form');
  if (!formElement) throw new Error('Expected a chat-native form');
  return within(formElement);
}
function fill(title = 'Review', value = 'casey') {
  const ui = controls(title);
  fireEvent.change(ui.getByRole('textbox', { name: /Reviewer/ }), {
    target: { value },
  });
  fireEvent.click(ui.getByLabelText('Sign off'));
}

beforeEach(() => {
  send.mockReset().mockResolvedValue(true);
  connection.apiBase = 'http://localhost:3242';
});
afterEach(cleanup);

test.each(['supplied', 'generated'])(
  'keeps %s-ID form values across streaming settlement and a transcript remount, and submits them once',
  async (identity) => {
    const chatKey = `transition-${identity}`;
    const parts = [
      part(`result-${chatKey}`, {
        ...form,
        id: identity === 'supplied' ? form.id : undefined,
      }),
    ];
    stream.parts = parts;
    const chat = session(chatKey, parts, true);
    const rendered = render(view(chat));
    fill();
    const streamingInput = controls().getByRole('textbox', {
      name: /Reviewer/,
    });
    rendered.rerender(view(session(chatKey, parts)));
    expect(controls().getByRole('textbox', { name: /Reviewer/ })).not.toBe(
      streamingInput,
    );
    expect(
      (
        controls().getByRole('textbox', {
          name: /Reviewer/,
        }) as HTMLInputElement
      ).value,
    ).toBe('casey');
    expect(
      (controls().getByLabelText('Sign off') as HTMLInputElement).checked,
    ).toBe(true);
    const settledInput = controls().getByRole('textbox', { name: /Reviewer/ });
    rendered.rerender(
      view(
        session(chatKey, [
          { type: 'text', content: 'Review requested.' },
          ...parts,
        ]),
      ),
    );
    expect(controls().getByRole('textbox', { name: /Reviewer/ })).toBe(
      settledInput,
    );
    rendered.rerender(view(session(chatKey, parts), 'remounted'));
    expect(
      (
        controls().getByRole('textbox', {
          name: /Reviewer/,
        }) as HTMLInputElement
      ).value,
    ).toBe('casey');
    fireEvent.click(controls().getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(
        controls().getByRole('button', { name: 'Submitted' }),
      ).toBeTruthy(),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][3]).toContain('"reviewer": "casey"');
    expect(send.mock.calls[0][3]).toContain('"sign_off": true');
    rendered.rerender(view(session(chatKey, parts), 'submitted-remount'));
    expect(
      (
        controls().getByRole('button', {
          name: 'Submitted',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  },
);

test('isolates repeated supplied IDs by result and block occurrence, and keeps drafts when switching chats', async () => {
  const parts = [
    part('result-a'),
    part('result-a', { ...form, title: 'Second review' }),
    part('result-b', { ...form, title: 'Third review' }),
  ];
  const rendered = render(view(session('isolation', parts)));
  fill();
  fill('Second review', 'robin');
  expect(
    (
      controls('Third review').getByRole('textbox', {
        name: /Reviewer/,
      }) as HTMLInputElement
    ).value,
  ).toBe('');
  fireEvent.click(controls().getByRole('button', { name: 'Submit' }));
  await waitFor(() =>
    expect(controls().getByRole('button', { name: 'Submitted' })).toBeTruthy(),
  );
  expect(
    (
      controls('Second review').getByRole('button', {
        name: 'Submit',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  rendered.rerender(view(session('other-chat', [part('result-a')])));
  expect(
    (controls().getByRole('textbox', { name: /Reviewer/ }) as HTMLInputElement)
      .value,
  ).toBe('');
  rendered.rerender(view(session('isolation', parts)));
  expect(
    (
      controls('Second review').getByRole('textbox', {
        name: /Reviewer/,
      }) as HTMLInputElement
    ).value,
  ).toBe('robin');
});

test.each(['false', 'rejected'])(
  'keeps values and avoids a second send when acceptance is %s',
  async (outcome) => {
    let finish!: () => void;
    send.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve, reject) => {
          finish = () =>
            outcome === 'false'
              ? resolve(false)
              : reject(new Error('Disconnected'));
        }),
    );
    const chat = session(`unconfirmed-${outcome}`, [part(`result-${outcome}`)]);
    const rendered = render(view(chat));
    fill();
    fireEvent.click(controls().getByRole('button', { name: 'Submit' }));
    expect(
      (
        controls().getByRole('textbox', {
          name: /Reviewer/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    rendered.rerender(view(chat, 'pending-remount'));
    expect(
      (
        controls().getByRole('button', {
          name: 'Sending…',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => finish());
    await waitFor(() =>
      expect(
        (
          controls().getByRole('button', {
            name: 'Check send status',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    expect(
      (
        controls().getByRole('textbox', {
          name: /Reviewer/,
        }) as HTMLInputElement
      ).value,
    ).toBe('casey');
    expect(controls().getByRole('alert').textContent).toContain(
      'Submission could not be confirmed',
    );
    rendered.rerender(view(chat, 'unconfirmed-remount'));
    fireEvent.click(
      controls().getByRole('button', { name: 'Check send status' }),
    );
    expect(send).toHaveBeenCalledTimes(1);
  },
);

test('isolates Station connections, and closing a chat retires drafts without a late send restoring them', async () => {
  const chat = session('closed', [part('result-closed')]);
  const rendered = render(view(chat));
  fill();
  connection.apiBase = 'http://localhost:3243';
  rendered.rerender(view(chat, 'other-station'));
  expect(
    (controls().getByRole('textbox', { name: /Reviewer/ }) as HTMLInputElement)
      .value,
  ).toBe('');
  connection.apiBase = 'http://localhost:3242';
  rendered.rerender(view(chat, 'original-station'));
  expect(
    (controls().getByRole('textbox', { name: /Reviewer/ }) as HTMLInputElement)
      .value,
  ).toBe('casey');
  let resolve!: (value: boolean) => void;
  send.mockImplementationOnce(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(controls().getByRole('button', { name: 'Submit' }));
  rendered.unmount();
  act(() => activeChatsStore.removeChat('closed'));
  await act(async () => resolve(true));
  render(view(chat));
  expect(
    (controls().getByRole('textbox', { name: /Reviewer/ }) as HTMLInputElement)
      .value,
  ).toBe('');
  expect(
    (controls().getByRole('button', { name: 'Submit' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test('restores an editable form on definite refusal, then locks acknowledged queue admission', async () => {
  send.mockImplementationOnce(
    (...args: Parameters<ReturnType<typeof useSendMessage>>) => {
      args[7]?.onAdmission?.('not-invoked');
      return Promise.resolve(false);
    },
  );
  const rendered = render(
    view(session('admission', [part('result-admission')])),
  );
  fill();
  fireEvent.click(controls().getByRole('button', { name: 'Submit' }));
  await waitFor(() =>
    expect(
      (controls().getByRole('button', { name: 'Submit' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(
    (controls().getByRole('textbox', { name: /Reviewer/ }) as HTMLInputElement)
      .value,
  ).toBe('casey');
  send.mockImplementationOnce(
    (...args: Parameters<ReturnType<typeof useSendMessage>>) => {
      args[7]?.onAdmission?.('accepted');
      return Promise.resolve(undefined);
    },
  );
  fireEvent.click(controls().getByRole('button', { name: 'Submit' }));
  await waitFor(() =>
    expect(controls().getByRole('button', { name: 'Submitted' })).toBeTruthy(),
  );
  rendered.rerender(
    view(session('admission', [part('result-admission')]), 'queue-remount'),
  );
  expect(
    (controls().getByRole('button', { name: 'Submitted' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);
});

test('a later sender Retry acknowledgement settles the same unconfirmed form after remount', async () => {
  let acknowledge:
    | NonNullable<
        NonNullable<
          Parameters<ReturnType<typeof useSendMessage>>[7]
        >['onAdmission']
      >
    | undefined;
  send.mockImplementationOnce(
    (...args: Parameters<ReturnType<typeof useSendMessage>>) => {
      acknowledge = args[7]?.onAdmission;
      acknowledge?.('indeterminate');
      return Promise.resolve(false);
    },
  );
  const chat = session('retry-ack', [part('result-retry-ack')]);
  const rendered = render(view(chat));
  fill();
  fireEvent.click(controls().getByRole('button', { name: 'Submit' }));
  await waitFor(() =>
    expect(
      controls().getByRole('button', { name: 'Check send status' }),
    ).toBeTruthy(),
  );
  rendered.rerender(view(chat, 'retry-remount'));
  act(() => acknowledge?.('accepted'));
  expect(
    (controls().getByRole('button', { name: 'Submitted' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (controls().getByRole('textbox', { name: /Reviewer/ }) as HTMLInputElement)
      .value,
  ).toBe('casey');
});

test('retires an old recovery action before dispatch when a fresh submission succeeds or the chat closes', async () => {
  let claimOldRetry: (() => boolean) | undefined;
  send.mockImplementationOnce(
    (...args: Parameters<ReturnType<typeof useSendMessage>>) => {
      claimOldRetry = args[7]?.claimRetry;
      args[7]?.onAdmission?.('not-invoked');
      return Promise.resolve(false);
    },
  );
  const chat = session('stale-retry', [part('result-stale-retry')]);
  const rendered = render(view(chat));
  fill();
  fireEvent.click(controls().getByRole('button', { name: 'Submit' }));
  await waitFor(() =>
    expect(
      (controls().getByRole('button', { name: 'Submit' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(controls().getByRole('button', { name: 'Submit' }));
  await waitFor(() =>
    expect(controls().getByRole('button', { name: 'Submitted' })).toBeTruthy(),
  );
  act(() => expect(claimOldRetry?.()).toBe(false));
  rendered.unmount();
  act(() => activeChatsStore.removeChat('stale-retry'));
  act(() => expect(claimOldRetry?.()).toBe(false));
  expect(send).toHaveBeenCalledTimes(2);
});
