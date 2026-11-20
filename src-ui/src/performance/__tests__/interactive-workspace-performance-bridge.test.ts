/** @vitest-environment jsdom */

import {
  formatInteractiveWorkspaceBatchTiming,
  INTERACTIVE_WORKSPACE_TIMING_RESPONSE_HEADER,
} from '@shared/interactive-workspace-performance-timing';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import referenceContract from '../../../../scripts/fixtures/interactive-workspace/performance-contract.json';
import {
  foregroundAttributionForPersistedHostDocumentRestoration,
  foregroundAttributionForProductMark,
  installInteractiveWorkspacePerformanceBridge,
  measureInteractiveWorkspace,
  observeFilePreviewFetches,
  observeProductMarks,
  observeReconnectMark,
  productMarkFailureCode,
  reconnectDriverStage,
} from '../interactive-workspace-performance-bridge';
import {
  browserEpochMs,
  emitDiffCommitPerformanceMark,
  emitFilePreviewCommitPerformanceMark,
  emitFilePreviewScrollPerformanceMark,
  emitReconnectStrategyPerformanceMark,
  emitTaskCommitPerformanceMark,
  emitTaskDocumentApplyPerformanceMark,
  emitTaskInputPerformanceMark,
} from '../interactive-workspace-performance-hooks';
import { WORK_BOARD_DRIVER_READY_EVENT } from '../work-board-performance-bridge';

const brief = vi.hoisted(() => ({
  document: {
    data: {
      kind: 'snapshot',
      revision: `swsr-v1:${'a'.repeat(64)}`,
      text: 'base',
    },
    isLoading: false,
    isError: false,
  },
  discovery: {
    data: {
      kind: 'existing',
      capabilities: { documentRead: true, documentWrite: true },
    },
    isLoading: false,
  },
  listener: undefined as
    | ((value: { kind: 'snapshot'; revision: string; text: string }) => void)
    | undefined,
  adopt: true,
  corruptBatch: false,
}));
vi.mock('@kontourai/station-sdk/project-task-rooms', () => ({
  projectTaskRoomQueries: { document: () => ({ queryKey: ['brief'] }) },
  useProjectTaskRoomDiscoveryQuery: () => brief.discovery,
  useProjectTaskRoomDocumentQuery: () => brief.document,
  usePlanProjectTaskRoomEditMutation: () => ({
    isPending: false,
    mutateAsync: async (input: unknown) =>
      (
        await (
          await window.fetch('/api/tasks/task-1/room/edit-plan', {
            method: 'POST',
            body: JSON.stringify(input),
          })
        ).json()
      ).data,
  }),
  useSubmitProjectTaskRoomBatchMutation: () => ({
    isPending: false,
    mutateAsync: async (input: { intentId: string; intentDigest: string }) =>
      (
        await (
          await window.fetch('/api/tasks/task-1/room/batches', {
            method: 'POST',
            body: JSON.stringify(
              brief.corruptBatch
                ? { ...input, intentId: 'foreign-intent' }
                : input,
            ),
          })
        ).json()
      ).data,
  }),
  adoptCommittedProjectTaskRoomDocument: (
    _client: unknown,
    _task: string,
    _observed: unknown,
    result: { revision: string; text: string },
  ) =>
    brief.adopt
      ? { kind: 'snapshot', revision: result.revision, text: result.text }
      : undefined,
  refetchAuthoritativeProjectTaskRoomDocument: async () => {
    throw new Error('fixture adoption unavailable');
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: () => brief.document.data }),
}));
vi.mock('../../workspace-panes/ProjectTaskRoomContext', () => ({
  useProjectTaskRoomContext: () => ({
    discovery: brief.discovery,
    stream: 'live',
    live: { panes: [], cursors: [] },
    command: async () => ({ kind: 'available' }),
    subscribeDocument: (listener: NonNullable<typeof brief.listener>) => {
      brief.listener = listener;
      return () => {
        brief.listener = undefined;
      };
    },
  }),
}));

import { TaskRoomEditorPane } from '../../workspace-panes/TaskRoomEditorPane';

