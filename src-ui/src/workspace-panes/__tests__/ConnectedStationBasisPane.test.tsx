/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const hooks = vi.hoisted(() => {
  const refetchInspection = vi.fn();
  return {
    attach: vi.fn(),
    pending: false,
    attachOptions: undefined as unknown,
    refetchInspection,
    inspection: {
      data: undefined as unknown,
      error: null as unknown,
      isLoading: false,
      refetch: refetchInspection,
    },
    kept: [] as unknown[],
    keptError: null as unknown,
    refetchKept: vi.fn(),
    session: vi.fn(),
    nativeBinding: null as { bindingId: string; exactOrigin: string } | null,
    nativeShell: false,
    evidenceAvailable: true,
    taskChoices: vi.fn(),
    tasks: [
      {
        id: 'chosen-task',
        title: 'Chosen Task',
        status: 'open',
      },
    ],
    focusRestore: undefined as 'inspect' | 'keep' | undefined,
  };
});

vi.mock('@kontourai/station-connect', () => ({
  requestAuthorityScopeFromCredentialEvidence: (
    evidence: {
      connectionId: string;
      activationEpoch: string;
      authorityGeneration: number;
      credentialState: string;
      origin: string;
    },
    options?: { authorityQualifier?: string },
  ) => ({
    apiBase: evidence.origin,
    authorityKey: JSON.stringify([
      evidence.connectionId,
      evidence.activationEpoch,
      evidence.authorityGeneration,
      evidence.credentialState,
      ...(options?.authorityQualifier ? [options.authorityQualifier] : []),
    ]),
  }),
  useConnections: () => ({
    captureCredentialEvidence: () =>
      hooks.evidenceAvailable
        ? {
            connectionId: 'connection',
            activationEpoch: 'runtime:1',
            authorityGeneration: 4,
            credentialState: 'available',
            origin: 'http://station.test',
          }
        : null,
  }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useTasksQuery: (...args: unknown[]) => {
    hooks.taskChoices(...args);
    return {
      data: hooks.tasks,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

vi.mock('@kontourai/station-sdk/task-tool-results', () => ({
  useAttachTaskToolResultReferenceMutation: (options: unknown) => {
    hooks.attachOptions = options;
    return { isPending: hooks.pending, mutateAsync: hooks.attach };
  },
  useSessionToolResultQuery: (...args: unknown[]) => {
    hooks.session(...args);
    return hooks.inspection;
  },
  useTaskToolResultReferencesQuery: () => ({
    data: hooks.kept,
    error: hooks.keptError,
    isLoading: false,
    refetch: hooks.refetchKept,
  }),
}));

vi.mock('../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: hooks.nativeShell }),
  nativeProfileRepository: () => ({
    captureNativeRequestBinding: () => hooks.nativeBinding,
  }),
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () =>
    hooks.evidenceAvailable && (!hooks.nativeShell || hooks.nativeBinding)
      ? {
          apiBase: 'http://station.test',
          authorityKey: JSON.stringify([
            'connection',
            'runtime:1',
            4,
            'available',
            ...(hooks.nativeShell && hooks.nativeBinding
              ? [hooks.nativeBinding.bindingId]
              : []),
          ]),
        }
      : undefined,
}));

vi.mock('@kontourai/station-basis-pane/station-basis-pane', () => ({
  StationBasisPane: ({
    scope,
    renderExecutionActions,
  }: {
    scope: { kind: string; sessionId?: string };
    renderExecutionActions?: (input: unknown) => unknown;
  }) => (
    <section>
      {
        renderExecutionActions?.({
          ref: {
            authority: '@kontourai/thread',
            schemaVersion: '1.2.0',
            kind: 'result',
            threadId: scope.sessionId ?? 'source-session',
            resultId: 'exact-result',
          },
          scope,
          occurrenceKey: `${scope.kind}:${scope.sessionId ?? 'task'}`,
          restoreFocusAction: hooks.focusRestore,
        }) as never
      }
    </section>
  ),
}));

const { ConnectedStationBasisPane } = await import(
  '../ConnectedStationBasisPane'
);

function direct(sessionId = 'source-session') {
  return (
    <ConnectedStationBasisPane
      scope={{ kind: 'direct-answer', sessionId, turnId: 'turn' }}
    />
  );
}

describe('ConnectedStationBasisPane', () => {
  test('withholds browser Basis without a captured authority instead of falling back to ambient reads', () => {
    hooks.nativeShell = false;
    hooks.evidenceAvailable = false;
    hooks.session.mockClear();
    try {
      render(direct());
      expect(screen.getByRole('alert').textContent).toContain('authorized');
      expect(hooks.session).not.toHaveBeenCalled();
    } finally {
      hooks.evidenceAvailable = true;
    }
  });
  test('fails closed before an unbound native Basis query can use an ambient connection', () => {
    hooks.nativeShell = true;
    hooks.nativeBinding = null;
    hooks.session.mockClear();
    render(direct());
    expect(screen.getByRole('alert').textContent).toContain('authorized');
    expect(hooks.session).not.toHaveBeenCalled();
    hooks.nativeShell = false;
  });

  test('adds the captured native receipt to the same opaque scope key', () => {
    hooks.nativeShell = true;
    hooks.nativeBinding = {
      bindingId: '11111111-1111-4111-8111-111111111111',
      exactOrigin: 'http://station.test',
    };
    hooks.session.mockClear();
    render(direct());
    expect(hooks.session).toHaveBeenLastCalledWith(
      '',
      '',
      expect.objectContaining({
        requestScope: {
          apiBase: 'http://station.test',
          authorityKey: JSON.stringify([
            'connection',
            'runtime:1',
            4,
            'available',
            '11111111-1111-4111-8111-111111111111',
          ]),
        },
      }),
    );
    hooks.nativeBinding = null;
    hooks.nativeShell = false;
  });

  test('inspects a result lazily without writing', async () => {
    hooks.attach.mockReset();
    hooks.session.mockClear();
    hooks.refetchInspection.mockClear();
    render(direct());
    expect(hooks.session).toHaveBeenLastCalledWith(
      '',
      '',
      expect.objectContaining({ enabled: false }),
    );
    const inspect = screen.getByRole('button', { name: 'Inspect tool result' });
    inspect.focus();
    fireEvent.click(inspect);
    expect(hooks.attach).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(hooks.refetchInspection).toHaveBeenCalledWith({
        cancelRefetch: false,
      }),
    );
    expect(hooks.session).toHaveBeenLastCalledWith(
      'source-session',
      'exact-result',
      expect.objectContaining({
        enabled: true,
        requestScope: {
          apiBase: 'http://station.test',
          authorityKey: JSON.stringify([
            'connection',
            'runtime:1',
            4,
            'available',
          ]),
        },
      }),
    );
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Tool result' }), {
      key: 'Escape',
    });
    await waitFor(() => expect(document.activeElement).toBe(inspect));
  });

  test('keeps a direct result only in the explicitly picked Task', async () => {
    hooks.attach.mockReset();
    hooks.taskChoices.mockClear();
    hooks.attach.mockResolvedValue({});
    render(direct());
    fireEvent.click(
      screen.getByRole('button', { name: 'Keep this tool result in a Task' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Chosen Task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Task' }));
    expect(hooks.taskChoices).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({
        enabled: true,
        requestScope: {
          apiBase: 'http://station.test',
          authorityKey: JSON.stringify([
            'connection',
            'runtime:1',
            4,
            'available',
          ]),
        },
      }),
    );
    await waitFor(() =>
      expect(hooks.attach).toHaveBeenCalledWith({
        taskId: 'chosen-task',
        sessionId: 'source-session',
        eventId: 'exact-result',
        sourceSurface: 'nativeBasis',
      }),
    );
  });

  test('keeps a task-bound result in its exact Task and shows only canonical kept state', () => {
    hooks.attach.mockReset();
    hooks.attach.mockResolvedValue({});
    hooks.kept = [];
    render(
      <ConnectedStationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'exact-task',
          answerReferenceId: 'answer',
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep in Task' }));
    expect(hooks.attach).toHaveBeenCalledWith({
      taskId: 'exact-task',
      sessionId: 'source-session',
      eventId: 'exact-result',
      sourceSurface: 'nativeBasis',
    });
    expect(hooks.attachOptions).toEqual(
      expect.objectContaining({
        requestScope: expect.objectContaining({
          apiBase: 'http://station.test',
        }),
      }),
    );
  });

  test('shows a reopened task-answer kept marker only for the exact reauthorized ref', () => {
    hooks.kept = [
      {
        id: 'kept-link',
        state: 'available',
        ref: {
          authority: '@kontourai/thread',
          schemaVersion: '1.2.0',
          kind: 'result',
          threadId: 'source-session',
          resultId: 'exact-result',
        },
        result: {},
      },
    ];
    hooks.keptError = null;
    const view = render(
      <ConnectedStationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'exact-task',
          answerReferenceId: 'answer',
        }}
      />,
    );
    const keptAction = screen.getByRole('button', { name: 'Kept' });
    expect(keptAction.getAttribute('aria-disabled')).toBe('true');
    const previousWrites = hooks.attach.mock.calls.length;
    fireEvent.click(keptAction);
    expect(hooks.attach).toHaveBeenCalledTimes(previousWrites);
    hooks.kept = [];
    hooks.keptError = new Error('revoked');
    view.rerender(
      <ConnectedStationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'exact-task',
          answerReferenceId: 'answer',
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Kept' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Unable to verify');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  test('restores a Keep focus to Inspect when the fresh result is already kept', async () => {
    hooks.kept = [
      {
        id: 'kept-link',
        state: 'available',
        ref: {
          authority: '@kontourai/thread',
          schemaVersion: '1.2.0',
          kind: 'result',
          threadId: 'source-session',
          resultId: 'exact-result',
        },
        result: {},
      },
    ];
    hooks.keptError = null;
    hooks.focusRestore = 'keep';
    try {
      render(
        <ConnectedStationBasisPane
          scope={{
            kind: 'task-answer',
            taskId: 'exact-task',
            answerReferenceId: 'answer',
          }}
        />,
      );
      const kept = screen.getByRole('button', { name: 'Kept' });
      expect((kept as HTMLButtonElement).disabled).toBe(false);
      expect(kept.getAttribute('aria-disabled')).toBe('true');
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Inspect tool result' }),
        ),
      );
    } finally {
      hooks.focusRestore = undefined;
      hooks.kept = [];
    }
  });

  test('keeps pending Keep focus without permitting a second mutation', () => {
    hooks.kept = [];
    hooks.keptError = null;
    hooks.attach.mockClear();
    const pane = (
      <ConnectedStationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'exact-task',
          answerReferenceId: 'answer',
        }}
      />
    );
    const view = render(pane);
    const keep = screen.getByRole('button', { name: 'Keep in Task' });
    keep.focus();
    hooks.pending = true;
    try {
      view.rerender(
        <ConnectedStationBasisPane
          scope={{
            kind: 'task-answer',
            taskId: 'exact-task',
            answerReferenceId: 'answer',
          }}
        />,
      );
      expect(document.activeElement).toBe(keep);
      expect((keep as HTMLButtonElement).disabled).toBe(false);
      expect(keep.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(keep);
      expect(hooks.attach).not.toHaveBeenCalled();
    } finally {
      hooks.pending = false;
    }
  });

  test('does not steal a focus the user moved outside the refreshed actions', () => {
    hooks.focusRestore = undefined;
    const view = render(direct());
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    hooks.focusRestore = 'inspect';
    try {
      view.rerender(direct());
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      hooks.focusRestore = undefined;
      elsewhere.remove();
    }
  });

  test('contains a failed exact-task keep instead of leaving an unhandled completion', async () => {
    hooks.attach.mockReset();
    hooks.attach.mockRejectedValue(new Error('denied'));
    hooks.kept = [];
    hooks.keptError = null;
    render(
      <ConnectedStationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'exact-task',
          answerReferenceId: 'answer',
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep in Task' }));
    expect(
      await screen.findByText(
        'Unable to keep this result in the Task. Try again.',
      ),
    ).toBeTruthy();
  });

  test('renders safe text inertly and removes it when a mounted read is revoked', () => {
    hooks.inspection = {
      data: {
        resultId: 'exact-result',
        name: 'Tool',
        terminalStatus: 'success',
        content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }],
        truncated: false,
        omittedParts: 0,
        omittedTextBytes: 0,
        omittedMetadataBytes: 0,
        authorityDecision: {
          decision: 'denied',
          authority: '@kontourai/thread',
          policyId: 'tool-policy',
        },
      },
      error: null,
      isLoading: false,
      refetch: hooks.refetchInspection,
    };
    const view = render(direct());
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect tool result' }),
    );
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText('Omitted parts')).toBeTruthy();
    expect(
      screen.getByText(
        'Authority decision: denied by @kontourai/thread (policy tool-policy)',
      ),
    ).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    hooks.inspection = {
      data: undefined,
      error: new Error('revoked'),
      isLoading: false,
      refetch: hooks.refetchInspection,
    };
    view.rerender(direct());
    expect(screen.queryByText('<img src=x onerror=alert(1)>')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('unavailable');
  });

  test('closes the captured inspector when its pane occurrence changes or unmounts', () => {
    hooks.attach.mockReset();
    hooks.inspection = {
      data: undefined,
      error: null,
      isLoading: false,
      refetch: hooks.refetchInspection,
    };
    const view = render(direct('first-session'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect tool result' }),
    );
    expect(screen.getByRole('dialog', { name: 'Tool result' })).toBeTruthy();
    view.rerender(direct('second-session'));
    expect(screen.queryByRole('dialog', { name: 'Tool result' })).toBeNull();
    view.unmount();
    expect(hooks.attach).not.toHaveBeenCalled();
  });
});
