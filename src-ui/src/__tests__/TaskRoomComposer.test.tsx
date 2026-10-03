/** @vitest-environment jsdom */
import type { TaskRoomWorkInput } from '@kontourai/station-contracts/task-room-work';
import { TaskRoomWorkNotSentError } from '@kontourai/station-sdk/project-task-rooms';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  brief: {
    version: 'station.task-room-context/v1' as const,
    digest: 'a'.repeat(64),
    title: 'Shared objective',
    description: '',
    documentRevision: 'revision-1',
    text: 'Agreed brief.',
  },
  refetch: vi.fn(),
  agent: vi.fn(),
  message: vi.fn(),
  scope: {
    apiBase: 'http://station.test',
    authorityKey: 'home-a',
    isCurrent: () => true,
  },
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => mocks.scope,
}));
vi.mock('../hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({ DiscardModal: () => null }),
}));
vi.mock('@kontourai/station-sdk/project-task-rooms', () => ({
  TaskRoomWorkNotSentError: class extends Error {},
  useAppendProjectTaskRoomHumanMessageMutation: () => ({
    mutateAsync: mocks.message,
    isPending: false,
  }),
  useSubmitTaskRoomAgentRequestMutation: () => ({
    mutateAsync: mocks.agent,
    isPending: false,
  }),
  useTaskRoomAgentRequestsQuery: () => ({
    data: {
      records: [],
      contextVersion: 'station.task-room-context/v1',
      context: mocks.brief,
    },
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
  }),
  useTaskRoomAgentOptionsQuery: () => ({
    data: {
      targets: [
        {
          id: 'builder',
          name: 'Builder',
          description: 'Build changes',
          ready: true,
        },
        {
          id: 'researcher',
          name: 'Researcher',
          description: 'Explore ideas',
          ready: true,
        },
        {
          id: 'offline',
          name: 'Offline',
          unavailableReason: 'Connect an engine',
          ready: false,
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
}));

import { TaskRoomComposer } from '../workspace-panes/TaskRoomComposer';

const props = {
  taskId: 'task-1',
  projectSlug: 'demo',
  taskCreatedAt: '2026-09-30T12:00:00.000Z',
  writable: true,
  readable: true,
};
beforeEach(() => {
  mocks.scope.authorityKey = 'home-a';
  mocks.brief = {
    version: 'station.task-room-context/v1',
    digest: 'a'.repeat(64),
    title: 'Shared objective',
    description: '',
    documentRevision: 'revision-1',
    text: 'Agreed brief.',
  };
  mocks.agent
    .mockReset()
    .mockImplementation(async (input: TaskRoomWorkInput) => ({
      kind: 'recorded',
      record: { ...input, state: 'dispatched' },
      replayed: false,
    }));
  mocks.refetch
    .mockReset()
    .mockResolvedValue({ data: { context: mocks.brief }, isError: false });
  mocks.message.mockReset().mockResolvedValue({ kind: 'committed' });
});

test('keyboard autocomplete selects an exact recipient and only Send invokes it', async () => {
  render(<TaskRoomComposer {...props} />);
  const textbox = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(textbox, { target: { value: '@res', selectionStart: 4 } });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  fireEvent.keyDown(textbox, { key: 'Enter' });
  expect(
    screen.getByRole('group', { name: 'Agent recipient' }).textContent,
  ).toContain('Researcher');
  expect(mocks.agent).not.toHaveBeenCalled();
  fireEvent.change(textbox, {
    target: { value: 'Explore the backlog', selectionStart: 19 },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(mocks.agent).toHaveBeenCalledOnce());
  expect(mocks.agent.mock.calls[0][0]).toMatchObject({
    agentId: 'researcher',
    prompt: 'Explore the backlog',
    operationId: expect.any(String),
  });
  expect(mocks.message).not.toHaveBeenCalled();
});

test('Escape and composing input keep literal mentions as human discussion', async () => {
  render(<TaskRoomComposer {...props} />);
  const textbox = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.compositionStart(textbox);
  fireEvent.change(textbox, { target: { value: '@res', selectionStart: 4 } });
  fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true });
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.compositionEnd(textbox);
  fireEvent.keyDown(textbox, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Send to task room' }));
  await waitFor(() => expect(mocks.message).toHaveBeenCalledOnce());
  expect(mocks.message.mock.calls[0][0].text).toBe('@res');
  expect(mocks.agent).not.toHaveBeenCalled();
});

test('lost acknowledgement freezes intent and an explicit retry reuses the operation', async () => {
  mocks.agent
    .mockRejectedValueOnce(new Error('lost acknowledgement'))
    .mockRejectedValueOnce(
      new TaskRoomWorkNotSentError('Retry preflight unavailable'),
    );
  render(<TaskRoomComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
  fireEvent.click(
    screen.getByRole('option', { name: 'Researcher @researcher' }),
  );
  const textbox = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(textbox, {
    target: { value: 'Explore this', selectionStart: 12 },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await screen.findByText(/Request acknowledgement is unavailable/);
  expect(textbox.matches(':disabled')).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry same agent request' }),
  );
  await waitFor(() => expect(mocks.agent).toHaveBeenCalledTimes(2));
  await screen.findByText(/Retry preflight unavailable/);
  expect(textbox.matches(':disabled')).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry same agent request' }),
  );
  await waitFor(() => expect(mocks.agent).toHaveBeenCalledTimes(3));
  expect(mocks.agent.mock.calls[1][0]).toEqual(mocks.agent.mock.calls[0][0]);
  expect(mocks.agent.mock.calls[2][0]).toEqual(mocks.agent.mock.calls[0][0]);
});

test('changing the connection cannot send the existing draft to the new Station', () => {
  const view = render(<TaskRoomComposer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Private draft' },
  });
  mocks.scope.authorityKey = 'home-b';
  view.rerender(<TaskRoomComposer {...props} />);
  expect(screen.getByRole('alert').textContent).toContain(
    'previous connection',
  );
  expect(
    screen
      .getByRole('button', { name: 'Send to task room' })
      .matches(':disabled'),
  ).toBe(true);
  expect(mocks.message).not.toHaveBeenCalled();
});

test('a filtered empty picker clears its lookup without deleting the surrounding message', () => {
  render(<TaskRoomComposer {...props} />);
  const textbox = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(textbox, {
    target: { value: 'Please @zzzz investigate', selectionStart: 12 },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
  expect(screen.getAllByRole('option')).toHaveLength(3);
  expect(screen.getByDisplayValue('Please @ investigate')).toBe(textbox);
  expect(mocks.agent).not.toHaveBeenCalled();
});

test('the previewed brief stays selected through background edits and request-only is explicit', async () => {
  const view = render(<TaskRoomComposer {...props} />);
  const textbox = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(textbox, { target: { value: '@res', selectionStart: 4 } });
  fireEvent.keyDown(textbox, { key: 'Enter' });
  expect(screen.getByText('Agreed brief.')).toBeTruthy();
  mocks.brief = {
    ...mocks.brief,
    digest: 'b'.repeat(64),
    text: 'Edited brief.',
  };
  view.rerender(<TaskRoomComposer {...props} />);
  expect(screen.queryByText('Edited brief.')).toBeNull();
  fireEvent.change(textbox, { target: { value: 'Investigate' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(mocks.agent).toHaveBeenCalledOnce());
  expect(mocks.agent.mock.calls[0][0].context.digest).toBe('a'.repeat(64));
  fireEvent.change(textbox, { target: { value: '@res', selectionStart: 4 } });
  fireEvent.keyDown(textbox, { key: 'Enter' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include Task brief' }));
  expect(screen.getByText('Only your request text will be sent.')).toBeTruthy();
  fireEvent.change(textbox, { target: { value: 'Request only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(mocks.agent).toHaveBeenCalledTimes(2));
  expect(mocks.agent.mock.calls[1][0].context).toBeUndefined();
});

test.each(['send', 'recipient'] as const)(
  'a late brief refresh cannot replace the pinned preview after %s',
  async (action) => {
    let release!: (result: {
      data: { context: typeof mocks.brief };
      isError: boolean;
    }) => void;
    mocks.refetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    if (action === 'send')
      mocks.agent.mockRejectedValueOnce(new Error('lost acknowledgement'));
    const view = render(<TaskRoomComposer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
    fireEvent.click(
      screen.getByRole('option', { name: 'Researcher @researcher' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use latest brief' }));
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalledOnce());
    if (action === 'send') {
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: 'Investigate' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
      await screen.findByText(/Request acknowledgement is unavailable/);
    } else {
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove Researcher' }),
      );
      mocks.brief = {
        ...mocks.brief,
        digest: 'c'.repeat(64),
        text: 'New recipient brief.',
      };
      view.rerender(<TaskRoomComposer {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
      fireEvent.click(screen.getByRole('option', { name: 'Builder @builder' }));
    }
    await act(async () =>
      release({
        data: {
          context: {
            ...mocks.brief,
            digest: 'b'.repeat(64),
            text: 'Late brief.',
          },
        },
        isError: false,
      }),
    );
    expect(screen.queryByText('Late brief.')).toBeNull();
    expect(
      screen.getByText(
        action === 'send' ? 'Agreed brief.' : 'New recipient brief.',
      ),
    ).toBeTruthy();
    if (action === 'send') {
      fireEvent.click(
        screen.getByRole('button', { name: 'Retry same agent request' }),
      );
      await waitFor(() => expect(mocks.agent).toHaveBeenCalledTimes(2));
      expect(mocks.agent.mock.calls[1][0]).toEqual(
        mocks.agent.mock.calls[0][0],
      );
    }
  },
);