afterEach(() => {
  cleanup();
  delete window.__stationInteractiveWorkspacePerformanceDriver;
  document.body.replaceChildren();
  delete window.__stationInteractiveWorkspacePerformance;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

test('installs the production bridge on the exact Project Work Board route', async () => {
  vi.stubEnv('VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE', '1');
  window.history.replaceState(
    {},
    '',
    '/projects/project-a/panes/pane%3Abuiltin%3Aworkspace-spatial-board/workspace-spatial-board%3Aproject-a?station-performance-reference=interactive-workspace-v3',
  );

  expect(installInteractiveWorkspacePerformanceBridge()).toBe(true);
  expect(window.__stationInteractiveWorkspacePerformance).toMatchObject({
    version: 1,
    measure: expect.any(Function),
  });
  const ready =
    window.__stationInteractiveWorkspacePerformance!.waitForBoardDriver();
  window.dispatchEvent(new Event(WORK_BOARD_DRIVER_READY_EVENT));
  await expect(ready).resolves.toBeUndefined();
});

test('does not install the production bridge on a bare Project route', () => {
  vi.stubEnv('VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE', '1');
  window.history.replaceState(
    {},
    '',
    '/projects/project-a?station-performance-reference=interactive-workspace-v3',
  );

  expect(installInteractiveWorkspacePerformanceBridge()).toBe(false);
});

test('emits raw v3 marks only from the shipped task editor and names unavailable fixtures', async () => {
  document.body.innerHTML = `
    <p role="status">Shared document ready.</p>
    <textarea aria-label="Task document"
      data-station-performance-surface="task-editor"
      data-station-task-id="task-1"
      data-station-working-revision="swsr-v1:${'a'.repeat(64)}">base</textarea>
    <button>Inspect worktree diff</button>
    <button>Collapse all</button>
    <button>Expand all</button>
  `;
  const editor = document.querySelector('textarea')!;
  editor.addEventListener('input', () => {
    const enteredEpochMs = browserEpochMs();
    emitTaskInputPerformanceMark({
      taskId: 'task-1',
      workingRevision: `swsr-v1:${'a'.repeat(64)}`,
      text: editor.value,
      enteredEpochMs,
      exitedEpochMs: browserEpochMs(),
    });
    queueMicrotask(() =>
      emitTaskCommitPerformanceMark({
        taskId: 'task-1',
        workingRevision: `swsr-v1:${'a'.repeat(64)}`,
        text: editor.value,
        committedEpochMs: browserEpochMs(),
      }),
    );
  });
  for (const control of document.querySelectorAll('button'))
    control.addEventListener('click', () =>
      emitDiffCommitPerformanceMark({
        workingDir: '/project',
        patchBytes: 128,
        fileCount: 1,
        committedEpochMs: browserEpochMs(),
      }),
    );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    top: 0,
    right: 100,
    bottom: 20,
    left: 0,
    toJSON: () => ({}),
  });
  const input = {
    sampling: { warmups: 1, samples: 2 },
    fixtureCorpus: { id: 'corpus', sha256: 'a'.repeat(64) },
    fixtures: [
      {
        id: 'local-input-apply',
        workloads: ['typing', 'input-apply', 'diff-render'],
        measurementPhases: {
          measured: [
            { id: 'typing', marks: ['inputAt', 'handledAt'] },
            {
              id: 'input-apply',
              marks: ['applyStartedAt', 'modelCommittedAt'],
            },
            {
              id: 'diff-render',
              marks: ['renderStartedAt', 'renderCommittedAt'],
            },
          ],
        },
      },
      {
        id: 'long-session-bounded-growth',
        workloads: ['long-session'],
        measurementPhases: {},
      },
    ],
  } as const;
  const evidence = (await measureInteractiveWorkspace(input, 'task-1')) as {
    version: number;
    source: string;
    observations: Array<{
      fixtureId: string;
      measurements?: Array<{
        phases: {
          measured: { actions: Array<{ kind: string }> };
        };
      }>;
      status?: string;
      reasonCodes?: string[];
      foregroundWork?: unknown;
    }>;
  };
  expect(evidence).toMatchObject({
    version: 1,
    source: 'station-ui-production-bridge',
  });
  expect(evidence.observations[0]).toMatchObject({
    fixtureId: 'local-input-apply',
    sampling: { warmups: 1, samples: 2 },
    counts: { failures: 0, degraded: 0 },
    foregroundWork: {
      version: 1,
      collector: 'NOT_VERIFIED',
      collectorReason: 'BROWSER_LONGTASK_UNSUPPORTED',
      thresholdMs: 50,
      native: {
        status: 'NOT_VERIFIED',
        reason: 'NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE',
      },
    },
  });
  expect(evidence.observations[0]?.measurements).toHaveLength(2);
  expect(
    evidence.observations[0]?.measurements?.[0]?.phases.measured.actions.map(
      (action) => action.kind,
    ),
  ).toEqual(['typing', 'input-apply', 'diff-render']);
  expect(evidence.observations[1]).toMatchObject({
    fixtureId: 'long-session-bounded-growth',
    status: 'NOT_VERIFIED',
    reasonCodes: [
      'PRODUCT_MARK_MEASUREMENT_FAILED_long-session-bounded-growth',
      'PRODUCT_LONG_SESSION_RUNNER_UNAVAILABLE',
    ],
  });
});

