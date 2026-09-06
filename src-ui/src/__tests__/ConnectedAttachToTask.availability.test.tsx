/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Every user bubble in a chat with no Tasks offered "Add input to Task", and
 * clicking it opened a picker that said "Tasks are not available". The catalog
 * query was deferred until the dialog opened, so the affordance could not know
 * what the dialog was about to tell you.
 *
 * These drive the CONNECTED components — the ones that own the query — because
 * that is where the decision lives; the unconnected pair takes its rows from a
 * host adapter and has no availability question to answer.
 */

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

function renderUserInput() {
  return render(
    <ConnectedAttachUserInputToTaskButton
      sessionId="session-1"
      eventId="event-1"
    />,
  );
}

function renderAnswer() {
  return render(
    <ConnectedAttachAnswerToTaskButton sessionId="session-1" turnId="turn-1" />,
  );
}

describe('Task attachment affordances follow the Task catalog', () => {
  beforeEach(() => {
    tasksQuery.state = {};
    tasksQuery.calls = [];
  });

  test('offers nothing when the catalog has settled with no Tasks', () => {
    tasksQuery.state = { data: [], isSuccess: true };

    renderUserInput();
    expect(screen.queryByRole('button', { name: 'Add input to Task' })).toBe(
      null,
    );

    renderAnswer();
    expect(screen.queryByRole('button', { name: /Add this answer/ })).toBe(
      null,
    );
  });

  test('offers the affordance when a Task exists', () => {
    tasksQuery.state = {
      data: [{ id: 'task-1', title: 'Ship it' }],
      isSuccess: true,
    };

    renderUserInput();
    expect(
      screen.getByRole('button', { name: 'Add input to Task' }),
    ).toBeTruthy();
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
      expect(
        screen.getByRole('button', { name: 'Add input to Task' }),
      ).toBeTruthy();
    },
  );
});
