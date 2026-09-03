/** @vitest-environment jsdom */

import { toWorkspacePaneInstanceId } from '@kontourai/station-contracts/workspace-pane';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discovery: {
    data: {
      kind: 'existing',
      capabilities: { documentRead: true, documentWrite: true },
    },
    isLoading: false,
  },
  document: {
    data: { kind: 'snapshot', revision: 'revision-1', text: 'shared base' },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  },
  plan: vi.fn(),
  batch: vi.fn(),
  adoptCommitted: vi.fn(),
  refetchAuthoritative: vi.fn(),
  queryClient: { setQueryData: vi.fn(), fetchQuery: vi.fn() },
  command: vi.fn(),
  stream: 'live' as 'live' | 'terminal',
  documentListener: undefined as
    | ((document: {
        kind: 'snapshot' | 'delta';
        revision: string;
        text: string;
      }) => void)
    | undefined,
}));

vi.mock('@kontourai/station-sdk/project-task-rooms', () => ({
  adoptCommittedProjectTaskRoomDocument: mocks.adoptCommitted,
  refetchAuthoritativeProjectTaskRoomDocument: mocks.refetchAuthoritative,
  useProjectTaskRoomDiscoveryQuery: () => mocks.discovery,
  useProjectTaskRoomDocumentQuery: () => mocks.document,
  usePlanProjectTaskRoomEditMutation: () => ({
    isPending: false,
    mutateAsync: mocks.plan,
  }),
  useSubmitProjectTaskRoomBatchMutation: () => ({
    isPending: false,
    mutateAsync: mocks.batch,
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mocks.queryClient,
}));
vi.mock('../workspace-panes/ProjectTaskRoomContext', () => ({
  useProjectTaskRoomContext: () => ({
    taskId: 'task-1',
    discovery: mocks.discovery,
    stream: mocks.stream,
    live: { panes: [], cursors: [] },
    command: mocks.command,
    commandPending: false,
    subscribeDocument: (
      listener: NonNullable<typeof mocks.documentListener>,
    ) => {
      mocks.documentListener = listener;
      return () => {
        if (mocks.documentListener === listener)
          mocks.documentListener = undefined;
      };
    },
  }),
}));

import { navigationStore } from '../contexts/navigation-store';
import {
  type InteractiveWorkspacePerformanceProductMark,
  subscribeInteractiveWorkspacePerformanceMarks,
} from '../performance/interactive-workspace-performance-hooks';
import { TaskRoomEditorPane } from '../workspace-panes/TaskRoomEditorPane';
import { WorkspacePaneHostRuntime } from '../workspace-panes/workspacePaneHostRuntime';

function planned() {
  return {
    kind: 'planned',
    intentId: 'server-intent-1',
    digest: 'a'.repeat(64),
    optimistic: {},
    selection: { anchor: 5, focus: 5 },
    operationCount: 1,
  };
}

function editor() {
  return screen.getByRole('textbox', { name: 'Task document' });
}

function changeDraft(value = 'local draft') {
  fireEvent.change(editor(), { target: { value } });
}

beforeEach(() => {
  mocks.discovery.data = {
    kind: 'existing',
    capabilities: { documentRead: true, documentWrite: true },
  };
  mocks.discovery.isLoading = false;
  mocks.document.data = {
    kind: 'snapshot',
    revision: 'revision-1',
    text: 'shared base',
  };
  mocks.document.isLoading = false;
  mocks.document.isFetching = false;
  mocks.document.isError = false;
  mocks.document.refetch.mockReset();
  mocks.document.refetch.mockResolvedValue({ data: undefined });
  mocks.plan.mockReset();
  mocks.batch.mockReset();
  mocks.adoptCommitted.mockReset();
  mocks.adoptCommitted.mockReturnValue({
    kind: 'snapshot',
    revision: 'revision-2',
    text: 'server settled',
  });
  mocks.refetchAuthoritative.mockReset();
  mocks.refetchAuthoritative.mockResolvedValue({
    kind: 'snapshot',
    revision: 'revision-2',
    text: 'server settled',
  });
  mocks.command.mockReset();
  mocks.command.mockResolvedValue({ kind: 'available' });
  mocks.stream = 'live';
  mocks.documentListener = undefined;
});

describe('TaskRoomEditorPane', () => {
  test('marks the real input handler and exact React layout commit', async () => {
    const marks: unknown[] = [];
    const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks((event) =>
      marks.push(event),
    );
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('marked draft');
    await waitFor(() =>
      expect(marks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'task-input',
            mark: expect.objectContaining({
              taskId: 'task-1',
              workingRevision: 'revision-1',
              text: 'marked draft',
            }),
          }),
          expect.objectContaining({
            kind: 'task-commit',
            mark: expect.objectContaining({
              taskId: 'task-1',
              workingRevision: 'revision-1',
              text: 'marked draft',
            }),
          }),
        ]),
      ),
    );
    unsubscribe();
  });

  test('does not commit a new authoritative revision with stale rendered text', async () => {
    const marks: InteractiveWorkspacePerformanceProductMark[] = [];
    const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks((event) =>
      marks.push(event),
    );
    const { rerender } = render(<TaskRoomEditorPane taskId="task-1" />);
    await waitFor(() =>
      expect((editor() as HTMLTextAreaElement).value).toBe('shared base'),
    );
    marks.splice(0);

    mocks.document.data = {
      kind: 'delta',
      revision: 'revision-2',
      text: 'authoritative next',
    };
    rerender(<TaskRoomEditorPane taskId="task-1" />);
    await waitFor(() =>
      expect(
        marks.some(
          (event) =>
            event.kind === 'task-commit' &&
            event.mark.workingRevision === 'revision-2',
        ),
      ).toBe(true),
    );

    const relevant = marks.filter(
      (event) =>
        (event.kind === 'task-apply' || event.kind === 'task-commit') &&
        event.mark.workingRevision === 'revision-2',
    );
    expect(relevant[0]?.kind).toBe('task-apply');
    expect(relevant.filter((event) => event.kind === 'task-commit')).toEqual([
      expect.objectContaining({
        mark: expect.objectContaining({ text: 'authoritative next' }),
      }),
    ]);
    unsubscribe();
  });

  test('commits a parsed stream document without waiting for query notification', async () => {
    const marks: InteractiveWorkspacePerformanceProductMark[] = [];
    const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks((event) =>
      marks.push(event),
    );
    render(<TaskRoomEditorPane taskId="task-1" />);
    await waitFor(() => expect(mocks.documentListener).toBeDefined());
    marks.splice(0);

    act(() =>
      mocks.documentListener?.({
        kind: 'delta',
        revision: 'revision-stream',
        text: 'stream applied',
      }),
    );

    await waitFor(() =>
      expect((editor() as HTMLTextAreaElement).value).toBe('stream applied'),
    );
    expect(mocks.document.data.revision).toBe('revision-1');
    const relevant = marks.filter(
      (event) =>
        (event.kind === 'task-apply' || event.kind === 'task-commit') &&
        event.mark.workingRevision === 'revision-stream',
    );
    expect(relevant.map((event) => event.kind)).toEqual([
      'task-apply',
      'task-commit',
    ]);
    unsubscribe();
  });

  test.each([
    {
      label: 'gap',
      data: { kind: 'gap', floor: 'revision-stream' },
      isError: false,
      status: 'The shared document is stale. Resync before editing.',
    },
    {
      label: 'unavailable',
      data: { kind: 'unavailable' },
      isError: false,
      status: 'The shared document is unavailable. Editing is disabled.',
    },
    {
      label: 'failed read',
      data: {
        kind: 'snapshot',
        revision: 'revision-before-failure',
        text: 'older query text',
      },
      isError: true,
      status:
        'The shared document could not be loaded. Editing is disabled until a successful resync.',
    },
  ])(
    'keeps stream text visible but revokes edit/save authority after $label query truth',
    async ({ data, isError, status }) => {
      const rendered = render(<TaskRoomEditorPane taskId="task-1" />);
      await waitFor(() => expect(mocks.documentListener).toBeDefined());
      act(() =>
        mocks.documentListener?.({
          kind: 'delta',
          revision: 'revision-stream',
          text: 'stream applied',
        }),
      );
      await waitFor(() =>
        expect((editor() as HTMLTextAreaElement).value).toBe('stream applied'),
      );
      expect((editor() as HTMLTextAreaElement).readOnly).toBe(false);

      mocks.document.data = data as never;
      mocks.document.isError = isError;
      rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);

      expect((editor() as HTMLTextAreaElement).value).toBe('stream applied');
      expect((editor() as HTMLTextAreaElement).readOnly).toBe(true);
      expect(screen.getByText(status)).toBeTruthy();
      const save = screen.getByRole('button', {
        name: 'Save shared document',
      });
      expect(save.matches(':disabled')).toBe(true);
      fireEvent.click(save);
      expect(mocks.plan).not.toHaveBeenCalled();
    },
  );

  test('guards browser Back and keeps the draft on cancel before replaying on confirm', async () => {
    navigationStore.navigate('/guard-back-origin');
    navigationStore.navigate('/guard-back-editor');
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('back draft');

    window.history.back();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/guard-back-editor'),
    );
    expect((editor() as HTMLTextAreaElement).value).toBe('back draft');

    window.history.back();
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/guard-back-origin'),
    );
  });

  test('guards browser Forward and keeps the draft on cancel before replaying on confirm', async () => {
    navigationStore.navigate('/guard-forward-editor');
    navigationStore.navigate('/guard-forward-target');
    window.history.back();
    await waitFor(() =>
      expect(window.location.pathname).toBe('/guard-forward-editor'),
    );
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('forward draft');

    window.history.forward();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/guard-forward-editor'),
    );
    expect((editor() as HTMLTextAreaElement).value).toBe('forward draft');

    window.history.forward();
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/guard-forward-target'),
    );
  });

  test('uses one dirty guard for beforeunload, pane close, and cancel/confirm navigation', async () => {
    window.history.replaceState({}, '', '/projects/station');
    window.dispatchEvent(new PopStateEvent('popstate'));
    const runtime = new WorkspacePaneHostRuntime();
    const paneId = toWorkspacePaneInstanceId('pane-1');
    runtime.register(paneId, {
      mount: () => undefined,
      suspend: () => undefined,
      resume: () => undefined,
      dispose: () => undefined,
    });
    render(
      <TaskRoomEditorPane
        taskId="task-1"
        runtime={runtime}
        instanceId={paneId}
      />,
    );
    changeDraft('guarded draft');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await expect(runtime.requestClose(paneId)).resolves.toEqual({
      status: 'confirm',
      reason: 'dirty',
    });

    navigationStore.navigate('/activity');
    expect(window.location.pathname).toBe('/projects/station');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(window.location.pathname).toBe('/projects/station');
    navigationStore.navigate('/activity');
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(window.location.pathname).toBe('/activity'));
  });

  test('settles unchanged without submitting and clears dirty state', async () => {
    mocks.plan.mockResolvedValue({ kind: 'unchanged' });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft();
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    expect(
      await screen.findByText(
        'No changes were needed; your draft already matches the shared document.',
      ),
    ).toBeTruthy();
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(editor().getAttribute('value')).toBeNull();
    expect((editor() as HTMLTextAreaElement).value).toBe('local draft');
    expect(
      screen
        .getByRole('button', { name: 'Save shared document' })
        .matches(':disabled'),
    ).toBe(true);
  });

  test('retains a refused draft and offers an ordinary retry', async () => {
    mocks.plan.mockResolvedValue({
      kind: 'refused',
      reason: 'Room policy changed',
    });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('refused draft');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Room policy changed Draft retained; the shared document was not changed.',
    );
    expect((editor() as HTMLTextAreaElement).value).toBe('refused draft');
    expect(screen.getByRole('button', { name: 'Retry save' })).toBeTruthy();
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  test.each(['committed', 'duplicate'] as const)(
    'adopts exact %s settled text and clears the draft',
    async (kind) => {
      mocks.plan.mockResolvedValue(planned());
      mocks.batch.mockResolvedValue({
        kind,
        revision: 'revision-2',
        text: 'server settled',
      });
      if (kind === 'duplicate')
        mocks.refetchAuthoritative.mockResolvedValue({
          kind: 'snapshot',
          revision: 'revision-2',
          text: 'server settled',
        });
      render(<TaskRoomEditorPane taskId="task-1" />);
      changeDraft();
      fireEvent.click(
        screen.getByRole('button', { name: 'Save shared document' }),
      );
      await waitFor(() =>
        expect((editor() as HTMLTextAreaElement).value).toBe('server settled'),
      );
      expect(
        screen.getByText(
          kind === 'committed'
            ? 'Shared document saved.'
            : 'This exact edit was already saved.',
        ),
      ).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Retry identical batch' }),
      ).toBeNull();
      expect(mocks.refetchAuthoritative).toHaveBeenCalledTimes(
        kind === 'duplicate' ? 1 : 0,
      );
    },
  );

  test('does not let an older duplicate receipt overwrite a newer converged document', async () => {
    mocks.plan.mockResolvedValue(planned());
    mocks.batch.mockResolvedValue({
      kind: 'duplicate',
      revision: 'revision-2',
      text: 'older receipt text',
    });
    mocks.refetchAuthoritative.mockResolvedValue({
      kind: 'snapshot',
      revision: 'revision-3',
      text: 'newer converged text',
    });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('possibly saved');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    await waitFor(() =>
      expect((editor() as HTMLTextAreaElement).value).toBe(
        'newer converged text',
      ),
    );
    expect(mocks.adoptCommitted).not.toHaveBeenCalled();
    expect(mocks.refetchAuthoritative).toHaveBeenCalledWith(
      mocks.queryClient,
      'task-1',
    );
    expect(screen.getByText('This exact edit was already saved.')).toBeTruthy();
  });

  test('committed settlement falls back to a no-cache authoritative read for a cache gap', async () => {
    mocks.plan.mockResolvedValue(planned());
    mocks.batch.mockResolvedValue({
      kind: 'committed',
      revision: 'revision-2',
      text: 'commit receipt',
    });
    mocks.adoptCommitted.mockReturnValue(undefined);
    mocks.refetchAuthoritative.mockResolvedValue({
      kind: 'delta',
      revision: 'revision-3',
      text: 'resynced document',
    });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft();
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );

    await waitFor(() =>
      expect((editor() as HTMLTextAreaElement).value).toBe('resynced document'),
    );
    expect(mocks.refetchAuthoritative).toHaveBeenCalledWith(
      mocks.queryClient,
      'task-1',
    );
  });

  test('failed authoritative recovery preserves the draft and exact retry custody', async () => {
    mocks.plan.mockResolvedValue(planned());
    mocks.batch.mockResolvedValue({
      kind: 'duplicate',
      revision: 'revision-2',
      text: 'older receipt text',
    });
    mocks.refetchAuthoritative.mockRejectedValue(new Error('read failed'));
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('possibly saved');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );

    expect(
      await screen.findByRole('button', { name: 'Retry identical batch' }),
    ).toBeTruthy();
    expect((editor() as HTMLTextAreaElement).value).toBe('possibly saved');
    expect(screen.queryByText('This exact edit was already saved.')).toBeNull();
    expect(mocks.refetchAuthoritative).toHaveBeenCalledWith(
      mocks.queryClient,
      'task-1',
    );
  });

  test('gap recovery preserves the draft and exact retry custody', async () => {
    mocks.plan.mockResolvedValue(planned());
    mocks.batch.mockResolvedValue({
      kind: 'duplicate',
      revision: 'revision-2',
      text: 'older receipt text',
    });
    mocks.refetchAuthoritative.mockResolvedValue({
      kind: 'gap',
      floor: 'rev2',
    });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('gap custody draft');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );

    expect(
      await screen.findByRole('button', { name: 'Retry identical batch' }),
    ).toBeTruthy();
    expect((editor() as HTMLTextAreaElement).value).toBe('gap custody draft');
    expect(screen.queryByText('This exact edit was already saved.')).toBeNull();
  });

  test.each([
    { label: 'planned', result: planned() },
    { label: 'refused', result: { kind: 'refused', reason: 'old task' } },
  ])('does not use a pending $label plan after A to B', async ({ result }) => {
    let settlePlan: ((value: typeof result) => void) | undefined;
    mocks.plan.mockImplementation(
      () =>
        new Promise((resolve) => {
          settlePlan = resolve;
        }),
    );
    const rendered = render(<TaskRoomEditorPane taskId="task-a" />);
    changeDraft('task a draft');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    await waitFor(() => expect(mocks.plan).toHaveBeenCalledTimes(1));

    mocks.document.data = {
      kind: 'snapshot',
      revision: 'task-b-revision',
      text: 'task b document',
    };
    rendered.rerender(<TaskRoomEditorPane taskId="task-b" />);
    settlePlan?.(result);
    await Promise.resolve();

    expect(mocks.batch).not.toHaveBeenCalled();
    expect((editor() as HTMLTextAreaElement).value).toBe('task b document');
    expect(screen.queryByText(/old task/)).toBeNull();
  });

  test('does not use a pending plan after A to B to A', async () => {
    let settlePlan: ((value: ReturnType<typeof planned>) => void) | undefined;
    mocks.plan.mockImplementation(
      () =>
        new Promise((resolve) => {
          settlePlan = resolve;
        }),
    );
    const rendered = render(<TaskRoomEditorPane taskId="task-a" />);
    changeDraft('abandoned task a draft');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    await waitFor(() => expect(mocks.plan).toHaveBeenCalledTimes(1));

    mocks.document.data = {
      kind: 'snapshot',
      revision: 'task-b-revision',
      text: 'task b document',
    };
    rendered.rerender(<TaskRoomEditorPane taskId="task-b" />);
    mocks.document.data = {
      kind: 'snapshot',
      revision: 'task-a-next-revision',
      text: 'fresh task a document',
    };
    rendered.rerender(<TaskRoomEditorPane taskId="task-a" />);
    settlePlan?.(planned());
    await Promise.resolve();

    expect(mocks.batch).not.toHaveBeenCalled();
    expect((editor() as HTMLTextAreaElement).value).toBe(
      'fresh task a document',
    );
  });

  test.each(['switches task', 'unmounts'] as const)(
    'does not adopt a settled old-task response after it %s',
    async (lifecycle) => {
      let settleBatch:
        | ((value: {
            kind: 'committed';
            revision: string;
            text: string;
          }) => void)
        | undefined;
      mocks.plan.mockResolvedValue(planned());
      mocks.batch.mockImplementation(
        () =>
          new Promise((resolve) => {
            settleBatch = resolve;
          }),
      );
      const rendered = render(<TaskRoomEditorPane taskId="task-1" />);
      changeDraft('old-task draft');
      fireEvent.click(
        screen.getByRole('button', { name: 'Save shared document' }),
      );
      await waitFor(() => expect(mocks.batch).toHaveBeenCalledTimes(1));

      if (lifecycle === 'switches task') {
        mocks.document.data = {
          kind: 'snapshot',
          revision: 'task-2-revision',
          text: 'task two document',
        };
        rendered.rerender(<TaskRoomEditorPane taskId="task-2" />);
      } else rendered.unmount();
      settleBatch?.({
        kind: 'committed',
        revision: 'revision-2',
        text: 'old-task settled',
      });
      await Promise.resolve();

      expect(mocks.adoptCommitted).not.toHaveBeenCalled();
      expect(mocks.refetchAuthoritative).not.toHaveBeenCalled();
      if (lifecycle === 'switches task') {
        await waitFor(() =>
          expect((editor() as HTMLTextAreaElement).value).toBe(
            'task two document',
          ),
        );
        expect(screen.queryByText(/may have taken effect/i)).toBeNull();
      }
    },
  );

  test('keeps an indeterminate receipt for identical retry, then adopts duplicate truth', async () => {
    mocks.plan.mockResolvedValue(planned());
    mocks.batch
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({
        kind: 'duplicate',
        revision: 'revision-2',
        text: 'settled after retry',
      });
    mocks.refetchAuthoritative.mockResolvedValue({
      kind: 'snapshot',
      revision: 'revision-2',
      text: 'settled after retry',
    });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('possibly saved');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    const retry = await screen.findByRole('button', {
      name: 'Retry identical batch',
    });
    expect(screen.getByText(/may have taken effect/i)).toBeTruthy();
    expect((editor() as HTMLTextAreaElement).value).toBe('possibly saved');
    fireEvent.click(retry);
    await waitFor(() =>
      expect((editor() as HTMLTextAreaElement).value).toBe(
        'settled after retry',
      ),
    );
    expect(mocks.batch).toHaveBeenNthCalledWith(2, {
      intentId: 'server-intent-1',
      intentDigest: 'a'.repeat(64),
    });
  });

  test('does not submit a plan that resolves after authorization becomes terminal', async () => {
    let settlePlan: ((value: ReturnType<typeof planned>) => void) | undefined;
    mocks.plan.mockImplementation(
      () =>
        new Promise((resolve) => {
          settlePlan = resolve;
        }),
    );
    const rendered = render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('terminal plan draft');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    await waitFor(() => expect(mocks.plan).toHaveBeenCalledTimes(1));

    mocks.stream = 'terminal';
    rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);
    settlePlan?.(planned());
    await Promise.resolve();

    expect(mocks.batch).not.toHaveBeenCalled();
    expect((editor() as HTMLTextAreaElement).value).toBe('terminal plan draft');
    expect(
      screen.getByText(
        'Task room authorization ended. The last readable document remains read-only.',
      ),
    ).toBeTruthy();
  });

  test('does not submit a plan after authorization transitions terminal to live', async () => {
    let settlePlan: ((value: ReturnType<typeof planned>) => void) | undefined;
    mocks.plan.mockImplementation(
      () =>
        new Promise((resolve) => {
          settlePlan = resolve;
        }),
    );
    const rendered = render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('authorization ABA draft');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    await waitFor(() => expect(mocks.plan).toHaveBeenCalledTimes(1));

    mocks.stream = 'terminal';
    rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);
    mocks.stream = 'live';
    rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);
    settlePlan?.(planned());
    await Promise.resolve();

    expect(mocks.batch).not.toHaveBeenCalled();
    expect((editor() as HTMLTextAreaElement).value).toBe(
      'authorization ABA draft',
    );
  });

  test('retries retained exact custody after authorization returns live', async () => {
    mocks.plan.mockResolvedValue(planned());
    mocks.batch
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({
        kind: 'duplicate',
        revision: 'revision-2',
        text: 'retried truth',
      });
    mocks.refetchAuthoritative.mockResolvedValue({
      kind: 'snapshot',
      revision: 'revision-2',
      text: 'retried truth',
    });
    const rendered = render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('retained draft');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    const retry = await screen.findByRole('button', {
      name: 'Retry identical batch',
    });

    mocks.stream = 'terminal';
    rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);
    expect(retry.matches(':disabled')).toBe(true);
    mocks.stream = 'live';
    rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);
    const resumedRetry = screen.getByRole('button', {
      name: 'Retry identical batch',
    });
    expect(resumedRetry.matches(':disabled')).toBe(false);
    fireEvent.click(resumedRetry);

    await waitFor(() =>
      expect((editor() as HTMLTextAreaElement).value).toBe('retried truth'),
    );
    expect(mocks.batch).toHaveBeenCalledTimes(2);
  });

  test('blocks ordinary save while an exact batch remains in custody', async () => {
    mocks.plan.mockResolvedValue(planned());
    mocks.batch.mockResolvedValue({ kind: 'unavailable' });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('first exact draft');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    await screen.findByRole('button', { name: 'Retry identical batch' });
    changeDraft('new ordinary draft');

    const save = screen.getByRole('button', { name: 'Save shared document' });
    expect(save.matches(':disabled')).toBe(true);
    fireEvent.click(save);
    expect(mocks.plan).toHaveBeenCalledTimes(1);
    expect(mocks.batch).toHaveBeenCalledTimes(1);
  });

  test('keeps batch custody but cannot adopt or retry after authorization becomes terminal', async () => {
    let settleBatch:
      | ((value: { kind: 'committed'; revision: string; text: string }) => void)
      | undefined;
    mocks.plan.mockResolvedValue(planned());
    mocks.batch.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleBatch = resolve;
        }),
    );
    const rendered = render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('terminal batch draft');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledTimes(1));

    mocks.stream = 'terminal';
    rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);
    settleBatch?.({
      kind: 'committed',
      revision: 'revision-2',
      text: 'must not adopt',
    });
    await Promise.resolve();

    expect(mocks.adoptCommitted).not.toHaveBeenCalled();
    expect(mocks.refetchAuthoritative).not.toHaveBeenCalled();
    expect((editor() as HTMLTextAreaElement).value).toBe(
      'terminal batch draft',
    );
    expect(
      screen
        .getByRole('button', { name: 'Retry identical batch' })
        .matches(':disabled'),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry identical batch' }),
    );
    expect(mocks.batch).toHaveBeenCalledTimes(1);
  });

  test('a rejected batch retains the draft but removes indeterminate retry', async () => {
    mocks.plan.mockResolvedValue(planned());
    mocks.batch.mockResolvedValue({
      kind: 'rejected',
      reason: 'Stale edit plan',
    });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('stale draft');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Stale edit plan',
    );
    expect((editor() as HTMLTextAreaElement).value).toBe('stale draft');
    expect(
      screen.queryByRole('button', { name: 'Retry identical batch' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry save' })).toBeTruthy();
  });

  test('states readable read-only and failed-read modes truthfully', () => {
    mocks.discovery.data = {
      kind: 'existing',
      capabilities: { documentRead: true, documentWrite: false },
    };
    const { rerender } = render(<TaskRoomEditorPane taskId="task-1" />);
    expect(
      screen.getByText('The shared document is readable and read-only.'),
    ).toBeTruthy();
    expect((editor() as HTMLTextAreaElement).readOnly).toBe(true);

    mocks.document.isError = true;
    rerender(<TaskRoomEditorPane taskId="task-1" />);
    expect(screen.getByRole('alert').textContent).toBe(
      'The latest shared document read failed.',
    );
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  });

  test('keeps the last readable document visible and blocks writes after stream revocation', () => {
    mocks.stream = 'terminal';
    render(<TaskRoomEditorPane taskId="task-1" />);
    expect(
      screen.getByText(
        'Task room authorization ended. The last readable document remains read-only.',
      ),
    ).toBeTruthy();
    expect((editor() as HTMLTextAreaElement).value).toBe('shared base');
    expect((editor() as HTMLTextAreaElement).readOnly).toBe(true);
    expect(
      screen
        .getByRole('button', { name: 'Save shared document' })
        .matches(':disabled'),
    ).toBe(true);
  });

  test('does not apply a query notification that arrives after stream revocation', async () => {
    const rendered = render(<TaskRoomEditorPane taskId="task-1" />);
    await waitFor(() =>
      expect((editor() as HTMLTextAreaElement).value).toBe('shared base'),
    );
    mocks.stream = 'terminal';
    rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);
    mocks.document.data = {
      kind: 'snapshot',
      revision: 'revision-after-revocation',
      text: 'must not apply',
    };
    rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);

    expect((editor() as HTMLTextAreaElement).value).toBe('shared base');
    expect((editor() as HTMLTextAreaElement).readOnly).toBe(true);
  });
});