test('rejects fabricated surface markup when product hooks did not attest commits', async () => {
  document.body.innerHTML = `
    <p role="status">Shared document saved.</p>
    <textarea aria-label="Task document"
      data-station-performance-surface="task-editor"
      data-station-task-id="task-1"
      data-station-working-revision="swsr-v1:${'a'.repeat(64)}">base</textarea>
    <button>Inspect worktree diff</button>
  `;
  const originalFetch = window.fetch;
  const evidence = (await measureInteractiveWorkspace(
    {
      sampling: { warmups: 0, samples: 1 },
      fixtureCorpus: { id: 'corpus', sha256: 'a'.repeat(64) },
      fixtures: [
        {
          id: 'local-input-apply',
          workloads: ['typing', 'input-apply', 'diff-render'],
          measurementPhases: {
            measured: [
              { id: 'typing', marks: ['inputAt', 'handledAt'] },
              {
                id: 'input-apply',
                marks: ['applyStartedAt', 'modelCommittedAt'],
              },
              {
                id: 'diff-render',
                marks: ['renderStartedAt', 'renderCommittedAt'],
              },
            ],
          },
        },
      ],
    },
    'task-1',
  )) as { observations: Array<Record<string, unknown>> };
  expect(evidence.observations[0]).toMatchObject({
    status: 'NOT_VERIFIED',
    reasonCodes: expect.arrayContaining([
      'PRODUCT_MARK_MEASUREMENT_FAILED_local-input-apply',
      'PRODUCT_TASK_INPUT_TIMEOUT',
    ]),
  });
  expect(window.fetch).toBe(originalFetch);
});

test('replays a persisted host restoration mark observed before the measure listener', async () => {
  document.body.innerHTML = `<textarea data-station-performance-surface="task-editor" data-station-task-id="task-1" data-station-working-revision="swsr-v1:${'a'.repeat(64)}"></textarea><button>Inspect worktree diff</button>`;
  let longTask:
    | ((entries: readonly { startTime: number; duration: number }[]) => void)
    | undefined;
  class FakePerformanceObserver {
    static supportedEntryTypes = ['longtask'];
    constructor(
      next: (list: {
        getEntries(): readonly { startTime: number; duration: number }[];
      }) => void,
    ) {
      longTask = (entries) => next({ getEntries: () => entries });
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
  vi.spyOn(performance, 'getEntriesByName').mockReturnValue([
    { startTime: 60 } as PerformanceEntry,
  ]);
  const editor = document.querySelector('textarea')!;
  editor.addEventListener('input', () => {
    const at = browserEpochMs();
    emitTaskInputPerformanceMark({
      taskId: 'task-1',
      workingRevision: `swsr-v1:${'a'.repeat(64)}`,
      text: editor.value,
      enteredEpochMs: at,
      exitedEpochMs: at,
    });
    emitTaskDocumentApplyPerformanceMark({
      taskId: 'task-1',
      workingRevision: `swsr-v1:${'a'.repeat(64)}`,
      appliedEpochMs: at,
    });
    emitTaskCommitPerformanceMark({
      taskId: 'task-1',
      workingRevision: `swsr-v1:${'a'.repeat(64)}`,
      text: editor.value,
      committedEpochMs: at,
    });
    longTask?.([{ startTime: 10, duration: 70 }]);
  });
  document.querySelector('button')!.addEventListener('click', () =>
    emitDiffCommitPerformanceMark({
      workingDir: '/project',
      patchBytes: 1,
      fileCount: 1,
      committedEpochMs: browserEpochMs(),
    }),
  );
  const evidence = (await measureInteractiveWorkspace(
    {
      sampling: { warmups: 0, samples: 1 },
      fixtureCorpus: { id: 'corpus', sha256: 'a'.repeat(64) },
      fixtures: [
        {
          id: 'local-input-apply',
          workloads: ['typing', 'input-apply', 'diff-render'],
          measurementPhases: {
            measured: [
              { id: 'typing', marks: ['inputAt', 'handledAt'] },
              {
                id: 'input-apply',
                marks: ['applyStartedAt', 'modelCommittedAt'],
              },
              {
                id: 'diff-render',
                marks: ['renderStartedAt', 'renderCommittedAt'],
              },
            ],
          },
        },
      ],
    },
    'task-1',
  )) as unknown as {
    observations: Array<{ foregroundWork: { incidents: unknown[] } }>;
  };
  expect(evidence.observations[0]?.foregroundWork.incidents).toEqual([
    expect.objectContaining({
      phase: 'pane-restoration',
      interaction: 'navigation',
      action: 'pane-restore',
      pane: 'workspace-host',
      source: 'browser-longtask',
    }),
  ]);
});

test('file measurement keeps zero-duration scroll marks ordered across epoch conversion', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(24317.900000095367);
  vi.spyOn(performance, 'timeOrigin', 'get').mockReturnValue(1_700_000_000_000);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}')),
  );
  document.body.innerHTML = `<textarea data-station-performance-surface="task-editor" data-station-task-id="task-1" data-station-working-revision="swsr-v1:${'a'.repeat(64)}"></textarea>
    <div data-station-performance-surface="workspace-file-preview" data-station-project-slug="demo"></div>
    <button>Inspect worktree diff</button>`;
  const surface = document.querySelector<HTMLDivElement>(
    '[data-station-performance-surface="workspace-file-preview"]',
  )!;
  Object.defineProperty(surface, 'scrollHeight', { value: 1000 });
  surface.addEventListener('scroll', () =>
    emitFilePreviewScrollPerformanceMark({
      projectSlug: 'demo',
      path: 'file.txt',
      scrollTop: surface.scrollTop,
      scrolledEpochMs: browserEpochMs(),
      committedEpochMs: browserEpochMs(),
    }),
  );
  document.querySelector('button')!.addEventListener('click', () =>
    emitDiffCommitPerformanceMark({
      workingDir: '/fixture/workspace',
      patchBytes: 1,
      fileCount: 1,
      committedEpochMs: browserEpochMs(),
    }),
  );
  const refresh = async (event: Event) => {
    await window.fetch('/api/projects/demo/file-preview', {
      method: 'POST',
      body: JSON.stringify({ path: 'file.txt' }),
    });
    emitFilePreviewCommitPerformanceMark({
      projectSlug: 'demo',
      path: 'file.txt',
      sizeBytes: 199999,
      lineCount: 100000,
      renderedLineCount: 2000,
      refreshNonce: (event as CustomEvent<{ nonce: string }>).detail.nonce,
      committedEpochMs: browserEpochMs(),
    });
  };
  window.addEventListener('station:performance:file-preview-refresh', refresh);
  window.__stationInteractiveWorkspacePerformanceDriver = async (command) => {
    if (command.kind !== 'prepare-100k-corpus')
      throw new Error('Unexpected driver action');
    return {
      kind: 'prepared',
      path: 'file.txt',
      corpusId: referenceContract.fixtureCorpus.id,
      sha256: referenceContract.fixtureCorpus.sha256,
      lineCount: 100000,
      rebuilt: command.phase === 'cold',
    };
  };
  try {
    const definition = referenceContract.fixtures.find(
      (entry) => entry.id === 'open-100k-lines',
    )!;
    const fixture = {
      id: definition.id,
      workloads: definition.workloads,
      measurementPhases: {
        cold: definition.measurementPhases.cold!,
        warm: definition.measurementPhases.warm!,
      },
    };
    const result = await measureInteractiveWorkspace(
      {
        sampling: { warmups: 0, samples: 1 },
        fixtureCorpus: referenceContract.fixtureCorpus,
        fixtures: [fixture],
      },
      'task-1',
    );
    const measurements = Reflect.get(
      result.observations[0]!,
      'measurements',
    ) as Array<{
      phases: Record<
        string,
        { actions: Array<{ kind: string; marks: Record<string, number> }> }
      >;
    }>;
    expect(measurements).toHaveLength(1);
    for (const phase of ['cold', 'warm']) {
      const scroll = measurements[0]!.phases[phase]!.actions.find(
        (entry) => entry.kind === 'scroll',
      )!;
      expect(scroll.marks.scrollRenderedAt).toBeGreaterThanOrEqual(
        scroll.marks.scrollStartedAt!,
      );
    }
  } finally {
    window.removeEventListener(
      'station:performance:file-preview-refresh',
      refresh,
    );
    delete window.__stationInteractiveWorkspacePerformanceDriver;
  }
});

