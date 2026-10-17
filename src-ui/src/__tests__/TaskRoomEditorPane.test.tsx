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
import { WorkspacePaneHostRuntime } from '../workspace-panes/workspacePaneHostRuntime';

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
  queryClient: {
    setQueryData: vi.fn(),
    fetchQuery: vi.fn(),
    getQueryData: vi.fn(),
  },
  command: vi.fn(),
  stream: 'live' as 'live' | 'terminal',
  liveGeneration: undefined as string | undefined,
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
  projectTaskRoomQueries: {
    document: (taskId: string) => ({
      queryKey: ['task-room-document', taskId],
    }),
  },
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
    live: { panes: [], cursors: [], generation: mocks.liveGeneration },
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
  return screen.getByRole('textbox', { name: 'Task brief' });
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
  mocks.queryClient.getQueryData
    .mockReset()
    .mockImplementation(() => mocks.document.data);
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
  mocks.liveGeneration = undefined;
  mocks.documentListener = undefined;
});

describe('TaskRoomEditorPane', () => {
  test('the Brief display renders Markdown and explicitly enters the same live editor', async () => {
    await import('../components/chat/MarkdownRenderer');
    mocks.document.data.text = '## Goal\nA useful shared plan';
    render(<TaskRoomEditorPane taskId="task-1" startInPreview />);
    expect(await screen.findByRole('heading', { name: 'Goal' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Task brief' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit brief' }));
    expect((editor() as HTMLTextAreaElement).value).toBe(
      mocks.document.data.text,
    );
  });

  test('autosaves without a Save gesture and retains typing during an in-flight commit', async () => {
    let settle!: (value: unknown) => void;
    mocks.plan.mockResolvedValue(planned());
    mocks.batch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('first draft');
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledOnce());
    changeDraft('latest draft');
    await act(async () =>
      settle({
        kind: 'committed',
        revision: 'revision-2',
        text: 'first draft',
      }),
    );
    expect((editor() as HTMLTextAreaElement).value).toBe('latest draft');
    expect(
      screen.queryByRole('button', { name: 'Save shared document' }),
    ).toBeNull();
  });

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
      fireEvent.blur(editor());
      expect(mocks.plan).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    'does not submit an in-flight plan after a document gap (recovered=%s)',
    async (recovered) => {
      let finishPlan!: (value: ReturnType<typeof planned>) => void;
      mocks.plan.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishPlan = resolve;
          }),
      );
      const rendered = render(<TaskRoomEditorPane taskId="task-1" />);
      changeDraft('pending gap draft');
      fireEvent.blur(editor());
      await waitFor(() => expect(mocks.plan).toHaveBeenCalledOnce());
      mocks.document.data = { kind: 'gap', floor: 'floor' } as never;
      rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);
      if (recovered) {
        mocks.document.data = {
          kind: 'snapshot',
          revision: 'new',
          text: 'new truth',
        };
        rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);
      }
      await act(async () => {
        finishPlan(planned());
      });
      expect(mocks.batch).not.toHaveBeenCalled();
      expect((editor() as HTMLTextAreaElement).readOnly).toBe(!recovered);
      expect((editor() as HTMLTextAreaElement).value).toBe('pending gap draft');
    },
  );

  test.each(['route', 'back', 'forward'])(
    'navigation flushes the pending brief before committing %s',
    async (direction) => {
      navigationStore.navigate('/brief-origin');
      navigationStore.navigate('/brief-editor');
      if (direction === 'forward') {
        navigationStore.navigate('/brief-destination');
        window.history.back();
        await waitFor(() =>
          expect(window.location.pathname).toBe('/brief-editor'),
        );
      }
      let settle!: (value: unknown) => void;
      mocks.plan.mockResolvedValue(planned());
      mocks.batch.mockImplementation(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      );
      mocks.adoptCommitted.mockReturnValue({
        kind: 'snapshot',
        revision: 'revision-2',
        text: 'navigation draft',
      });
      render(<TaskRoomEditorPane taskId="task-1" />);
      changeDraft('navigation draft');
      if (direction === 'route') navigationStore.navigate('/brief-destination');
      else if (direction === 'back') window.history.back();
      else window.history.forward();
      await waitFor(() => expect(mocks.batch).toHaveBeenCalledOnce());
      expect(window.location.pathname).toBe('/brief-editor');
      expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
      await act(async () =>
        settle({
          kind: 'committed',
          revision: 'revision-2',
          text: 'navigation draft',
        }),
      );
      await waitFor(() =>
        expect(window.location.pathname).toBe(
          direction === 'back' ? '/brief-origin' : '/brief-destination',
        ),
      );
    },
  );

  test('a pending save preserves guarded precommit navigation admission', async () => {
    navigationStore.navigate('/brief-precommit-editor');
    let settle!: (value: unknown) => void;
    mocks.plan.mockResolvedValue(planned());
    mocks.batch.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    mocks.adoptCommitted.mockReturnValue({
      kind: 'snapshot',
      revision: 'revision-2',
      text: 'precommit draft',
    });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('precommit draft');
    const prepare = vi.fn().mockResolvedValue(true);
    const navigation = navigationStore.navigateWithPrecommit(
      '/brief-precommit-destination',
      { current: () => true, prepare, signal: new AbortController().signal },
    );
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe('/brief-precommit-editor');
    await act(async () =>
      settle({
        kind: 'committed',
        revision: 'revision-2',
        text: 'precommit draft',
      }),
    );
    await expect(navigation).resolves.toBe(true);
    expect(window.location.pathname).toBe('/brief-precommit-destination');
    expect(prepare).toHaveBeenCalledOnce();
  });

  test('a rejected plan under co-editing refreshes and retries autosave without another gesture', async () => {
    mocks.plan
      .mockResolvedValueOnce({ kind: 'rejected', reason: 'document changed' })
      .mockResolvedValueOnce(planned());
    mocks.refetchAuthoritative.mockImplementation(async () => {
      mocks.document.data = {
        kind: 'snapshot',
        revision: 'revision-2',
        text: 'remote edit',
      };
      return mocks.document.data;
    });
    mocks.batch.mockResolvedValue({
      kind: 'committed',
      revision: 'revision-3',
      text: 'co-edit draft',
    });
    mocks.adoptCommitted.mockReturnValue({
      kind: 'snapshot',
      revision: 'revision-3',
      text: 'co-edit draft',
    });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('co-edit draft');
    fireEvent.blur(editor());
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledOnce(), {
      timeout: 4000,
    });
    expect(mocks.plan).toHaveBeenCalledTimes(2);
    expect((editor() as HTMLTextAreaElement).value).toBe('co-edit draft');
  });

  test('beforeunload flushes the pending save and protects the still-dirty host pane', async () => {
    const runtime = new WorkspacePaneHostRuntime();
    const paneId = toWorkspacePaneInstanceId('brief-pane');
    runtime.register(paneId, {
      mount: () => undefined,
      suspend: () => undefined,
      resume: () => undefined,
      dispose: () => undefined,
    });
    mocks.plan.mockResolvedValue(planned());
    mocks.batch.mockResolvedValue({
      kind: 'committed',
      revision: 'revision-2',
      text: 'flush draft',
    });
    mocks.adoptCommitted.mockReturnValue({
      kind: 'snapshot',
      revision: 'revision-2',
      text: 'flush draft',
    });
    render(
      <TaskRoomEditorPane
        taskId="task-1"
        runtime={runtime}
        instanceId={paneId}
      />,
    );
    changeDraft('flush draft');
    await expect(runtime.requestClose(paneId)).resolves.toEqual({
      status: 'confirm',
      reason: 'dirty',
    });
    const unload = new Event('beforeunload', { cancelable: true });
    fireEvent(window, unload);
    expect(mocks.plan).toHaveBeenCalledOnce();
    expect(unload.defaultPrevented).toBe(true);
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Saved'),
    );
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    fireEvent(window, cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
    await expect(runtime.requestClose(paneId)).resolves.toMatchObject({
      status: 'closed',
    });
  });

  test('persistent co-edit rejection stops after three automatic retries', async () => {
    vi.useFakeTimers();
    try {
      mocks.plan.mockResolvedValue({
        kind: 'rejected',
        reason: 'document changed',
      });
      mocks.refetchAuthoritative.mockResolvedValue(mocks.document.data);
      render(<TaskRoomEditorPane taskId="task-1" />);
      changeDraft('bounded retry draft');
      for (let step = 0; step < 14; step += 1)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
      expect(mocks.plan).toHaveBeenCalledTimes(4);
      expect(mocks.refetchAuthoritative).toHaveBeenCalledTimes(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(mocks.plan).toHaveBeenCalledTimes(4);
      expect(
        screen.getByRole('button', { name: 'Retry autosave' }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('settles unchanged without submitting and clears dirty state', async () => {
    mocks.plan.mockResolvedValue({ kind: 'unchanged' });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft();
    fireEvent.blur(editor());
    expect(
      await screen.findByText(
        'No changes were needed; your draft already matches the shared document.',
      ),
    ).toBeTruthy();
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(editor().getAttribute('value')).toBeNull();
    expect((editor() as HTMLTextAreaElement).value).toBe('local draft');
    expect(
      screen.queryByRole('button', { name: 'Save shared document' }),
    ).toBeNull();
  });

  test('retains a refused draft and offers an ordinary retry', async () => {
    mocks.plan.mockResolvedValue({
      kind: 'refused',
      reason: 'Room policy changed',
    });
    render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('refused draft');
    fireEvent.blur(editor());
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Room policy changed Draft retained; the shared document was not changed.',
    );
    expect((editor() as HTMLTextAreaElement).value).toBe('refused draft');
    expect(screen.getByRole('button', { name: 'Retry autosave' })).toBeTruthy();
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
      fireEvent.blur(editor());
      await waitFor(() =>
        expect((editor() as HTMLTextAreaElement).value).toBe('server settled'),
      );
      expect(
        screen.getByText(kind === 'committed' ? 'Saved' : 'Saved'),
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
    fireEvent.blur(editor());
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
    expect(screen.getByText('Saved')).toBeTruthy();
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
    fireEvent.blur(editor());

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
    fireEvent.blur(editor());

    expect(
      await screen.findByRole('button', { name: 'Retry identical batch' }),
    ).toBeTruthy();
    expect((editor() as HTMLTextAreaElement).value).toBe('possibly saved');
    expect(screen.queryByText('Saved')).toBeNull();
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
    fireEvent.blur(editor());

    expect(
      await screen.findByRole('button', { name: 'Retry identical batch' }),
    ).toBeTruthy();
    expect((editor() as HTMLTextAreaElement).value).toBe('gap custody draft');
    expect(screen.queryByText('Saved')).toBeNull();
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
    fireEvent.blur(editor());
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
    fireEvent.blur(editor());
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
      fireEvent.blur(editor());
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
    fireEvent.blur(editor());
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

  test('reconciles an identical retry when document recovery begins during submission', async () => {
    let finishRetry!: (value: unknown) => void;
    mocks.plan.mockResolvedValue(planned());
    mocks.batch
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRetry = resolve;
          }),
      );
    mocks.refetchAuthoritative.mockResolvedValue({
      kind: 'snapshot',
      revision: 'converged',
      text: 'concurrent truth',
    });
    const rendered = render(<TaskRoomEditorPane taskId="task-1" />);
    changeDraft('possibly committed');
    fireEvent.blur(editor());
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retry identical batch' }),
    );
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledTimes(2));
    mocks.document.data = { kind: 'unavailable' } as never;
    rendered.rerender(<TaskRoomEditorPane taskId="task-1" />);
    await act(async () =>
      finishRetry({
        kind: 'duplicate',
        revision: 'older',
        text: 'older receipt text',
      }),
    );
    expect(mocks.refetchAuthoritative).toHaveBeenCalledWith(
      mocks.queryClient,
      'task-1',
    );
    expect((editor() as HTMLTextAreaElement).value).toBe('concurrent truth');
    expect(
      screen.queryByRole('button', { name: 'Retry identical batch' }),
    ).toBeNull();
    // A readable response does not itself restore query/stream write authority.
    expect((editor() as HTMLTextAreaElement).readOnly).toBe(true);
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
    fireEvent.blur(editor());
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
    fireEvent.blur(editor());
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
    fireEvent.blur(editor());
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
    fireEvent.blur(editor());
    await screen.findByRole('button', { name: 'Retry identical batch' });
    changeDraft('new ordinary draft');

    fireEvent.blur(editor());
    expect(
      screen.queryByRole('button', { name: 'Save shared document' }),
    ).toBeNull();
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
    fireEvent.blur(editor());
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
    fireEvent.blur(editor());
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Stale edit plan',
    );
    expect((editor() as HTMLTextAreaElement).value).toBe('stale draft');
    expect(
      screen.queryByRole('button', { name: 'Retry identical batch' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry autosave' })).toBeTruthy();
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
      screen.queryByRole('button', { name: 'Save shared document' }),
    ).toBeNull();
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

test('cursor publication serializes requests, keeps only the latest pending selection, and stops on retirement', async () => {
  mocks.liveGeneration = 'generation';
  const completions: Array<(value: unknown) => void> = [];
  mocks.command.mockImplementation(
    () => new Promise((resolve) => completions.push(resolve)),
  );
  const view = render(<TaskRoomEditorPane taskId="task-1" />);
  const input = editor();
  fireEvent.select(input, { target: { selectionStart: 1, selectionEnd: 1 } });
  fireEvent.select(input, { target: { selectionStart: 2, selectionEnd: 2 } });
  fireEvent.select(input, { target: { selectionStart: 3, selectionEnd: 3 } });
  try {
    expect(mocks.command).toHaveBeenCalledTimes(1);
    await act(async () => completions.shift()!({ kind: 'available' }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledTimes(2));
    expect(mocks.command.mock.calls[1]![0]).toMatchObject({
      command: 'cursor',
      selection: { anchor: 3, focus: 3 },
    });
    fireEvent.select(input, { target: { selectionStart: 4, selectionEnd: 4 } });
    view.unmount();
    await act(async () => completions.shift()!({ kind: 'available' }));
    expect(mocks.command).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    for (const complete of completions) complete({ kind: 'available' });
  }
});
