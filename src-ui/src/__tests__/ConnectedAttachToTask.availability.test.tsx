/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const tasksQuery = vi.hoisted(() => ({
  state: {} as {
    data?: unknown[];
    isSuccess?: boolean;
    isLoading?: boolean;
    error?: unknown;
  },
  calls: [] as unknown[][],
}));

vi.mock('@kontourai/station-sdk', () => ({
  useTasksQuery: (...args: unknown[]) => {
    tasksQuery.calls.push(args);
    return { refetch: vi.fn(), ...tasksQuery.state };
  },
  useCreateTaskReferenceMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));
vi.mock('@kontourai/station-sdk/task-user-input-references', () => ({
  useAttachTaskUserInputReferenceMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

import {
  ConnectedAttachAnswerToTaskButton,
  ConnectedAttachUserInputToTaskButton,
} from '../components/chat/AttachAnswerToTaskButton';
import TurnActionsMenu from '../components/chat/TurnActionsMenu';

function renderUserInput() {
  return render(
    <ConnectedAttachUserInputToTaskButton
      sessionId="session-1"
      eventId="event-1"
      excerpt="Selected input"
    />,
  );
}

function renderAnswer(projectId?: string) {
  return render(
    <ConnectedAttachAnswerToTaskButton
      sessionId="session-1"
      turnId="turn-1"
      excerpt="Selected answer"
      projectId={projectId}
    />,
  );
}

describe('Task attachment affordances follow the Task catalog', () => {
  beforeEach(() => {
    tasksQuery.state = {};
    tasksQuery.calls = [];
  });

  test('keeps the Task picker alive when focus leaves its answer menu', async () => {
    tasksQuery.state = {
      isSuccess: true,
      data: [{ id: 'task-1', title: 'My Task' }],
    };
    render(
      <TurnActionsMenu
        taskTarget={{
          sessionId: 'session-1',
          turnId: 'turn-1',
          excerpt: 'Selected answer',
        }}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'More answer actions' });
    trigger.focus();
    fireEvent.click(trigger);
    const attach = await screen.findByRole('menuitem', {
      name: 'Add to Task: answer',
    });
    attach.focus();
    fireEvent.click(attach);
    const search = await screen.findByRole('searchbox', {
      name: 'Find a Task',
    });
    search.focus();
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(screen.getByRole('dialog', { name: /^Add to Task/ })).toBeTruthy();
    expect(screen.queryByRole('menu', { name: 'Answer actions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test.each(['answer', 'input'])(
    'an empty catalog offers New Task from this for an exact %s',
    async (kind) => {
      tasksQuery.state = { data: [], isSuccess: true };
      const listener = vi.fn();
      window.addEventListener('station:shape-task', listener);
      if (kind === 'answer') renderAnswer('alpha');
      else renderUserInput();
      fireEvent.click(
        screen.getByRole('button', {
          name:
            kind === 'answer' ? 'Add to Task: answer' : 'Add to Task: message',
        }),
      );
      expect(
        await screen.findByText(
          kind === 'answer' ? 'No Tasks in this project yet.' : 'No Tasks yet.',
        ),
      ).toBeTruthy();
      expect(screen.queryByText('Tasks are not available')).toBeNull();
      fireEvent.click(
        await screen.findByRole('button', { name: 'New Task from this' }),
      );
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].detail.source).toEqual(
        kind === 'answer'
          ? {
              sessionId: 'session-1',
              turnId: 'turn-1',
              excerpt: 'Selected answer',
            }
          : {
              sessionId: 'session-1',
              eventId: 'event-1',
              excerpt: 'Selected input',
            },
      );
      expect(screen.queryByRole('dialog')).toBeNull();
      window.removeEventListener('station:shape-task', listener);
    },
  );

  test('offers the affordance when a Task exists', () => {
    tasksQuery.state = {
      data: [{ id: 'task-1', title: 'Ship it' }],
      isSuccess: true,
    };

    renderUserInput();
    expect(screen.getByRole('button', { name: /^Add to Task/ })).toBeTruthy();
  });

  test('asks the catalog without waiting for a click', () => {
    tasksQuery.state = { data: [], isSuccess: true };
    renderUserInput();
    // The deferred `{ enabled: false }` config is what made the old dead end
    // unavoidable: nothing could be known before the dialog opened.
    expect(tasksQuery.calls).toEqual([[undefined]]);
  });

  test.each([
    ['still in flight', { isLoading: true }],
    ['errored', { error: new Error('offline'), isSuccess: false }],
  ])(
    'keeps the affordance when the catalog is %s, because that proves nothing',
    (_label, state) => {
      tasksQuery.state = state;
      renderUserInput();
      expect(screen.getByRole('button', { name: /^Add to Task/ })).toBeTruthy();
    },
  );
});