type BriefFault =
  | 'none'
  | 'no-receipt'
  | 'wrong-task'
  | 'wrong-revision'
  | 'wrong-text'
  | 'wrong-intent'
  | 'foreign-layout'
  | 'missing-apply'
  | 'refused'
  | 'unsettled'
  | 'hidden'
  | 'read-only';

async function mountedBrief(fault: BriefFault = 'none') {
  const before = `swsr-v2:${'a'.repeat(64)}`;
  const after = `swsr-v2:${'b'.repeat(64)}`;
  brief.document.data = { kind: 'snapshot', revision: before, text: 'base' };
  brief.adopt = fault !== 'unsettled';
  brief.corruptBatch = fault === 'wrong-intent';
  brief.discovery.data.capabilities.documentWrite = fault !== 'read-only';
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({
    length: 1,
  } as DOMRectList);
  let desired = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (url.endsWith('/edit-plan')) {
        desired = body.desiredText;
        return Response.json({
          success: true,
          data: {
            kind: 'planned',
            intentId: 'opaque-server-intent',
            digest: 'c'.repeat(64),
            selection: body.selection,
            operationCount: 1,
          },
        });
      }
      expect(body).toEqual({
        intentId:
          fault === 'wrong-intent' ? 'foreign-intent' : 'opaque-server-intent',
        intentDigest: 'c'.repeat(64),
      });
      const epoch = browserEpochMs();
      if (fault !== 'missing-apply')
        brief.listener?.({
          kind: 'snapshot',
          revision:
            fault === 'foreign-layout' ? `swsr-v2:${'d'.repeat(64)}` : after,
          text: desired,
        });
      return Response.json(
        {
          success: true,
          data:
            fault === 'refused'
              ? { kind: 'rejected', reason: 'fixture refusal' }
              : {
                  kind: 'committed',
                  revision: fault === 'wrong-revision' ? before : after,
                  text: fault === 'wrong-text' ? 'other text' : desired,
                },
        },
        {
          headers:
            fault === 'no-receipt'
              ? {}
              : {
                  [INTERACTIVE_WORKSPACE_TIMING_RESPONSE_HEADER]:
                    formatInteractiveWorkspaceBatchTiming({
                      taskId: fault === 'wrong-task' ? 'task-other' : 'task-1',
                      ingressEpochMs: epoch,
                      acceptedEpochMs: epoch,
                    })!,
                },
        },
      );
    }),
  );
  render(
    createElement(TaskRoomEditorPane, {
      taskId: 'task-1',
      startInPreview: true,
    }),
  );
  expect(screen.queryByRole('textbox', { name: 'Task brief' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit brief' }));
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', {
    name: 'Task brief',
  });
  if (fault === 'hidden') editor.parentElement!.hidden = true;
  window.__stationInteractiveWorkspacePerformanceDriver = async (command) => {
    if (command.kind !== 'brief-input')
      throw new Error('unexpected fixture driver command');
    await act(async () => {
      fireEvent.change(editor, { target: { value: command.text } });
    });
    // Blur submits synchronously, before the input driver can return its receipt.
    await act(async () => {
      fireEvent.blur(editor);
    });
    return { kind: 'brief-input-completed' };
  };
  return editor;
}

