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
  history: {
    data: {
      pages: [
        {
          entries: [] as Array<{
            clientInputId: string;
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

import { ChildWorkInstructionPanel } from '../ChildWorkInstructionPanel';
import { SubagentTranscriptCard } from '../SubagentTranscriptCard';
import { UIBlockActionsContext } from '../UIBlockActionsContext';

beforeEach(async () => {
  await clear();
  mocks.writeGate = undefined;
  mocks.send.mockReset();
  mocks.history.isError = false;
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
  await screen.findByText(/Delivery could not be confirmed/);
  const first = mocks.send.mock.calls[0][0];
  expect(first).toMatchObject({
    threadId: 'parent',
    childId: 'child',
    turnId: 'turn',
    input: 'Please check this',
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Check saved instruction' }),
  );
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
  expect(mocks.send.mock.calls[1][0]).toEqual(first);
});

test('concurrent panels claim one durable instruction before dispatch', async () => {
  mocks.send.mockResolvedValue({ outcome: 'indeterminate' });
  const a = view('turn', true, 'A');
  const b = view('turn', true, 'B');
  const inputA = await within(a.container).findByLabelText('Send to A');
  const inputB = await within(b.container).findByLabelText('Send to B');
  fireEvent.change(inputA, { target: { value: 'First instruction' } });
  fireEvent.click(within(a.container).getByRole('button', { name: 'Send' }));
  await within(a.container).findByText(/Delivery could not be confirmed/);
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
    .mockResolvedValueOnce({ outcome: 'steered' })
    .mockResolvedValue({ outcome: 'indeterminate' });
  const a = view('turn', true, 'A');
  const b = view('turn', true, 'B');
  const inputA = await within(a.container).findByLabelText('Send to A');
  const inputB = await within(b.container).findByLabelText('Send to B');
  fireEvent.change(inputA, { target: { value: 'First instruction' } });
  fireEvent.click(within(a.container).getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  const checking = view('turn', true, 'Checking');
  fireEvent.click(
    await within(checking.container).findByRole('button', {
      name: 'Check saved instruction',
    }),
  );
  await within(checking.container).findByText('Sent to the subagent.');
  fireEvent.change(inputB, { target: { value: 'Second instruction' } });
  fireEvent.click(within(b.container).getByRole('button', { name: 'Send' }));
  await within(b.container).findByText(/Delivery could not be confirmed/);
  const second = mocks.send.mock.calls[2][0];
  finishFirst({ outcome: 'steered' });
  await within(a.container).findByText('Sent to the subagent.');
  a.unmount();
  b.unmount();
  checking.unmount();
  view('new-turn');
  expect(
    await screen.findByText('Saved instruction: Second instruction'),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Check saved instruction' }),
  );
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(4));
  expect(mocks.send.mock.calls[3][0]).toEqual(second);
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
  await screen.findByText(/Delivery could not be confirmed/);
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
  await screen.findByText(/Delivery could not be confirmed/);
  const first = mocks.send.mock.calls[0][0];
  rendered.unmount();
  mocks.history.data = {
    pages: [
      {
        entries: [
          {
            clientInputId: first.clientInputId,
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
  expect(
    await screen.findByText('Brian · mobile · Delivery unconfirmed'),
  ).toBeTruthy();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Check saved instruction' }),
  );
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
  expect(mocks.send.mock.calls[1][0]).toEqual(first);
});

test('an open engine transcript keeps sent instructions attributed behind a disclosure without hiding uncertain input', async () => {
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
          {
            clientInputId: 'uncertain',
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
        transcriptOpen
        threadId="parent"
        childId="child"
        turnId="turn"
        running
        name="Worker"
      />
      <section aria-label="Engine transcript">
        <p>Initial task</p>
        <p>Check the report</p>
        <p>Another native prompt</p>
      </section>
    </UIBlockActionsContext.Provider>,
  );
  expect(
    screen
      .getAllByText('Check the report', { selector: 'p' })
      .filter((node) => node.closest('details:not([open])') === null),
  ).toHaveLength(1);
  expect(screen.getByText('Initial task')).toBeTruthy();
  expect(screen.getByText('Another native prompt')).toBeTruthy();
  expect(screen.getByText('Another request').closest('details')).toBeNull();
  const disclosure = screen.getByText(/Sent instruction · Brian/);
  fireEvent.click(disclosure);
  expect(disclosure.closest('details')?.open).toBe(true);
  expect(
    within(disclosure.closest('details')!).getByText('Check the report'),
  ).toBeTruthy();
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
  render(
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
    </UIBlockActionsContext.Provider>,
  );
  fireEvent.click(screen.getByTestId('subagent-card').querySelector('button')!);
  expect(screen.getByText('Check the report')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'View transcript' }));
  await screen.findByText('Initial task');
  const copies = screen
    .getAllByText('Check the report')
    .filter((node) => node.closest('details:not([open])') === null);
  expect(copies).toHaveLength(1);
  expect(screen.getByText('Another native prompt')).toBeTruthy();
  const summary = screen.getByText(/Sent instruction · Brian/);
  fireEvent.click(summary);
  expect(
    within(summary.closest('details')!).getByText('Check the report'),
  ).toBeTruthy();
});
