/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
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
vi.mock('idb-keyval', () => ({
  get: async (key: string) => mocks.store.get(key),
  set: async (key: string, value: unknown) => {
    mocks.store.set(key, value);
  },
  del: async (key: string) => {
    mocks.store.delete(key);
  },
}));
vi.mock('@kontourai/station-sdk', () => ({
  useChildWorkInstructionsQuery: () => mocks.history,
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
import { UIBlockActionsContext } from '../UIBlockActionsContext';

beforeEach(() => {
  mocks.store.clear();
  mocks.send.mockReset();
  mocks.history.isError = false;
  mocks.history.data = { pages: [{ entries: [] }] };
  mocks.authority.observation.grant = { kind: 'operator' };
});
afterEach(cleanup);
function view(turnId = 'turn', allowed = true) {
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
        name="Worker"
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