function remoteApplyInput(samples = 1) {
  const fixture = referenceContract.fixtures.find(
    (entry) => entry.id === 'remote-apply',
  )!;
  return {
    sampling: { warmups: 0, samples },
    fixtureCorpus: referenceContract.fixtureCorpus,
    fixtures: [
      {
        ...fixture,
        measurementPhases: { measured: fixture.measurementPhases.measured! },
      },
    ],
  };
}

test('observes a mounted Brief autosave before the input driver returns and waits for Saved adoption', async () => {
  const editor = await mountedBrief();
  const result = await measureInteractiveWorkspace(
    remoteApplyInput(),
    'task-1',
  );
  expect(result.observations[0]).toMatchObject({
    counts: { failures: 0, degraded: 0 },
    autosave: {
      debounceMs: 450,
      samples: [
        {
          iteration: 0,
          inputToBatchRequestMs: expect.any(Number),
          inputToSavedMs: expect.any(Number),
        },
      ],
    },
    measurements: [{ iteration: 0 }],
  });
  expect(editor.value).toBe('base0');
  expect(screen.getByRole('status').textContent).toBe('Saved');
});

test.each<BriefFault>([
  'no-receipt',
  'wrong-task',
  'wrong-revision',
  'wrong-text',
  'wrong-intent',
  'foreign-layout',
  'missing-apply',
  'refused',
  'unsettled',
  'hidden',
  'read-only',
])(
  'refuses remote-apply evidence for %s in the mounted Brief',
  async (fault) => {
    await mountedBrief(fault);
    const result = await measureInteractiveWorkspace(
      remoteApplyInput(),
      'task-1',
    );
    expect(result.observations[0]).toMatchObject({
      status: 'NOT_VERIFIED',
      counts: { failures: 1 },
    });
    expect(result.observations[0]).not.toHaveProperty('measurements');
    expect(result.observations[0]).toHaveProperty(
      'reasonCodes',
      expect.arrayContaining([
        fault === 'no-receipt'
          ? 'PRODUCT_SERVER_RECEIPT_UNAVAILABLE'
          : fault === 'hidden' || fault === 'read-only'
            ? 'PRODUCT_TASK_IDENTITY_UNAVAILABLE'
            : fault === 'foreign-layout'
              ? 'PRODUCT_TASK_COMMIT_TIMEOUT'
              : fault === 'missing-apply'
                ? 'PRODUCT_TASK_APPLY_TIMEOUT'
                : fault === 'unsettled'
                  ? 'PRODUCT_SETTLED_STATE_INDETERMINATE'
                  : 'PRODUCT_AUTOSAVE_RECEIPT_INVALID',
      ]),
    );
  },
);

test('identifies the missing task product mark without exposing arbitrary error text', () => {
  for (const kind of ['input', 'apply', 'commit']) {
    expect(
      productMarkFailureCode(new Error(`task-${kind} product mark timed out`)),
    ).toBe(`PRODUCT_TASK_${kind.toUpperCase()}_TIMEOUT`);
  }
  expect(
    productMarkFailureCode(
      new Error('task-private-secret product mark timed out'),
    ),
  ).toBe('PRODUCT_MARK_TIMEOUT');
});

test('classifies every 100k measurement stage without retaining volatile driver output', () => {
  expect(
    productMarkFailureCode(
      new Error('100k file measurement OPEN_FILE failed', {
        cause: new Error('file-preview-commit product timed out'),
      }),
    ),
  ).toBe('PRODUCT_FILE_PREVIEW_COMMIT_TIMEOUT');
  expect(
    productMarkFailureCode(
      new Error('100k file measurement OPEN_FILE failed', {
        cause: new Error('/private/unrecognized/page-text'),
      }),
    ),
  ).toBe('PRODUCT_FILE_100K_OPEN_FILE_FAILED');
  for (const stage of [
    'PREPARE_CORPUS',
    'OPEN_FILE',
    'SCROLL_FILE',
    'RENDER_DIFF',
  ])
    expect(
      productMarkFailureCode(
        new Error(`100k file measurement ${stage} failed`),
      ),
    ).toBe(`PRODUCT_FILE_100K_${stage}_FAILED`);
});

