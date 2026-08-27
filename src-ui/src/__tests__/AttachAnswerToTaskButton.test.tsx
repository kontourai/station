/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  type AttachAnswerToTaskAdapter,
  AttachAnswerToTaskButton,
  type AttachUserInputToTaskAdapter,
  AttachUserInputToTaskButton,
} from '../components/chat/AttachAnswerToTaskButton';

function adapter(
  overrides: Partial<AttachAnswerToTaskAdapter> = {},
): AttachAnswerToTaskAdapter {
  return {
    tasks: [
      { id: 'task-beta', title: 'Beta task', status: 'in_progress' },
      { id: 'task-alpha', title: 'Alpha task', status: 'ready' },
    ],
    attach: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderButton(value = adapter()) {
  return render(
    <AttachAnswerToTaskButton
      sessionId="session-7"
      turnId="turn-9"
      projectId="project-alpha"
      adapter={value}
    />,
  );
}

function inputAdapter(
  overrides: Partial<AttachUserInputToTaskAdapter> = {},
): AttachUserInputToTaskAdapter {
  return {
    tasks: adapter().tasks,
    attach: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('AttachAnswerToTaskButton', () => {
  test('selects an existing Task and attaches only the canonical tuple input', async () => {
    const attach = vi.fn(async () => undefined);
    renderButton(adapter({ attach }));

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Add this answer to a Task (turn turn-9)',
      }),
    );

    expect(
      screen.getByRole('dialog', { name: 'Add answer to Task' }),
    ).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Add to Task' });
    expect(submit.getAttribute('disabled')).not.toBeNull();

    // Native buttons make each Task reachable and selectable with either
    // keyboard activation or pointer activation; no custom listbox script
    // traps focus or invents a second selection model.
    fireEvent.click(screen.getByRole('button', { name: /Alpha task/i }));
    expect(
      screen
        .getByRole('button', { name: 'Add to Task' })
        .getAttribute('disabled'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add to Task' }));
    await waitFor(() =>
      expect(attach).toHaveBeenCalledWith({
        taskId: 'task-alpha',
        kind: 'turn',
        sessionId: 'session-7',
        turnId: 'turn-9',
        sourceSurface: 'chat',
      }),
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByText('Answer reference added to Task “Alpha task”.'),
    ).toBeTruthy();
  });

  test('filters the authorized Task list without changing the attachment identity', () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /Add this answer/i }));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a Task' }), {
      target: { value: 'beta' },
    });

    expect(screen.getByRole('button', { name: /Beta task/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Alpha task/i })).toBeNull();
  });

  test('uses the shared dialog lifecycle for Escape close and return focus', async () => {
    renderButton();
    const trigger = screen.getByRole('button', { name: /Add this answer/i });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Add answer to Task' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('reports a failed attachment without claiming it was added', async () => {
    renderButton(
      adapter({
        attach: vi.fn(async () => {
          throw new Error('The Task cannot accept this answer.');
        }),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Add this answer/i }));
    fireEvent.click(screen.getByRole('button', { name: /Alpha task/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Task' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Unable to add this to the Task. Try again.',
    );
    expect(screen.queryByText(/Answer reference added/)).toBeNull();
  });

  test('pins an exact durable user input and never reflects a protected failure', async () => {
    const attach = vi.fn(async () => undefined);
    render(
      <AttachUserInputToTaskButton
        sessionId="session-7"
        eventId="event-9"
        projectId="project-alpha"
        adapter={inputAdapter({ attach })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add input to Task' }));
    fireEvent.click(screen.getByRole('button', { name: /Alpha task/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Task' }));
    await waitFor(() =>
      expect(attach).toHaveBeenCalledWith({
        taskId: 'task-alpha',
        sessionId: 'session-7',
        eventId: 'event-9',
        sourceSurface: 'chat',
      }),
    );
  });

  test('submits the captured input target after a row rerender', async () => {
    const attach = vi.fn(async () => undefined);
    const value = inputAdapter({ attach });
    const view = render(
      <AttachUserInputToTaskButton
        sessionId="session-old"
        eventId="event-old"
        adapter={value}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add input to Task' }));
    view.rerender(
      <AttachUserInputToTaskButton
        sessionId="session-new"
        eventId="event-new"
        adapter={value}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alpha task/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Task' }));
    await waitFor(() =>
      expect(attach).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-old',
          eventId: 'event-old',
        }),
      ),
    );
  });

  test('resets an already selected Task when current membership removes it', () => {
    const value = inputAdapter();
    const view = render(
      <AttachUserInputToTaskButton
        sessionId="session-7"
        eventId="event-9"
        adapter={value}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add input to Task' }));
    fireEvent.click(screen.getByRole('button', { name: /Alpha task/i }));
    view.rerender(
      <AttachUserInputToTaskButton
        sessionId="session-7"
        eventId="event-9"
        adapter={inputAdapter({
          tasks: [{ id: 'task-beta', title: 'Beta task' }],
        })}
      />,
    );
    expect(
      screen
        .getByRole('button', { name: 'Add to Task' })
        .getAttribute('disabled'),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Alpha task/i })).toBeNull();
  });

  test('refuses a second submit before the first mutation settles', async () => {
    let resolve!: () => void;
    const attach = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    render(
      <AttachUserInputToTaskButton
        sessionId="session-7"
        eventId="event-9"
        adapter={inputAdapter({ attach })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add input to Task' }));
    fireEvent.click(screen.getByRole('button', { name: /Alpha task/i }));
    const submit = screen.getByRole('button', { name: 'Add to Task' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(attach).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('does not disclose protected input details when pinning fails', async () => {
    render(
      <AttachUserInputToTaskButton
        sessionId="session-7"
        eventId="event-9"
        adapter={inputAdapter({
          attach: vi.fn(async () => {
            throw new Error('session-secret/event-secret private prompt');
          }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add input to Task' }));
    fireEvent.click(screen.getByRole('button', { name: /Alpha task/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Task' }));
    const error = await screen.findByRole('alert');
    expect(error.textContent).toBe(
      'Unable to add this to the Task. Try again.',
    );
    expect(error.textContent).not.toContain('secret');
  });
});
