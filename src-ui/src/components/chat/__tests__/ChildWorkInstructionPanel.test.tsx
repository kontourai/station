/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { clear, get } from 'idb-keyval';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeGate: undefined as
    | { entered: () => void; released: Promise<void> }
    | undefined,
  send: vi.fn(),
  showSurface: vi.fn(),
  history: {
    data: {
      pages: [
        {
          entries: [] as Array<{
            clientInputId: string;
            childId?: string;
            turnId?: string;
            text: string;
            delivery: 'delivered' | 'refused' | 'indeterminate';
            principal?: { display: string };
            clientOrigin?: { reported: { surface: string } };
          }>,
        },
      ],
    },
    isPending: false,
    isSuccess: true,
    isError: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: vi.fn(async () => ({})),
    fetchNextPage: vi.fn(),
  },
  authority: {
    status: 'ready',
    namespace: 'owner',
    observation: { grant: { kind: 'operator' } },
  },
}));
vi.mock('idb-keyval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('idb-keyval')>();
  const afterWrite = async () => {
    const gate = mocks.writeGate;
    if (!gate) return;
    mocks.writeGate = undefined;
    gate.entered();
    await gate.released;
  };
  return {
    ...actual,
    set: async <T,>(key: IDBValidKey, value: T) => {
      await actual.set(key, value);
      await afterWrite();
    },
    update: async <T,>(
      key: IDBValidKey,
      updater: (value: T | undefined) => T,
    ) => {
      await actual.update(key, updater);
      await afterWrite();
    },
  };
});
vi.mock('@kontourai/station-sdk', () => ({
  useChildWorkInstructionsQuery: () => mocks.history,
  useChildWorkTranscriptQuery: () => ({
    ...mocks.history,
    data: {
      pages: [
        {
          entries: [
            { message: 0, kind: 'text', role: 'user', text: 'Initial task' },
            {
              message: 1,
              kind: 'text',
              role: 'user',
              text: 'Check the report',
            },
            {
              message: 2,
              kind: 'text',
              role: 'user',
              text: 'Another native prompt',
            },
          ],
        },
      ],
    },
  }),
  useSteerChildWorkMutation: () => ({
    mutateAsync: mocks.send,
    isPending: false,
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'owner',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => mocks.authority,
}));

vi.mock('../../../contexts/useShowSurface', () => ({
  useShowSurface: () => mocks.showSurface,
}));

import { ChildChatContext } from '../../chat-dock/ChildChatNavigationContext';
import { ConversationConnectionProvider } from '../../conversation/ConversationConnectionContext';
import { ChildWorkInstructionPanel } from '../ChildWorkInstructionPanel';
import { SubagentTranscriptCard } from '../SubagentTranscriptCard';
import { UIBlockActionsContext } from '../UIBlockActionsContext';

beforeEach(async () => {
  await clear();
  mocks.writeGate = undefined;
  mocks.send.mockReset();
  mocks.history.isError = false;
  mocks.history.refetch.mockImplementation(async () => ({
    data: mocks.history.data,
  }));
  mocks.history.data = { pages: [{ entries: [] }] };
  mocks.authority.observation.grant = { kind: 'operator' };
});
afterEach(cleanup);
function view(turnId = 'turn', allowed = true, name = 'Worker') {
  return render(
    <UIBlockActionsContext.Provider
      value={{ submitForm: () => {}, canSendChildInstruction: allowed }}
    >
      <ChildWorkInstructionPanel
        historyAvailable
        threadId="parent"
        childId="child"
        turnId={turnId}
        running
        name={name}
      />
    </UIBlockActionsContext.Provider>,
  );
}

test('sends only to the named child and keeps the same request after an uncertain response', async () => {
  mocks.send
    .mockResolvedValueOnce({ outcome: 'indeterminate' })
    .mockResolvedValueOnce({ outcome: 'steered' });
  view();
  const input = await screen.findByLabelText('Send to Worker');
  fireEvent.change(input, { target: { value: 'Please check this' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findAllByText('May have reached the agent');
  const first = mocks.send.mock.calls[0][0];
  expect(first).toMatchObject({
    threadId: 'parent',
    childId: 'child',
    turnId: 'turn',
    input: 'Please check this',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await screen.findByText('Station still can’t confirm it.');
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.history.refetch).toHaveBeenCalled();
  expect(
    (
      await get<{ clientInputId: string }>(
        'child-steer:' + JSON.stringify(['owner', 'parent', 'child']),
      )
    )?.clientInputId,
  ).toBe(first.clientInputId);
});

test('concurrent panels claim one durable instruction before dispatch', async () => {
  mocks.send.mockResolvedValue({ outcome: 'indeterminate' });
  const a = view('turn', true, 'A');
  const b = view('turn', true, 'B');
  const inputA = await within(a.container).findByLabelText('Send to A');
  const inputB = await within(b.container).findByLabelText('Send to B');
  fireEvent.change(inputA, { target: { value: 'First instruction' } });
  fireEvent.click(within(a.container).getByRole('button', { name: 'Send' }));
  await within(a.container).findAllByText('May have reached the agent');
  fireEvent.change(inputB, { target: { value: 'Second instruction' } });
  fireEvent.click(within(b.container).getByRole('button', { name: 'Send' }));
  await within(b.container).findByText(
    'Another instruction is awaiting confirmation.',
  );
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect((inputB as HTMLTextAreaElement).value).toBe('Second instruction');
  a.unmount();
  b.unmount();
  view();
  expect(
    await screen.findByText('Saved instruction: First instruction'),
  ).toBeTruthy();
});

test('an older response cannot clear a later uncertain instruction', async () => {
  let finishFirst!: (result: { outcome: string }) => void;
  mocks.send
    .mockImplementationOnce(
      () =>
        new Promise<{ outcome: string }>((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockResolvedValue({ outcome: 'indeterminate' });
  const a = view('turn', true, 'A');
  const b = view('turn', true, 'B');
  const inputA = await within(a.container).findByLabelText('Send to A');
  const inputB = await within(b.container).findByLabelText('Send to B');
  fireEvent.change(inputA, { target: { value: 'First instruction' } });
  fireEvent.click(within(a.container).getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  const first = mocks.send.mock.calls[0][0];
  mocks.history.data = {
    pages: [
      { entries: [{ ...first, text: first.input, delivery: 'delivered' }] },
    ],
  };
  const checking = view('turn', true, 'Checking');
  fireEvent.click(
    await within(checking.container).findByRole('button', {
      name: 'Check',
    }),
  );
  await waitFor(() =>
    expect(
      within(checking.container).queryByText(
        'Saved instruction: First instruction',
      ),
    ).toBeNull(),
  );
  fireEvent.change(inputB, { target: { value: 'Second instruction' } });
  fireEvent.click(within(b.container).getByRole('button', { name: 'Send' }));
  await within(b.container).findAllByText('May have reached the agent');
  const second = mocks.send.mock.calls[1][0];
  finishFirst({ outcome: 'steered' });
  await within(a.container).findByText('Sent to the subagent.');
  a.unmount();
  b.unmount();
  checking.unmount();
  view('new-turn');
  expect(
    await screen.findByText('Saved instruction: Second instruction'),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await screen.findByText('Station still can’t confirm it.');
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(
    (
      await get<{ clientInputId: string }>(
        'child-steer:' + JSON.stringify(['owner', 'parent', 'child']),
      )
    )?.clientInputId,
  ).toBe(second.clientInputId);
});

test('freezes editing until the instruction is durably saved', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.writeGate = { entered, released };
  mocks.send.mockResolvedValue({ outcome: 'indeterminate' });
  const rendered = view();
  const input = await screen.findByLabelText('Send to Worker');
  fireEvent.change(input, { target: { value: 'Original instruction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await started;
  const disabled = (input as HTMLTextAreaElement).disabled;
  fireEvent.change(input, { target: { value: 'Changed during save' } });
  release();
  await screen.findAllByText('May have reached the agent');
  expect(disabled).toBe(true);
  expect(mocks.send.mock.calls[0][0].input).toBe('Original instruction');
  expect(
    await get(`child-steer:${JSON.stringify(['owner', 'parent', 'child'])}`),
  ).toMatchObject({ input: 'Original instruction' });
  rendered.unmount();
  view();
  expect(
    await screen.findByText('Saved instruction: Original instruction'),
  ).toBeTruthy();
});

test('a changed child turn refuses the composed instruction', async () => {
  const rendered = view();
  fireEvent.change(await screen.findByLabelText('Send to Worker'), {
    target: { value: 'Do this' },
  });
  rendered.rerender(
    <UIBlockActionsContext.Provider
      value={{ submitForm: () => {}, canSendChildInstruction: true }}
    >
      <ChildWorkInstructionPanel
        historyAvailable
        threadId="parent"
        childId="child"
        turnId="new-turn"
        running
        name="Worker"
      />
    </UIBlockActionsContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText(/turn changed/)).toBeTruthy();
  expect(mocks.send).not.toHaveBeenCalled();
});

test('read-only viewers and children without an active supported turn cannot send', async () => {
  const rendered = view('turn', false);
  expect(
    await screen.findByText('You cannot send to this subagent.'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  rendered.rerender(
    <UIBlockActionsContext.Provider
      value={{ submitForm: () => {}, canSendChildInstruction: true }}
    >
      <ChildWorkInstructionPanel
        historyAvailable
        threadId="parent"
        childId="child"
        running
        name="Worker"
      />
    </UIBlockActionsContext.Provider>,
  );
  expect(
    await screen.findByText('This subagent cannot receive instructions.'),
  ).toBeTruthy();
});

test('a remounted child keeps the exact uncertain request and shows recorded delivery', async () => {
  mocks.send
    .mockResolvedValueOnce({ outcome: 'indeterminate' })
    .mockResolvedValueOnce({ outcome: 'steered' });
  const rendered = view();
  fireEvent.change(await screen.findByLabelText('Send to Worker'), {
    target: { value: 'Remember this' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findAllByText('May have reached the agent');
  const first = mocks.send.mock.calls[0][0];
  rendered.unmount();
  mocks.history.data = {
    pages: [
      {
        entries: [
          {
            clientInputId: first.clientInputId,
            childId: first.childId,
            turnId: first.turnId,
            text: 'Remember this',
            delivery: 'indeterminate',
            principal: { display: 'Brian' },
            clientOrigin: { reported: { surface: 'mobile' } },
          },
        ],
      },
    ],
  };
  view('new-turn');
  expect(await screen.findByText(/Brian · mobile/)).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: 'Check' }));
  await screen.findByText('Station still can’t confirm it.');
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.history.refetch).toHaveBeenCalled();
});

test('delivered and uncertain instructions remain attributed in the parent card', () => {
  mocks.history.data = {
    pages: [
      {
        entries: [
          {
            clientInputId: 'sent',
            text: 'Check the report',
            delivery: 'delivered',
            principal: { display: 'Sender' },
          },
          {
            clientInputId: 'pending',
            text: 'Another request',
            delivery: 'indeterminate',
          },
        ],
      },
    ],
  };
  render(
    <UIBlockActionsContext.Provider
      value={{ submitForm: () => {}, canSendChildInstruction: true }}
    >
      <ChildWorkInstructionPanel
        historyAvailable
        threadId="parent"
        childId="child"
        running
        name="Worker"
      />
    </UIBlockActionsContext.Provider>,
  );
  expect(screen.getByText('Check the report')).toBeTruthy();
  expect(screen.getByText(/Sender ·/)).toBeTruthy();
  expect(screen.getByText('Another request')).toBeTruthy();
});

test('opening the real card transcript keeps the provider prompt once and retains the attributed copy on demand', async () => {
  mocks.history.data = {
    pages: [
      {
        entries: [
          {
            clientInputId: 'sent',
            text: 'Check the report',
            delivery: 'delivered',
            principal: { display: 'Brian' },
          },
        ],
      },
    ],
  };
  const open = vi.fn();
  render(
    <ConversationConnectionProvider value={{ apiBase: 'http://station.test' }}>
      <ChildChatContext.Provider value={open}>
        <UIBlockActionsContext.Provider
          value={{ submitForm: () => {}, canSendChildInstruction: true }}
        >
          <SubagentTranscriptCard
            child={{
              toolAnchor: false,
              provider: 'codex',
              item: {
                producer: 'engine-subagent',
                reporterThreadId: 'parent',
                childId: 'child',
                status: 'completed',
                transcript: {
                  kind: 'codex-thread',
                  threadId: '00000000-0000-4000-8000-000000000001',
                },
              },
            }}
          />
        </UIBlockActionsContext.Provider>
      </ChildChatContext.Provider>
    </ConversationConnectionProvider>,
  );
  fireEvent.click(screen.getByTestId('subagent-card').querySelector('button')!);
  expect(screen.getByText('Check the report')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: 'parent', childId: 'child' }),
  );
  expect(screen.getByText('Check the report')).toBeTruthy();
});