test('projects only shipped product occurrences into the foreground timeline', () => {
  const at = browserEpochMs();
  const projections = [
    foregroundAttributionForProductMark({
      kind: 'task-input',
      mark: { enteredEpochMs: at },
    } as any),
    foregroundAttributionForProductMark({
      kind: 'task-apply',
      mark: { appliedEpochMs: at + 1 },
    } as any),
    foregroundAttributionForProductMark({
      kind: 'task-commit',
      mark: { committedEpochMs: at + 2 },
    } as any),
    foregroundAttributionForProductMark({
      kind: 'diff-commit',
      mark: { committedEpochMs: at + 3 },
    } as any),
    foregroundAttributionForProductMark({
      kind: 'room-presence-commit',
      mark: { committedEpochMs: at + 4 },
    } as any),
    foregroundAttributionForProductMark({
      kind: 'remote-cursor-commit',
      mark: { committedEpochMs: at + 5 },
    } as any),
    foregroundAttributionForProductMark({
      kind: 'reconnect-strategy',
      mark: { receivedEpochMs: at + 6 },
    } as any),
    foregroundAttributionForPersistedHostDocumentRestoration(),
    foregroundAttributionForProductMark({
      kind: 'file-preview-commit',
      mark: { committedEpochMs: at + 7 },
    } as any),
  ];
  expect(projections).toEqual([
    expect.objectContaining({
      attribution: expect.objectContaining({ phase: 'input' }),
      occurrence: 'start',
    }),
    expect.objectContaining({
      attribution: expect.objectContaining({ phase: 'authoritative-apply' }),
      occurrence: 'completion',
    }),
    expect.objectContaining({
      attribution: expect.objectContaining({ phase: 'layout' }),
      occurrence: 'completion',
    }),
    expect.objectContaining({
      attribution: expect.objectContaining({
        phase: 'render',
        pane: 'diff-panel',
      }),
      occurrence: 'completion',
    }),
    expect.objectContaining({
      attribution: expect.objectContaining({
        interaction: 'collaboration',
        action: 'presence-update',
      }),
      occurrence: 'completion',
    }),
    expect.objectContaining({
      attribution: expect.objectContaining({
        interaction: 'collaboration',
        action: 'presence-update',
      }),
      occurrence: 'completion',
    }),
    expect.objectContaining({
      attribution: expect.objectContaining({
        interaction: 'navigation',
        action: 'pane-restore',
      }),
      occurrence: 'completion',
    }),
    expect.objectContaining({
      phase: 'pane-restoration',
      pane: 'workspace-host',
    }),
    expect.objectContaining({
      attribution: expect.objectContaining({
        phase: 'render',
        pane: 'file-preview',
      }),
    }),
  ]);
});

test('keeps only a closed live-command diagnostic through collaboration failure', () => {
  expect(
    productMarkFailureCode(
      new Error(
        'Collaboration measure peer-cursor failed: Live command Cursor status 200 outcome RATE_LIMITED',
      ),
    ),
  ).toBe('PRODUCT_COLLABORATION_PEER_CURSOR_LIVE_COMMAND_OUTCOME_RATE_LIMITED');
  expect(
    productMarkFailureCode(
      new Error(
        'Collaboration measure leave failed: Live command Leave room status 200 outcome DEGRADED',
      ),
    ),
  ).toBe('PRODUCT_COLLABORATION_LEAVE_LIVE_COMMAND_OUTCOME_DEGRADED');
  expect(
    productMarkFailureCode(
      new Error('Collaboration measure leave failed: private-token'),
    ),
  ).toBe('PRODUCT_COLLABORATION_LEAVE_FAILED');
});

test('categorizes reconnect revision mismatches without retaining revisions', () => {
  const editorStage = reconnectDriverStage(
    'Reconnect stage RETAINED_SAMPLE_4 failed: editor revision a1b2c3d4e5f6 expected 0123456789ab',
  );
  const renderStage = reconnectDriverStage(
    'Reconnect stage FALLBACK_SAMPLE_4 failed: latest task commit a1b2c3d4e5f6 expected 0123456789ab',
  );
  const editor = productMarkFailureCode(
    new Error(`reconnect driver ${editorStage}`),
  );
  const render = productMarkFailureCode(
    new Error(`reconnect driver ${renderStage}`),
  );

  expect(editor).toBe(
    'PRODUCT_RECONNECT_DRIVER_RETAINED_SAMPLE_4_EDITOR_REVISION_MISMATCH',
  );
  expect(render).toBe(
    'PRODUCT_RECONNECT_DRIVER_FALLBACK_SAMPLE_4_RENDER_REVISION_MISMATCH',
  );
  expect(editor).not.toContain('a1b2c3d4e5f6');
  expect(render).not.toContain('0123456789ab');
  for (const status of ['200', 'none'])
    expect(
      reconnectDriverStage(
        `Reconnect stage FALLBACK_SAMPLE_74 failed: document status ${status}; editor revision a1b2c3d4e5f6 expected a1b2c3d4e5f6; reconnect apply wait timed out; no task apply observed`,
      ),
    ).toBe('FALLBACK_SAMPLE_74_APPLY_NO_MARK');
});

