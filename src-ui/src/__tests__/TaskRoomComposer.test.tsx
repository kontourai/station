/** @vitest-environment jsdom */
import type { TaskRoomWorkInput } from '@kontourai/station-contracts/task-room-work';
import { TaskRoomWorkNotSentError } from '@kontourai/station-sdk/project-task-rooms';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  people: [] as string[],
  researcherAvailable: true,
  refetch: vi.fn(),
  status: vi.fn(),
  agent: vi.fn(),
  message: vi.fn(),
  scope: {
    apiBase: 'http://station.test',
    authorityKey: 'home-a',
    draftRecoveryKey: 'home-a-authorization-1',
    isCurrent: () => true,
  },
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => mocks.scope,
}));
vi.mock('../hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({ DiscardModal: () => null }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useUpdateTaskStatusMutation: () => ({
    mutateAsync: mocks.status,
    isPending: false,
  }),
}));
vi.mock('../workspace-panes/ProjectTaskRoomContext', () => ({
  useProjectTaskRoomContext: () => ({
    live: {
      participants: mocks.people.map((name) => ({
        publication: 'published',
        actor: { kind: 'human', label: name, actorId: name },
      })),
    },
  }),
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
          ready: mocks.researcherAvailable,
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
  window.sessionStorage.clear();
  mocks.scope.apiBase = 'http://station.test';
  mocks.scope.authorityKey = 'home-a';
  mocks.scope.draftRecoveryKey = 'home-a-authorization-1';
  mocks.people = [];
  mocks.researcherAvailable = true;
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
  mocks.refetch.mockReset().mockResolvedValue({
    data: { records: [], context: mocks.brief },
    isError: false,
  });
  mocks.message.mockReset().mockResolvedValue({ kind: 'committed' });
});

test('keyboard autocomplete selects an exact recipient and only Send invokes it', async () => {
  render(<TaskRoomComposer {...props} />);
  const textbox = screen.getByRole('textbox', { name: 'Message the Task' });
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

test('Escape and composing input retain the draft and an incomplete agent mention shows a picker hint', async () => {
  render(<TaskRoomComposer {...props} />);
  const textbox = screen.getByRole('textbox', { name: 'Message the Task' });
  fireEvent.compositionStart(textbox);
  fireEvent.change(textbox, { target: { value: '@res', selectionStart: 4 } });
  fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true });
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.compositionEnd(textbox);
  fireEvent.keyDown(textbox, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Send to task room' }));
  expect(
    await screen.findByText('Pick an agent from the list to send a request'),
  ).toBeTruthy();
  expect(mocks.message).not.toHaveBeenCalled();
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
  const textbox = screen.getByRole('textbox', { name: 'Message the Task' });
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
  const textbox = screen.getByRole('textbox', { name: 'Message the Task' });
  fireEvent.change(textbox, {
    target: { value: 'Please @zzzz investigate', selectionStart: 12 },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
  expect(screen.getAllByRole('option')).toHaveLength(3);
  expect(screen.getByDisplayValue('Please @ investigate')).toBe(textbox);
  expect(mocks.agent).not.toHaveBeenCalled();
});

test('send attaches the latest saved brief by default and request-only is explicit', async () => {
  const view = render(<TaskRoomComposer {...props} />);
  const textbox = screen.getByRole('textbox', { name: 'Message the Task' });
  fireEvent.change(textbox, { target: { value: '@res', selectionStart: 4 } });
  fireEvent.keyDown(textbox, { key: 'Enter' });
  mocks.brief = {
    ...mocks.brief,
    digest: 'b'.repeat(64),
    text: 'Edited brief.',
  };
  mocks.refetch.mockResolvedValue({
    data: { context: mocks.brief },
    isError: false,
  });
  view.rerender(<TaskRoomComposer {...props} />);
  fireEvent.change(textbox, { target: { value: 'Investigate' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(mocks.agent).toHaveBeenCalledOnce());
  expect(mocks.agent.mock.calls[0][0].context.digest).toBe('b'.repeat(64));
  fireEvent.change(textbox, { target: { value: '@res', selectionStart: 4 } });
  fireEvent.keyDown(textbox, { key: 'Enter' });
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Brief attached to agent requests' }),
  );
  fireEvent.change(textbox, { target: { value: 'Request only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(mocks.agent).toHaveBeenCalledTimes(2));
  expect(mocks.agent.mock.calls[1][0].context).toBeUndefined();
});

test('an authority change during latest-brief preflight retains the draft and invokes no agent', async () => {
  let release!: (value: unknown) => void;
  mocks.refetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const view = render(<TaskRoomComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
  fireEvent.click(
    screen.getByRole('option', { name: 'Researcher @researcher' }),
  );
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Private draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(mocks.refetch).toHaveBeenCalledOnce());
  mocks.scope.authorityKey = 'other-host';
  view.rerender(<TaskRoomComposer {...props} />);
  await act(async () =>
    release({ data: { context: mocks.brief }, isError: false }),
  );
  expect(mocks.agent).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
    'Private draft',
  );
});

test('slash commands change real Task status through its existing mutation path', async () => {
  mocks.status.mockReset().mockResolvedValue({ status: 'review' });
  render(<TaskRoomComposer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: '/review' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to task room' }));
  await waitFor(() =>
    expect(mocks.status).toHaveBeenCalledWith({
      taskId: props.taskId,
      status: 'review',
      apiBase: mocks.scope.apiBase,
    }),
  );
  expect(mocks.agent).not.toHaveBeenCalled();
  expect(mocks.message).not.toHaveBeenCalled();
});

test('a message acknowledgement preserves text entered for the next message', async () => {
  let acknowledge!: (value: unknown) => void;
  mocks.message.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  render(<TaskRoomComposer {...props} />);
  const textbox = screen.getByRole('textbox', { name: 'Message the Task' });
  fireEvent.change(textbox, { target: { value: 'First message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to task room' }));
  await waitFor(() => expect(mocks.message).toHaveBeenCalledOnce());
  fireEvent.change(textbox, { target: { value: 'Next thought' } });
  await act(async () => acknowledge({ kind: 'committed' }));
  expect((textbox as HTMLTextAreaElement).value).toBe('Next thought');
});

test('a hand-typed exact agent mention sends the request without selecting a picker item', async () => {
  render(<TaskRoomComposer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: '@researcher Explore the backlog' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to task room' }));
  await waitFor(() => expect(mocks.agent).toHaveBeenCalledOnce());
  expect(mocks.agent.mock.calls[0][0]).toMatchObject({
    agentId: 'researcher',
    prompt: 'Explore the backlog',
  });
  expect(mocks.message).not.toHaveBeenCalled();
});
test('slash status changes rely on the server system line without a second composer status notice', async () => {
  mocks.status.mockResolvedValue({});
  render(<TaskRoomComposer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: '/review' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to task room' }));
  await waitFor(() =>
    expect(mocks.status).toHaveBeenCalledWith({
      taskId: 'task-1',
      status: 'review',
      apiBase: 'http://station.test',
    }),
  );
  expect(screen.queryByText(/Status →/)).toBeNull();
});

test('dispatch acknowledgement is a compact transient status that clears after a few seconds', async () => {
  vi.useFakeTimers();
  try {
    render(<TaskRoomComposer {...props} />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '@researcher Investigate' },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Send to task room' }),
      );
    });
    expect(screen.getByText('Agent request dispatched.')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByText('Agent request dispatched.')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test('Enter sends the room message while Shift+Enter and IME retain the draft', async () => {
  render(<TaskRoomComposer {...props} />);
  const textbox = screen.getByRole('textbox', { name: 'Message the Task' });
  fireEvent.change(textbox, { target: { value: 'Hello team' } });
  fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true });
  fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true });
  expect(mocks.message).not.toHaveBeenCalled();
  fireEvent.keyDown(textbox, { key: 'Enter' });
  await waitFor(() =>
    expect(mocks.message).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello team' }),
    ),
  );
});

test.each([
  ['Alice Example', '\n'],
  ['Researcher', ' '],
])(
  'selecting the person %s sends a room message without invoking an agent',
  async (name, separator) => {
    mocks.people = [name];
    render(<TaskRoomComposer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
    fireEvent.click(screen.getByRole('option', { name }));
    const textbox = screen.getByRole('textbox', { name: 'Message the Task' });
    fireEvent.change(textbox, {
      target: { value: `@${name}${separator}Please review the brief.` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to task room' }));
    await waitFor(() =>
      expect(mocks.message).toHaveBeenCalledWith(
        expect.objectContaining({
          text: `@${name}${separator}Please review the brief.`,
        }),
      ),
    );
    expect(mocks.agent).not.toHaveBeenCalled();
  },
);

test('a reload offers a draft for explicit restoration without sending or reattaching a different brief choice', () => {
  const first = render(<TaskRoomComposer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'A private unsent draft' },
  });
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Brief attached to agent requests' }),
  );
  first.unmount();
  mocks.scope.authorityKey = 'new-page-boot';
  render(<TaskRoomComposer {...props} />);
  expect(screen.getByRole('region', { name: 'Saved Task draft' })).toBeTruthy();
  expect(screen.getByRole('textbox').matches(':disabled')).toBe(true);
  expect(mocks.agent).not.toHaveBeenCalled();
  expect(mocks.message).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Restore saved draft' }));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
    'A private unsent draft',
  );
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(
    false,
  );
  expect(mocks.message).not.toHaveBeenCalled();
});

test('a reload during dispatch retains its exact uncertain operation before the provider call and only retries explicitly', async () => {
  let settle!: (value: unknown) => void;
  mocks.agent.mockImplementationOnce((input: TaskRoomWorkInput) => {
    expect(
      window.sessionStorage.getItem('station-task-room-draft-recovery-v1'),
    ).toContain(input.operationId);
    return new Promise((resolve) => {
      settle = resolve;
    });
  });
  const first = render(<TaskRoomComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
  fireEvent.click(
    screen.getByRole('option', { name: 'Researcher @researcher' }),
  );
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Explore exactly this' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(mocks.agent).toHaveBeenCalledOnce());
  const original = mocks.agent.mock.calls[0][0];
  first.unmount();
  mocks.scope.authorityKey = 'new-boot';
  mocks.brief.digest = 'b'.repeat(64);
  render(<TaskRoomComposer {...props} />);
  expect(mocks.agent).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Restore saved draft' }));
  expect(screen.getByRole('textbox').matches(':disabled')).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Check saved request status' }),
  );
  await screen.findByText(/This does not prove the request failed/);
  expect(mocks.agent).toHaveBeenCalledOnce();
  await act(async () => {
    settle({ kind: 'recorded', record: { state: 'dispatched' } });
  });
  expect(screen.getByRole('textbox').matches(':disabled')).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry same agent request' }),
  );
  await waitFor(() => expect(mocks.agent).toHaveBeenCalledTimes(2));
  expect(mocks.agent.mock.calls[1][0]).toEqual(original);
});

test.each(['api', 'authorization', 'task', 'incarnation', 'project'])(
  'a saved draft never crosses a changed %s owner',
  (changed) => {
    const first = render(<TaskRoomComposer {...props} />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Only original owner' },
    });
    first.unmount();
    const next = { ...props };
    if (changed === 'api') mocks.scope.apiBase = 'http://another-station.test';
    if (changed === 'authorization')
      mocks.scope.draftRecoveryKey = 'new-authorization';
    if (changed === 'task') next.taskId = 'task-two';
    if (changed === 'incarnation')
      next.taskCreatedAt = '2026-10-01T00:00:00.000Z';
    if (changed === 'project') next.projectSlug = 'another-project';
    const second = render(<TaskRoomComposer {...next} />);
    expect(
      screen.queryByRole('region', { name: 'Saved Task draft' }),
    ).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    second.unmount();
    mocks.scope.apiBase = 'http://station.test';
    mocks.scope.draftRecoveryKey = 'home-a-authorization-1';
    render(<TaskRoomComposer {...props} />);
    expect(
      screen.getByRole('button', { name: 'Restore saved draft' }),
    ).toBeTruthy();
    expect(mocks.message).not.toHaveBeenCalled();
  },
);

test('an uncertain room message reuses its exact proposal after reload and Cancel preserves it', async () => {
  mocks.message.mockRejectedValueOnce(new Error('acknowledgement lost'));
  const first = render(<TaskRoomComposer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Hello exactly once' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to task room' }));
  await screen.findByText(/Message acknowledgement is unavailable/);
  const original = mocks.message.mock.calls[0][0];
  first.unmount();
  const second = render(<TaskRoomComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Discard saved draft' }));
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
  );
  expect(
    screen.getByRole('button', { name: 'Restore saved draft' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Restore saved draft' }));
  expect(mocks.message).toHaveBeenCalledOnce();
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry same room message' }),
  );
  await waitFor(() => expect(mocks.message).toHaveBeenCalledTimes(2));
  expect(mocks.message.mock.calls[1][0]).toEqual(original);
  await waitFor(() =>
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''),
  );
  second.unmount();
  render(<TaskRoomComposer {...props} />);
  expect(screen.queryByRole('region', { name: 'Saved Task draft' })).toBeNull();
});

test('recovery storage failure refuses provider invocation and keeps the draft', async () => {
  const view = render(<TaskRoomComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
  fireEvent.click(
    screen.getByRole('option', { name: 'Researcher @researcher' }),
  );
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Keep me' },
  });
  const store = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('quota');
    });
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
    await screen.findByText(/Recovery could not be updated/);
    expect(mocks.agent).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Keep me',
    );
  } finally {
    store.mockRestore();
    view.unmount();
  }
});