test('preserves closed peer-presence driver failures through the measurement bridge', async () => {
  document.body.innerHTML = `<textarea data-station-performance-surface="task-editor" data-station-task-id="task-1" data-station-working-revision="swsr-v1:${'a'.repeat(64)}"></textarea><button>Join room</button><button>Announce work</button><button>Leave room</button>`;
  const input = {
    sampling: { warmups: 0, samples: 1 },
    fixtureCorpus: { id: 'corpus', sha256: 'a'.repeat(64) },
    fixtures: [
      {
        id: 'synthetic-collaboration',
        workloads: [],
        measurementPhases: {},
      },
    ],
  } as const;
  for (const [message, expected] of [
    [
      'Collaboration presence owner-absence failed',
      'PRODUCT_COLLABORATION_PRESENCE_OWNER_ABSENCE_FAILED',
    ],
    [
      'Collaboration presence leave failed: Live command Leave room status 500 outcome DEGRADED',
      'PRODUCT_COLLABORATION_PEER_PUBLISH_LIVE_COMMAND_OUTCOME_DEGRADED',
    ],
    ['C:/private/token', 'PRODUCT_COLLABORATION_PEER_PUBLISH_FAILED'],
  ]) {
    window.__stationInteractiveWorkspacePerformanceDriver = async () => {
      throw new Error(message);
    };
    const evidence = (await measureInteractiveWorkspace(
      input,
      'task-1',
    )) as any;
    expect(evidence.observations[0].reasonCodes).toContain(expected);
  }
});

test('preserves only the closed workspace cause through 100k stage handling', async () => {
  document.body.innerHTML = `<textarea data-station-performance-surface="task-editor" data-station-task-id="task-1" data-station-working-revision="swsr-v1:${'a'.repeat(64)}"></textarea>`;
  const input = {
    sampling: { warmups: 0, samples: 1 },
    fixtureCorpus: { id: 'corpus', sha256: 'a'.repeat(64) },
    fixtures: [{ id: 'open-100k-lines', workloads: [], measurementPhases: {} }],
  } as const;
  for (const [reason, expected] of [
    [
      'Task workspace is unavailable',
      'PRODUCT_FILE_TASK_WORKSPACE_UNAVAILABLE',
    ],
    [
      'CONTROL_CONNECTION',
      'PRODUCT_FILE_100K_PREPARE_CORPUS_CONTROL_CONNECTION',
    ],
    ['CONTROL_UNKNOWN', 'PRODUCT_FILE_100K_PREPARE_CORPUS_CONTROL_UNKNOWN'],
    ['C:/private/path', 'PRODUCT_FILE_100K_PREPARE_CORPUS_UNKNOWN'],
  ]) {
    window.__stationInteractiveWorkspacePerformanceDriver = async () => ({
      kind: 'unavailable',
      reason,
    });
    const evidence = (await measureInteractiveWorkspace(
      input,
      'task-1',
    )) as any;
    expect(evidence.observations[0].reasonCodes).toContain(expected);
  }
});

test('rejects an already-current editor DOM when no apply was observed', async () => {
  document.body.innerHTML = `<textarea data-station-performance-surface="task-editor"
    data-station-task-id="task-1"
    data-station-working-revision="swsr-v1:${'a'.repeat(64)}">already current</textarea>`;
  const observed = observeReconnectMark('task-1', {
    strategy: 'delta',
    afterEpochMs: browserEpochMs(),
    expectedRevision: `swsr-v1:${'a'.repeat(64)}`,
  });
  emitReconnectStrategyPerformanceMark({
    taskId: 'task-1',
    strategy: 'delta',
    revision: `swsr-v1:${'a'.repeat(64)}`,
    receivedEpochMs: browserEpochMs(),
  });
  await expect(observed).rejects.toThrow('no task apply observed');
});

test.each([
  ['task', 'APPLY_TASK_MISMATCH'],
  ['revision', 'APPLY_REVISION_MISMATCH'],
  ['time', 'APPLY_BEFORE_STRATEGY'],
] as const)(
  'identifies an unusable reconnect apply by %s',
  async (mismatch, code) => {
    const revision = `swsr-v1:${'a'.repeat(64)}`;
    const receivedEpochMs = browserEpochMs();
    const observed = observeReconnectMark('task-1', {
      strategy: 'gap',
      afterEpochMs: receivedEpochMs,
      expectedRevision: revision,
    });
    emitReconnectStrategyPerformanceMark({
      taskId: 'task-1',
      strategy: 'gap',
      receivedEpochMs,
    });
    emitTaskDocumentApplyPerformanceMark({
      taskId: mismatch === 'task' ? 'another-task' : 'task-1',
      workingRevision:
        mismatch === 'revision' ? `swsr-v1:${'b'.repeat(64)}` : revision,
      appliedEpochMs: receivedEpochMs + (mismatch === 'time' ? -1 : 1),
    });
    const failure = await observed.catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Expected rejected apply');
    expect(
      reconnectDriverStage(
        `Reconnect stage FALLBACK_SAMPLE_74 failed: ${failure.message}`,
      ),
    ).toBe(`FALLBACK_SAMPLE_74_${code}`);
  },
);

test('an exact apply and matching DOM still require a post-apply layout commit', async () => {
  const revision = `swsr-v1:${'a'.repeat(64)}`;
  document.body.innerHTML = `<textarea data-station-working-revision="${revision}"></textarea>`;
  const receivedEpochMs = browserEpochMs();
  const observed = observeReconnectMark('task-1', {
    strategy: 'gap',
    afterEpochMs: receivedEpochMs,
    expectedRevision: revision,
  });
  emitReconnectStrategyPerformanceMark({
    taskId: 'task-1',
    strategy: 'gap',
    receivedEpochMs,
  });
  emitTaskDocumentApplyPerformanceMark({
    taskId: 'task-1',
    workingRevision: revision,
    appliedEpochMs: receivedEpochMs + 1,
  });
  await expect(observed).rejects.toThrow('no task commit observed');
});

test('accepts an exact post-strategy revision commit without inspecting document text', async () => {
  const revision = `swsr-v1:${'b'.repeat(64)}`;
  const observed = observeReconnectMark('task-1', {
    strategy: 'delta',
    afterEpochMs: browserEpochMs(),
    expectedRevision: revision,
  });
  const receivedEpochMs = browserEpochMs();
  emitReconnectStrategyPerformanceMark({
    taskId: 'task-1',
    strategy: 'delta',
    revision,
    receivedEpochMs,
  });
  emitTaskDocumentApplyPerformanceMark({
    taskId: 'task-1',
    workingRevision: revision,
    appliedEpochMs: receivedEpochMs + 1,
  });
  emitTaskCommitPerformanceMark({
    taskId: 'task-1',
    workingRevision: revision,
    text: 'content stays private at the bridge boundary',
    committedEpochMs: receivedEpochMs + 2,
  });

  await expect(observed).resolves.toMatchObject({
    strategy: { taskId: 'task-1', strategy: 'delta', revision },
    apply: { taskId: 'task-1', workingRevision: revision },
    render: { taskId: 'task-1', workingRevision: revision },
  });
});

test('file refresh commits must match the requested nonce, path and time', async () => {
  vi.useFakeTimers();
  const marks = observeProductMarks();
  const expected = {
    path: 'file.txt',
    refreshNonce: 'fp-0-cold',
    afterEpochMs: 10,
  };
  const pending = marks.filePreviewCommit(expected);
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {},
  );
  const base = {
    projectSlug: 'project',
    path: 'file.txt',
    sizeBytes: 100,
    lineCount: 20,
    renderedLineCount: 20,
    committedEpochMs: 11,
    refreshNonce: 'fp-0-cold',
  };
  try {
    emitFilePreviewCommitPerformanceMark({ ...base, path: 'other.txt' });
    emitFilePreviewCommitPerformanceMark({ ...base, committedEpochMs: 9 });
    emitFilePreviewCommitPerformanceMark({ ...base, refreshNonce: 'old-mark' });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    emitFilePreviewCommitPerformanceMark(base);
    expect(await pending).toEqual(base);
  } finally {
    marks.close();
    vi.useRealTimers();
  }
});

test.each([false, true])(
  'a preview refresh requires a matching request started after arming (Request object: %s)',
  async (requestObject) => {
    let completeOld!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => {
      completeOld = resolve;
    });
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => old)
      .mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const observer = observeFilePreviewFetches();
    const url = 'http://localhost/api/projects/project/file-preview';
    const init = (path: string) => ({
      method: 'POST',
      body: JSON.stringify({ path }),
    });
    const send = (path: string) =>
      requestObject
        ? window.fetch(new Request(url, init(path)))
        : window.fetch(url, init(path));
    try {
      const previous = send('file.txt');
      const fresh = observer.next('file.txt');
      let settled = false;
      void fresh.then(
        () => {
          settled = true;
        },
        () => {},
      );
      completeOld(new Response('{}'));
      await previous;
      expect(settled).toBe(false);
      await send('other.txt');
      expect(settled).toBe(false);
      await send('file.txt');
      await fresh;
      expect(settled).toBe(true);
    } finally {
      observer.close();
    }
  },
);

test('a late animation frame from an older scroll cannot satisfy the next scroll', async () => {
  vi.useFakeTimers();
  const marks = observeProductMarks();
  const pending = marks.filePreviewScroll({
    path: 'file.txt',
    afterEpochMs: 10,
  });
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {},
  );
  const base = {
    projectSlug: 'project',
    path: 'file.txt',
    scrollTop: 100,
    scrolledEpochMs: 9,
    committedEpochMs: 11,
  };
  try {
    emitFilePreviewScrollPerformanceMark(base);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    emitFilePreviewScrollPerformanceMark({ ...base, scrolledEpochMs: 10 });
    expect((await pending).scrolledEpochMs).toBe(10);
  } finally {
    marks.close();
    vi.useRealTimers();
  }
});