test('a saved agent cannot be silently replaced by a newly available recipient', async () => {
  mocks.agent.mockRejectedValueOnce(new Error('unknown'));
  const first = render(<TaskRoomComposer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: '@researcher Exact request' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to task room' }));
  await screen.findByText(/Request acknowledgement is unavailable/);
  first.unmount();
  mocks.researcherAvailable = false;
  render(<TaskRoomComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore saved draft' }));
  await screen.findByText(/The saved agent is unavailable/);
  expect(mocks.agent).toHaveBeenCalledOnce();
  expect(mocks.message).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox').matches(':disabled')).toBe(true);
});

test('confirmed discard removes reload recovery without claiming an uncertain request failed', async () => {
  mocks.agent.mockRejectedValueOnce(new Error('unknown'));
  const first = render(<TaskRoomComposer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: '@researcher Exact request' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to task room' }));
  await screen.findByText(/Request acknowledgement is unavailable/);
  first.unmount();
  const next = render(<TaskRoomComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Discard saved draft' }));
  expect(screen.getByRole('dialog').textContent).toContain(
    'An unconfirmed request may still be running',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  next.unmount();
  render(<TaskRoomComposer {...props} />);
  expect(screen.queryByRole('region', { name: 'Saved Task draft' })).toBeNull();
  expect(mocks.agent).toHaveBeenCalledOnce();
});

test('malformed saved uncertainty refuses recovery rather than minting a replacement operation', () => {
  window.sessionStorage.setItem(
    'station-task-room-draft-recovery-v1',
    '{not-json',
  );
  render(<TaskRoomComposer {...props} />);
  expect(screen.getByRole('alert').textContent).toContain(
    'recovery is unavailable',
  );
  expect(screen.getByRole('textbox').matches(':disabled')).toBe(true);
  expect(mocks.agent).not.toHaveBeenCalled();
  expect(mocks.message).not.toHaveBeenCalled();
});

test('restoring an ordinary mention of a person cannot turn it into an agent request', async () => {
  mocks.people = ['Researcher'];
  const first = render(<TaskRoomComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
  fireEvent.click(screen.getByRole('option', { name: 'Researcher' }));
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: '@Researcher Please review' },
  });
  first.unmount();
  render(<TaskRoomComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore saved draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send to task room' }));
  await waitFor(() => expect(mocks.message).toHaveBeenCalledOnce());
  expect(mocks.agent).not.toHaveBeenCalled();
});
