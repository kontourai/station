/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let queryResult: {
  data?: any;
  isLoading: boolean;
  error?: Error;
  refetch: ReturnType<typeof vi.fn>;
};
let roomDiscoveryResult: {
  data: any;
  isLoading: boolean;
};
let roomDocumentResult: {
  data: any;
  isLoading: boolean;
  isFetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
};
let turnReferencesResult: {
  data?: any[];
  isLoading: boolean;
  error?: Error;
  refetch: ReturnType<typeof vi.fn>;
};
let userInputReferencesResult: {
  data?: any[];
  isLoading: boolean;
  error?: Error;
};
let taskOutputsResult: {
  data?: any[];
  isLoading: boolean;
  error?: Error;
  refetch: ReturnType<typeof vi.fn>;
};
let answerSupportBundlesResult: {
  data?: { id: string }[];
  isLoading: boolean;
  error?: Error;
};
let answerSupportClaimsResult: {
  data?: { id: string }[];
  isLoading: boolean;
  error?: Error;
};
const createOutputMutation = {
  isPending: false,
  mutate: vi.fn(),
};
const createAnswerSupportMutation = { isPending: false, mutateAsync: vi.fn() };
const replaceAnswerSupportMutation = { isPending: false, mutateAsync: vi.fn() };
const removeAnswerSupportMutation = { isPending: false, mutateAsync: vi.fn() };
const deleteOutputMutation = {
  isPending: false,
  mutate: vi.fn(),
};
const downloadOutputContent = vi.fn();

// AW-4: the optional Task experiences are now derived from this
// Station's installed plugins, so the view reads the plugin inventory too.
const pluginsResult: {
  data: Array<{ enabled?: boolean; manifest?: { capabilities?: string[] } }>;
} = { data: [] };
vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
  useTaskGraphQuery: () => queryResult,
  useTaskTurnReferencesQuery: () => turnReferencesResult,
  useAnswerSupportBundlesQuery: () => answerSupportBundlesResult,
  useAnswerSupportClaimsQuery: () => answerSupportClaimsResult,
  useCreateAnswerSupportMutation: () => createAnswerSupportMutation,
  useReplaceAnswerSupportMutation: () => replaceAnswerSupportMutation,
  useRemoveAnswerSupportMutation: () => removeAnswerSupportMutation,
  useTaskOutputsQuery: () => taskOutputsResult,
  useCreateTaskOutputMutation: () => createOutputMutation,
  useDeleteTaskOutputMutation: () => deleteOutputMutation,
  usePluginsQuery: () => pluginsResult,
}));
vi.mock('@kontourai/station-sdk/task-user-input-references', () => ({
  useTaskUserInputReferencesQuery: () => userInputReferencesResult,
}));
vi.mock('@kontourai/station-sdk/client', () => ({
  downloadTaskOutputContent: (...args: unknown[]) =>
    downloadOutputContent(...args),
}));
vi.mock('@kontourai/station-sdk/task-outputs', () => ({
  downloadTaskOutputContent: (...args: unknown[]) =>
    downloadOutputContent(...args),
  useTaskOutputsQuery: () => taskOutputsResult,
  useCreateTaskOutputMutation: () => createOutputMutation,
  useDeleteTaskOutputMutation: () => deleteOutputMutation,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('@kontourai/station-sdk/project-task-rooms', () => ({
  useProjectTaskRoomDiscoveryQuery: () => roomDiscoveryResult,
  useProjectTaskRoomDocumentQuery: () => roomDocumentResult,
  useProjectTaskRoomHistoryQuery: () => ({
    data: { pages: [] },
    isError: false,
  }),
  useProjectTaskRoomStream: () => vi.fn(),
  useCommandProjectTaskRoomLiveMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  usePlanProjectTaskRoomEditMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useSubmitProjectTaskRoomBatchMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useAppendProjectTaskRoomHumanMessageMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));
vi.mock('../components/DetailHeader', () => ({
  DetailHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('../components/coding-layout/FileContentViewer', () => ({
  FileContentViewer: ({
    workingDir,
    filePath,
  }: {
    workingDir: string;
    filePath: string;
  }) => <div data-testid="file-content">{`${workingDir}:${filePath}`}</div>,
}));
vi.mock('../components/coding-layout/DiffPanel', () => ({
  DiffPanel: ({ workingDir }: { workingDir: string }) => (
    <div data-testid="diff-panel">{workingDir}</div>
  ),
}));
vi.mock('../components/chat/LazyMarkdown', () => ({
  LazyMarkdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('../workspace-panes/BasisWorkspacePane', () => ({
  BasisWorkspacePane: ({ instance }: { instance: { instanceId: string } }) => (
    <output data-testid="task-basis-pane">{instance.instanceId}</output>
  ),
}));

import {
  relativeWorkspacePath,
  TaskWorkspaceView,
} from '../views/TaskWorkspaceView';
import { formatClaimValue } from '../views/task-workspace/TaskTurnReferenceView';
import type { WorkspacePaneHostLockManager } from '../workspace-panes/workspacePaneHostLease';

function graph(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: 'task-alpha',
      projectId: 'project-alpha',
      title: 'Inspect the workspace',
      description: '',
      priority: 'normal',
      status: 'running',
      createdBy: 'user',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
      sessionId: 'session-alpha',
      agentId: 'agent-alpha',
      workspaceBinding: {
        availability: 'available',
        workingDirectory: '/project',
        repoRoot: '/project',
        worktreePath: '/project/worktrees/task-alpha',
        branch: 'agent/task-alpha',
      },
      ...overrides,
    },
    links: [
      {
        id: 'artifact-1',
        sourceType: 'task',
        sourceId: 'task-alpha',
        targetType: 'artifact',
        targetId: 'artifact-report',
        relationType: 'references_artifact',
        confidence: 1,
        createdAt: '2026-07-19T00:00:00.000Z',
        source: 'user',
        metadata: { path: 'reports/result.md' },
      },
      {
        id: 'receipt-1',
        sourceType: 'task',
        sourceId: 'task-alpha',
        targetType: 'receipt',
        targetId: '/project/worktrees/task-alpha/receipts/verify.md',
        relationType: 'references_receipt',
        confidence: 1,
        createdAt: '2026-07-19T00:00:00.000Z',
        source: 'user',
      },
      {
        id: 'file-1',
        sourceType: 'task',
        sourceId: 'task-alpha',
        targetType: 'file',
        targetId: '/project/worktrees/task-alpha/src/app.ts',
        relationType: 'touches_file',
        confidence: 1,
        createdAt: '2026-07-19T00:00:00.000Z',
        source: 'system',
      },
    ],
  };
}

function answerProvenance(overrides: Record<string, unknown> = {}) {
  return {
    envelopeVersion: 1,
    sessionId: 'session-answer',
    turnId: 'turn-answer',
    outcome: 'completed',
    observedAt: '2026-08-23T00:00:00.000Z',
    engine: {
      state: 'observed',
      value: { provider: 'claude' },
      observedFrom: [{ eventId: 'event-answer', method: 'turn.completed' }],
    },
    requestedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
    reportedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
    tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
    usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
    routingReceipt: { state: 'unavailable', reason: 'not-captured-by-station' },
    sources: { state: 'unavailable', reason: 'not-captured-by-station' },
    trustReport: { state: 'unavailable', reason: 'not-captured-by-station' },
    ...overrides,
  };
}

function taskOutput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'output-alpha',
    taskId: 'task-alpha',
    projectId: 'project-alpha',
    title: 'local.md',
    source: { kind: 'workspace-file', relativePath: 'local.md' },
    materialization: {
      kind: 'snapshot',
      fileName: 'local.md',
      mediaType: 'text/plain',
      byteLength: 23,
      digest: `sha256:${'a'.repeat(64)}`,
      contentAvailable: true,
    },
    createdAt: '2026-08-24T12:00:00.000Z',
    ...overrides,
  };
}

describe('TaskWorkspaceView', () => {
  beforeEach(() => {
    queryResult = {
      data: graph(),
      isLoading: false,
      refetch: vi.fn(),
    };
    turnReferencesResult = {
      data: [],
      isLoading: false,
      refetch: vi.fn(),
    };
    userInputReferencesResult = { data: [], isLoading: false };
    taskOutputsResult = {
      data: [],
      isLoading: false,
      refetch: vi.fn(),
    };
    answerSupportBundlesResult = {
      data: [{ id: 'bundle-a' }],
      isLoading: false,
    };
    answerSupportClaimsResult = { data: [{ id: 'claim-a' }], isLoading: false };
    createAnswerSupportMutation.isPending = false;
    createAnswerSupportMutation.mutateAsync.mockReset();
    replaceAnswerSupportMutation.isPending = false;
    replaceAnswerSupportMutation.mutateAsync.mockReset();
    removeAnswerSupportMutation.isPending = false;
    removeAnswerSupportMutation.mutateAsync.mockReset();
    createOutputMutation.isPending = false;
    createOutputMutation.mutate.mockReset();
    deleteOutputMutation.isPending = false;
    deleteOutputMutation.mutate.mockReset();
    downloadOutputContent.mockReset();
    pluginsResult.data = [];
    roomDiscoveryResult = {
      data: { kind: 'unavailable' },
      isLoading: false,
    };
    roomDocumentResult = {
      data: { kind: 'unavailable' },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    };
  });

  test('retains a previously verified Task room as read-only async context', () => {
    roomDiscoveryResult = {
      data: {
        kind: 'existing',
        scope: { taskId: 'task-alpha' },
        capabilities: {
          documentRead: true,
          documentWrite: true,
          historyRead: true,
          messageWrite: true,
          revisionLinks: true,
          live: true,
        },
      },
      isLoading: false,
    };
    roomDocumentResult = {
      data: {
        kind: 'snapshot',
        revision: `swsr-v1:${'a'.repeat(64)}`,
        text: 'Retained async context',
      },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = () => (
      <QueryClientProvider client={queryClient}>
        <TaskWorkspaceView taskId="task-alpha" />
      </QueryClientProvider>
    );
    const { rerender } = render(view());
    expect(
      screen.getByRole('region', { name: 'Task room workspace' }),
    ).toBeTruthy();

    roomDiscoveryResult = {
      data: { kind: 'unavailable' },
      isLoading: false,
    };
    rerender(view());

    expect(
      screen.getByRole('region', { name: 'Task room workspace' }),
    ).toBeTruthy();
    expect(screen.getByDisplayValue('Retained async context')).toBeTruthy();
    expect(screen.getByText(/Task room is unavailable/i)).toBeTruthy();
  });

  test('reopens an exact available answer with its provenance without calling it semantic support', () => {
    turnReferencesResult.data = [
      {
        id: 'answer-link-1',
        state: 'available',
        sessionId: 'session-answer',
        turnId: 'turn-answer',
        answer: {
          role: 'assistant',
          content: 'The exact completed answer.',
          turnId: 'turn-answer',
          provenance: answerProvenance(),
        },
        support: { state: 'unassessed' },
      },
    ];

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TaskWorkspaceView taskId="task-alpha" />
      </QueryClientProvider>,
    );

    expect(screen.getByText('The exact completed answer.')).toBeTruthy();
    expect(
      screen.getByLabelText('Answer provenance for turn turn-answer'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Execution captured; semantic support is separate and has not been assessed.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Execution captured; semantic support not assessed.'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Associate support' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry support' })).toBeNull();
  });

  test('renders the server-owned Surface answer card without folding its evidence', () => {
    turnReferencesResult.data = [
      {
        id: 'answer-link-card',
        state: 'available',
        sessionId: 'session-answer',
        turnId: 'turn-card',
        answer: {
          role: 'assistant',
          content: 'Supported answer.',
          turnId: 'turn-card',
        },
        support: {
          state: 'available',
          associationId: 'association-a',
          revision: 4,
          card: {
            found: true,
            claim: {
              id: 'claim-a',
              subject: { subjectType: 'artifact', subjectId: 'artifact-a' },
              claimType: 'quality.test',
              fieldOrBehavior: 'tests',
              value: 'pass',
              status: 'stale',
              freshness: {
                asOf: '2026-01-01T00:00:00.000Z',
                expiresAt: null,
                stale: true,
              },
              materiality: 'high',
            },
            evidence: {
              entailing: [
                {
                  id: 'entails-failed',
                  type: 'test_output',
                  method: 'validation',
                  sourceRef: 'report',
                  locator: null,
                  summary: 'The required test failed.',
                  observedAt: '2026-01-01T00:00:00.000Z',
                  supportStrength: 'entails',
                  result: 'failed',
                  blocksClaim: true,
                },
              ],
              cited: [
                {
                  id: 'cited-passed',
                  type: 'test_output',
                  method: 'validation',
                  sourceRef: 'report',
                  locator: null,
                  summary: 'A cited observation passed.',
                  observedAt: '2026-01-01T00:00:00.000Z',
                  supportStrength: 'cited',
                  result: 'passed',
                  blocksClaim: false,
                },
              ],
            },
            derivation: {
              available: true,
              directInputs: [
                {
                  claimId: 'input-a',
                  status: 'verified',
                  source: 'derived',
                  edge: {
                    method: 'derived',
                    supportStrength: 'entails',
                    rationale: null,
                  },
                },
              ],
            },
            transparencyGaps: [
              {
                id: 'gap-a',
                claimId: 'claim-a',
                type: 'provenance_gap',
                severity: 'high',
                message: 'Missing direct provenance.',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        },
      },
    ];
    render(<TaskWorkspaceView taskId="task-alpha" />);

    expect(screen.getByText('Current standing')).toBeTruthy();
    expect(screen.getByText('claim-a')).toBeTruthy();
    expect(screen.getByText('artifact · artifact-a')).toBeTruthy();
    expect(screen.getByText('tests')).toBeTruthy();
    expect(screen.getByText('pass')).toBeTruthy();
    expect(
      screen.getByText('Stale · as of 2026-01-01T00:00:00.000Z'),
    ).toBeTruthy();
    expect(
      screen.getByRole('region', { name: 'Entails evidence' }).textContent,
    ).toContain('Blocking');
    expect(screen.getByText('Blocking')).toBeTruthy();
    expect(screen.getByText('Non-blocking')).toBeTruthy();
    expect(screen.getByText('entails-failed')).toBeTruthy();
    expect(screen.getByText('cited-passed')).toBeTruthy();
    expect(screen.getAllByText('test_output')).toHaveLength(2);
    expect(screen.getAllByText('entails')).toHaveLength(1);
    expect(screen.getAllByText('validation')).toHaveLength(2);
    expect(screen.getAllByText('report')).toHaveLength(2);
    expect(
      screen.getByText('Transparency gaps: 1 · highest severity: high.'),
    ).toBeTruthy();
    expect(
      screen.getByRole('region', { name: 'Cited evidence' }).textContent,
    ).toContain('A cited observation passed.');
    fireEvent.click(screen.getByText('Derivation and gaps'));
    expect(
      screen.getByText('provenance_gap · high · Missing direct provenance.'),
    ).toBeTruthy();
    expect(screen.getByText(/rationale not provided/)).toBeTruthy();
    expect(screen.getByText(/explicit authored association/i)).toBeTruthy();
    expect(
      screen.getByText(
        'No supported execution provenance is recorded. The explicit authored semantic support shown below is separate.',
      ),
    ).toBeTruthy();
  });

  test('formats structured claim values deterministically without object coercion', () => {
    expect(formatClaimValue({ b: 2, a: ['x'] })).toMatchObject({
      text: '{"a":["x"],"b":2}',
      truncated: false,
    });
    expect(formatClaimValue('x'.repeat(481))).toMatchObject({
      truncated: true,
      text: `${'x'.repeat(480)}…`,
    });
  });

  test('loads support choices only after opening and attaches the selected opaque claim', async () => {
    turnReferencesResult.data = [
      {
        id: 'answer-link-attach',
        state: 'available',
        sessionId: 'session-answer',
        turnId: 'turn-attach',
        answer: {
          role: 'assistant',
          content: 'Attach me.',
          turnId: 'turn-attach',
        },
        support: { state: 'unassessed' },
      },
    ];
    createAnswerSupportMutation.mutateAsync.mockResolvedValue({});
    render(<TaskWorkspaceView taskId="task-alpha" />);

    fireEvent.click(screen.getByRole('button', { name: 'Associate support' }));
    expect(
      screen.getByRole('dialog', { name: 'Associate answer support' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bundle-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'claim-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Attach support' }));
    await waitFor(() =>
      expect(createAnswerSupportMutation.mutateAsync).toHaveBeenCalledWith({
        taskId: 'task-alpha',
        referenceId: 'answer-link-attach',
        bundleId: 'bundle-a',
        claimId: 'claim-a',
      }),
    );
  });

  test('clears protected create selections after a rejected mutation and retains only generic feedback', async () => {
    turnReferencesResult.data = [
      {
        id: 'answer-create-fail',
        state: 'available',
        sessionId: 'session-fail',
        turnId: 'turn-fail',
        answer: { role: 'assistant', content: 'Fail', turnId: 'turn-fail' },
        support: { state: 'unassessed' },
      },
    ];
    createAnswerSupportMutation.mutateAsync.mockRejectedValue(
      new Error('bundle-secret 500'),
    );
    render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(screen.getByRole('button', { name: 'Associate support' }));
    fireEvent.click(screen.getByRole('button', { name: 'bundle-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'claim-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Attach support' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(
        /could not change answer support/i,
      ),
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'claim-a' })).toBeNull();
    expect(screen.getByRole('alert').textContent).not.toMatch(
      /bundle-secret|500/i,
    );
  });

  test('binds association to the opened answer and closes if the selected answer changes', () => {
    turnReferencesResult.data = [
      {
        id: 'answer-a',
        state: 'available',
        sessionId: 'session-a',
        turnId: 'turn-a',
        answer: { role: 'assistant', content: 'A', turnId: 'turn-a' },
        support: { state: 'unassessed' },
      },
      {
        id: 'answer-b',
        state: 'available',
        sessionId: 'session-b',
        turnId: 'turn-b',
        answer: { role: 'assistant', content: 'B', turnId: 'turn-b' },
        support: { state: 'unassessed' },
      },
    ];
    render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(screen.getByRole('button', { name: 'Associate support' }));
    expect(
      screen.getByRole('dialog').querySelector('.station-dialog__subtitle')
        ?.textContent,
    ).toBe('Session session-a · turn turn-a');
    fireEvent.click(
      screen.getAllByRole('button', { name: /Session session-b/ })[0],
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(createAnswerSupportMutation.mutateAsync).not.toHaveBeenCalled();
  });

  test('clears revoked selections before submit and withholds choices after a read failure', async () => {
    turnReferencesResult.data = [
      {
        id: 'answer-refresh',
        state: 'available',
        sessionId: 'session-refresh',
        turnId: 'turn-refresh',
        answer: {
          role: 'assistant',
          content: 'Refresh',
          turnId: 'turn-refresh',
        },
        support: { state: 'unassessed' },
      },
    ];
    const view = render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(screen.getByRole('button', { name: 'Associate support' }));
    fireEvent.click(screen.getByRole('button', { name: 'bundle-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'claim-a' }));
    answerSupportBundlesResult = {
      data: [{ id: 'bundle-b' }],
      isLoading: false,
    };
    view.rerender(<TaskWorkspaceView taskId="task-alpha" />);
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Attach support',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    answerSupportBundlesResult = {
      isLoading: false,
      error: new Error('denied'),
    };
    view.rerender(<TaskWorkspaceView taskId="task-alpha" />);
    expect(screen.getByText(/No cached support detail is shown/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'claim-a' })).toBeNull();
  });

  test('traps focus and restores it after Escape from support association', async () => {
    turnReferencesResult.data = [
      {
        id: 'answer-focus',
        state: 'available',
        sessionId: 'session-focus',
        turnId: 'turn-focus',
        answer: { role: 'assistant', content: 'Focus', turnId: 'turn-focus' },
        support: { state: 'unassessed' },
      },
    ];
    render(<TaskWorkspaceView taskId="task-alpha" />);
    const trigger = screen.getByRole('button', { name: 'Associate support' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    const bundle = screen.getByRole('button', { name: 'bundle-a' });
    await waitFor(() => expect(document.activeElement).toBe(bundle));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('confirms replacement and carries the server revision, while remove is explicit', async () => {
    turnReferencesResult.data = [
      {
        id: 'answer-link-replace',
        state: 'available',
        sessionId: 'session-answer',
        turnId: 'turn-replace',
        answer: {
          role: 'assistant',
          content: 'Replace me.',
          turnId: 'turn-replace',
        },
        support: {
          state: 'available',
          associationId: 'association-a',
          revision: 7,
          card: {
            found: true,
            claim: {
              id: 'claim-a',
              subject: { subjectType: 'artifact', subjectId: 'artifact-a' },
              claimType: 'quality.test',
              fieldOrBehavior: 'tests',
              value: 'pass',
              status: 'verified',
              freshness: null,
              materiality: null,
            },
            evidence: { entailing: [], cited: [] },
            derivation: { available: false, directInputs: [] },
            transparencyGaps: [],
          },
        },
      },
    ];
    replaceAnswerSupportMutation.mutateAsync.mockResolvedValue({});
    removeAnswerSupportMutation.mutateAsync.mockResolvedValue({});
    render(<TaskWorkspaceView taskId="task-alpha" />);

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    fireEvent.click(screen.getByRole('button', { name: 'bundle-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'claim-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review replacement' }));
    expect(
      screen.getByRole('alertdialog', { name: 'Replace answer support?' }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Replace association' }),
    );
    await waitFor(() =>
      expect(replaceAnswerSupportMutation.mutateAsync).toHaveBeenCalledWith({
        taskId: 'task-alpha',
        referenceId: 'answer-link-replace',
        bundleId: 'bundle-a',
        claimId: 'claim-a',
        expectedRevision: 7,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(
      screen.getByRole('alertdialog', { name: 'Remove answer support?' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove association' }));
    await waitFor(() =>
      expect(removeAnswerSupportMutation.mutateAsync).toHaveBeenCalledWith({
        taskId: 'task-alpha',
        referenceId: 'answer-link-replace',
        expectedRevision: 7,
      }),
    );

    replaceAnswerSupportMutation.mutateAsync.mockRejectedValue(
      new Error('claim-secret conflict 409'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    fireEvent.click(screen.getByRole('button', { name: 'bundle-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'claim-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review replacement' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Replace association' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(
        /could not change answer support/i,
      ),
    );
    expect(
      screen.getByRole('dialog', { name: 'Replace answer support' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'claim-a' })).toBeNull();
    expect(screen.getByRole('alert').textContent).not.toMatch(
      /claim-secret|409/i,
    );

    removeAnswerSupportMutation.mutateAsync.mockRejectedValue(
      new Error('unavailable server detail'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove association' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(
        /could not change answer support/i,
      ),
    );
    expect(
      screen.getByRole('alertdialog', { name: 'Remove answer support?' }),
    ).toBeTruthy();
    expect(screen.getByRole('alert').textContent).not.toMatch(
      /unavailable server detail/i,
    );
  });

  test.each([
    ['claim-missing', 'The associated claim is no longer available.'],
    ['corrupt', 'The associated Surface bundle/report cannot be interpreted.'],
    [
      'unsupported-version',
      'The associated support record uses an unsupported version.',
    ],
    ['unavailable', 'Semantic support is unavailable.'],
  ])(
    'keeps %s support state distinct and does not reveal protected detail',
    (state, label) => {
      turnReferencesResult.data = [
        {
          id: `answer-${state}`,
          state: 'available',
          sessionId: 'session-answer',
          turnId: 'turn-state',
          answer: {
            role: 'assistant',
            content: 'Stateful answer.',
            turnId: 'turn-state',
          },
          support: { state },
        },
      ];
      render(<TaskWorkspaceView taskId="task-alpha" />);
      expect(screen.getByText(label)).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Associate support' }),
      ).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Retry support' }),
      ).toBeTruthy();
      expect(
        screen.getByText(
          'No supported execution provenance is recorded. It is distinct from the semantic-support state shown below.',
        ),
      ).toBeTruthy();
      if (state === 'unavailable') {
        expect(screen.getByText(/No support detail is shown/)).toBeTruthy();
      }
    },
  );

  test('keeps an unsupported provenance envelope unreadable while retaining the available answer', () => {
    turnReferencesResult.data = [
      {
        id: 'answer-link-newer',
        state: 'available',
        sessionId: 'session-answer',
        turnId: 'turn-newer',
        answer: {
          role: 'assistant',
          content: 'The answer is still readable.',
          turnId: 'turn-newer',
          provenance: { envelopeVersion: 99 },
        },
        support: { state: 'unassessed' },
      },
    ];

    render(<TaskWorkspaceView taskId="task-alpha" />);

    expect(screen.getByText('The answer is still readable.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Basis' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Open Whole Task Basis' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Provenance was recorded in a format this version of Station cannot read. Nothing about this answer is being claimed from it.',
      ),
    ).toBeTruthy();
  });

  test('opens an exact kept answer in the real Task pane host on desktop', async () => {
    const request = vi.fn<WorkspacePaneHostLockManager['request']>(
      async (_name, _options, callback) => callback({}),
    );
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: { request },
    });
    roomDiscoveryResult = {
      data: {
        kind: 'existing',
        scope: { taskId: 'task-alpha' },
        capabilities: {
          documentRead: true,
          documentWrite: true,
          historyRead: true,
          messageWrite: true,
          revisionLinks: true,
          live: true,
        },
      },
      isLoading: false,
    };
    roomDocumentResult = {
      data: { kind: 'snapshot', document: { blocks: [] } },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    turnReferencesResult.data = [
      {
        id: 'answer-link',
        state: 'available',
        sessionId: 'session-answer',
        turnId: 'turn-answer',
        answer: {
          role: 'assistant',
          content: 'Pane-bound answer.',
          turnId: 'turn-answer',
        },
        support: { state: 'unassessed' },
      },
    ];

    const basisQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={basisQueryClient}>
        <TaskWorkspaceView taskId="task-alpha" />
      </QueryClientProvider>,
    );
    const open = await screen.findByRole('button', { name: 'Open Basis' });
    await waitFor(() => expect(request).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(open);
    expect(await screen.findByTestId('task-basis-pane')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Basis' })).toBeNull();
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
  });

  test('renders an unavailable answer as a generic typed state with no identity or count disclosure', () => {
    turnReferencesResult.data = [
      { id: 'opaque-unavailable-reference', state: 'unavailable' },
    ];

    render(<TaskWorkspaceView taskId="task-alpha" />);

    const basis = screen.getByRole('region', { name: 'Kept answers' });
    expect(basis.textContent).toContain('An answer is unavailable');
    expect(basis.textContent).toContain(
      'A pinned answer cannot be reopened by this Station.',
    );
    expect(basis.textContent).not.toMatch(/\d/);
    expect(screen.queryByText(/session-answer|turn-answer/)).toBeNull();
  });

 // AW-4: the three optional experiences used to be filtered out by a
// hardcoded `id === 'direct'` — collapsed, but not driven by anything. An
// installed, ENABLED producer that declares the contract must make its
// experience appear.
  test('shows an optional experience once an installed plugin declares it', () => {
    pluginsResult.data = [
      {
        enabled: true,
        manifest: { capabilities: ['station.task-experience.deliver'] },
      },
    ];
    render(<TaskWorkspaceView taskId="task-alpha" />);

    expect(
      screen.getByRole('heading', { name: 'Task experiences' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Deliver/i })).toBeTruthy();
// The other two still have no producer and stay behind the affordance.
    expect(screen.queryByRole('button', { name: /^Learn/i })).toBeNull();
  });

  test('a disabled producer is not a producer this page can open', () => {
    pluginsResult.data = [
      {
        enabled: false,
        manifest: { capabilities: ['station.task-experience.deliver'] },
      },
    ];
    render(<TaskWorkspaceView taskId="task-alpha" />);

    expect(
      screen.getByRole('heading', { name: 'Task inspection' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Deliver/i })).toBeNull();
  });

  test('shows exact Task and workspace bindings without inferring missing values', () => {
    queryResult.data = graph({
      workspaceBinding: { availability: 'available', worktreePath: '/task' },
    });
    render(<TaskWorkspaceView taskId="task-alpha" />);

    expect(screen.getAllByText('Inspect the workspace')).toHaveLength(2);
    expect(screen.getByText('Task ID')).toBeTruthy();
    expect(screen.getByText('Git top-level/repository root')).toBeTruthy();
// Missing workspace facts remain visibly unavailable; the hidden items
// are only the three product experiences that cannot actually open.
    expect(screen.getAllByText('Unavailable')).toHaveLength(3);
    expect(screen.getByText('/task')).toBeTruthy();
  });

  test('remains useful when optional integrations are absent', () => {
    render(<TaskWorkspaceView taskId="task-alpha" />);
    expect(screen.getByText('Optional integrations not attached')).toBeTruthy();
    expect(screen.getByText('Inspect worktree diff')).toBeTruthy();
    expect(screen.getByText('Local references')).toBeTruthy();
    expect(
      screen.getByText(/Inspection is not a verification claim/i),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Task inspection' }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Add capabilities' })
        .getAttribute('href'),
    ).toBe('/plugins');
    expect(screen.queryByRole('button', { name: /Deliver/i })).toBeNull();
  });

  test('hides unavailable product experiences behind one capability affordance', () => {
    render(<TaskWorkspaceView taskId="task-alpha" />);
    expect(screen.getAllByText('Inspect the workspace')).toHaveLength(2);
    expect(screen.getByText('task-alpha')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add capabilities' })).toBeTruthy();
    expect(screen.queryByText('Task experiences')).toBeNull();
    expect(screen.queryByText(/^(complete|completed|done)$/i)).toBeNull();
  });

  test('does not promote arbitrary external metadata into first-party authority', () => {
    queryResult.data = graph();
    queryResult.data.links.push({
      id: 'untrusted-1',
      sourceType: 'task',
      sourceId: 'task-alpha',
      targetType: 'external',
      targetId: 'https://attacker.example/work-items/42',
      relationType: 'references_external',
      confidence: 1,
      createdAt: '2026-07-19T00:00:00.000Z',
      source: 'user',
      metadata: {
        experience: 'deliver',
        href: 'https://attacker.example/phishing',
        lifecycle: 'complete',
      },
    });
    render(<TaskWorkspaceView taskId="task-alpha" />);

    expect(screen.getByRole('link', { name: 'Add capabilities' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /attacker\.example/i }),
    ).toBeTruthy();
    expect(screen.queryByText('Authority: Builder Kit')).toBeNull();
    expect(screen.queryByText(/^(complete|completed|done)$/i)).toBeNull();
  });

  test('keeps stale workspace identity visible but disables local inspection', () => {
    queryResult.data = graph({
      workspaceBinding: {
        availability: 'unavailable',
        worktreePath: '/missing/task',
        branch: 'agent/stale',
      },
    });
    render(<TaskWorkspaceView taskId="task-alpha" />);

    expect(screen.getByText('/missing/task')).toBeTruthy();
    expect(screen.getByText('Task workspace is unavailable')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Inspect worktree diff' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: /reports\/result\.md/i }),
    );
    expect(screen.queryByTestId('file-content')).toBeNull();
  });

  test('selects artifact, receipt, and changed-file references for safe inline content', () => {
    render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(
      screen.getByRole('button', { name: /reports\/result\.md/i }),
    );
    expect(screen.getByTestId('file-content').textContent).toBe(
      '/project/worktrees/task-alpha:reports/result.md',
    );

    fireEvent.click(
      screen.getByRole('button', { name: /receipts\/verify\.md/i }),
    );
    expect(screen.getByTestId('file-content').textContent).toBe(
      '/project/worktrees/task-alpha:receipts/verify.md',
    );

    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/i }));
    expect(screen.getByTestId('file-content').textContent).toBe(
      '/project/worktrees/task-alpha:src/app.ts',
    );
    expect(
      screen.getByRole('button', { name: 'View worktree diff' }),
    ).toBeTruthy();
  });

  test('does not fetch opaque or outside references as local content', () => {
    queryResult.data = graph();
    queryResult.data.links.push(
      {
        id: 'opaque-1',
        sourceType: 'task',
        sourceId: 'task-alpha',
        targetType: 'artifact',
        targetId: 'https://example.test/result',
        relationType: 'references_artifact',
        confidence: 1,
        createdAt: '2026-07-19T00:00:00.000Z',
        source: 'user',
      },
      {
        id: 'outside-1',
        sourceType: 'task',
        sourceId: 'task-alpha',
        targetType: 'receipt',
        targetId: '/outside/receipt.md',
        relationType: 'references_receipt',
        confidence: 1,
        createdAt: '2026-07-19T00:00:00.000Z',
        source: 'user',
      },
    );
    render(<TaskWorkspaceView taskId="task-alpha" />);

    fireEvent.click(screen.getByRole('button', { name: /example\.test/i }));
    expect(screen.queryByTestId('file-content')).toBeNull();
    expect(screen.getByText('Reference content is unavailable')).toBeTruthy();
    expect(
      screen.getByText(
        'Station could not resolve this reference to a safe file path inside the exact Task workspace.',
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: /outside\/receipt\.md/i }),
    );
    expect(screen.queryByTestId('file-content')).toBeNull();
  });

// archive#3158: one message used to cover both, so a Task with no workspace
// read as a problem with whichever reference the user happened to click.
  test('names the missing workspace rather than blaming the reference', () => {
    queryResult.data = graph({
      workspaceBinding: { availability: 'unavailable' },
    });
    render(<TaskWorkspaceView taskId="task-alpha" />);

    fireEvent.click(
      screen.getByRole('button', { name: /reports\/result\.md/i }),
    );

    expect(screen.queryByTestId('file-content')).toBeNull();
    expect(
      screen.getByText(
        'This Task has no available workspace, so Station cannot resolve any reference to a local file.',
      ),
    ).toBeTruthy();
// The same reference resolves cleanly when a workspace IS bound, so the
// message above is about the Task, not about this reference.
    expect(
      screen.queryByText(
        'Station could not resolve this reference to a safe file path inside the exact Task workspace.',
      ),
    ).toBeNull();
  });

  test('opens a whole-worktree diff only from the exact bound workspace', () => {
    render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect worktree diff' }),
    );
    expect(screen.getByTestId('diff-panel').textContent).toBe(
      '/project/worktrees/task-alpha',
    );
  });

  test('resets a selected reference when the Task id changes', async () => {
    const { rerender } = render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(
      screen.getByRole('button', { name: /reports\/result\.md/i }),
    );
    expect(screen.getByTestId('file-content')).toBeTruthy();

    queryResult.data = graph({ id: 'task-beta', title: 'Other task' });
    rerender(<TaskWorkspaceView taskId="task-beta" />);
    await waitFor(() =>
      expect(screen.queryByTestId('file-content')).toBeNull(),
    );
    expect(screen.getByText('Select a reference to inspect')).toBeTruthy();
  });

  test('renders loading, error, and Task 404 states', () => {
    queryResult = { data: undefined, isLoading: true, refetch: vi.fn() };
    const { rerender } = render(<TaskWorkspaceView taskId="task-alpha" />);
    expect(
      screen.getByRole('status', { name: 'Loading task workspace' }),
    ).toBeTruthy();

    queryResult = {
      data: undefined,
      isLoading: false,
      error: new Error('HTTP 404'),
      refetch: vi.fn(),
    };
    rerender(<TaskWorkspaceView taskId="task-alpha" />);
    expect(screen.getByText('Task not found')).toBeTruthy();
  });

  test('only returns safe relative workspace paths', () => {
    expect(relativeWorkspacePath('src/index.ts', '/repo')).toBe('src/index.ts');
    expect(relativeWorkspacePath('/repo/src/index.ts', '/repo')).toBe(
      'src/index.ts',
    );
    expect(
      relativeWorkspacePath('file:///repo/src/index.ts', '/repo'),
    ).toBeNull();
    expect(relativeWorkspacePath('/other/src/index.ts', '/repo')).toBeNull();
    expect(relativeWorkspacePath('../secrets.txt', '/repo')).toBeNull();
  });

  test('promotes the selected safe local reference without offering a manual path', () => {
    render(<TaskWorkspaceView taskId="task-alpha" />);

    expect(screen.queryByLabelText('Workspace-relative file')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/i }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Keep src/app.ts as output' }),
    );

    expect(createOutputMutation.mutate).toHaveBeenCalledTimes(1);
    expect(createOutputMutation.mutate.mock.calls[0][0]).toMatchObject({
      taskId: 'task-alpha',
      relativePath: 'src/app.ts',
      title: 'app.ts',
    });
  });

  test('keeps an operation id stable when a selected-file promotion can be retried', async () => {
    render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/i }));
    const keep = screen.getByRole('button', {
      name: 'Keep src/app.ts as output',
    });
    fireEvent.click(keep);
    const [firstInput, firstOptions] =
      createOutputMutation.mutate.mock.calls[0];
    act(() => firstOptions.onError(new Error('Request timed out')));

    expect(screen.getByRole('alert').textContent).toMatch(/Couldn’t keep/i);
    fireEvent.click(keep);
    const [secondInput] = createOutputMutation.mutate.mock.calls[1];
    expect(secondInput.operationId).toBe(firstInput.operationId);

    await act(async () => {
      await firstOptions.onSuccess(taskOutput());
    });
    expect(screen.getByText(/Kept “app.ts”/)).toBeTruthy();
    expect(taskOutputsResult.refetch).toHaveBeenCalledTimes(1);
  });

  test('renders output query failure and lets the reader retry it', () => {
    taskOutputsResult = {
      data: undefined,
      isLoading: false,
      error: new Error('Offline'),
      refetch: vi.fn(),
    };
    render(<TaskWorkspaceView taskId="task-alpha" />);

    expect(screen.getByRole('alert').textContent).toContain(
      'Couldn’t load Task outputs: Offline',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry outputs' }));
    expect(taskOutputsResult.refetch).toHaveBeenCalledTimes(1);
  });

  test('requires a named confirmation and returns focus when output deletion is cancelled', async () => {
    taskOutputsResult.data = [taskOutput()];
    render(<TaskWorkspaceView taskId="task-alpha" />);

    const deleteButton = screen.getByRole('button', {
      name: 'Delete output local.md',
    });
    fireEvent.click(deleteButton);
    const confirmation = screen.getByRole('alertdialog', {
      name: 'Delete “local.md”?',
    });
    const input = screen.getByRole('textbox', {
      name: 'Confirm deletion of local.md',
    });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(
      (
        screen.getByRole('button', {
          name: 'Delete local.md',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.change(input, { target: { value: 'local.md' } });
    expect(
      (
        screen.getByRole('button', {
          name: 'Delete local.md',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel deleting local.md' }),
    );
    expect(document.body.contains(confirmation)).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(deleteButton));
  });

  test('reports deletion failures and never inline-renders unsafe output media', async () => {
    taskOutputsResult.data = [
      taskOutput({
        title: 'unsafe.html',
        materialization: {
          ...taskOutput().materialization,
          fileName: 'unsafe.html',
          mediaType: 'text/html',
        },
      }),
    ];
    downloadOutputContent.mockResolvedValue({
      bytes: new TextEncoder().encode('<script>window.pwned = true</script>'),
      mediaType: 'text/html',
      fileName: 'unsafe.html',
      etag: null,
    });
    render(<TaskWorkspaceView taskId="task-alpha" />);

    fireEvent.click(
      screen.getByRole('button', { name: 'View output unsafe.html' }),
    );
    await waitFor(() =>
      expect(screen.getByText(/download-only/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/window\.pwned/)).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete output unsafe.html' }),
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Confirm deletion of unsafe.html' }),
      { target: { value: 'unsafe.html' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete unsafe.html' }));
    const [, options] = deleteOutputMutation.mutate.mock.calls[0];
    act(() => options.onError(new Error('Still in use')));
    expect(screen.getByRole('alert').textContent).toMatch(
      /Couldn’t delete.*Still in use/i,
    );
  });

  test('renders PNG only from the exact safe server receipt and revokes its URL', async () => {
    taskOutputsResult.data = [
      taskOutput({
        title: 'safe.png',
        materialization: {
          ...taskOutput().materialization,
          fileName: 'safe.png',
          mediaType: 'image/png',
        },
      }),
    ];
    const createUrl = vi.fn(() => 'blob:safe-output');
    const revokeUrl = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: createUrl,
        revokeObjectURL: revokeUrl,
      }),
    );
    downloadOutputContent.mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71]),
      mediaType: 'image/png',
      fileName: 'safe.png',
      etag: null,
      safePreview: 'image/png',
    });
    const { unmount } = render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(
      screen.getByRole('button', { name: 'View output safe.png' }),
    );
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy());
    expect(createUrl).toHaveBeenCalledTimes(1);
    unmount();
    expect(revokeUrl).toHaveBeenCalledWith('blob:safe-output');
  });

  test('never previews PNG without its receipt or executable markup', async () => {
    for (const [title, type, receipt] of [
      ['spoof.png', 'image/png', null],
      ['unsafe.svg', 'image/svg+xml', null],
      ['unsafe.html', 'text/html', null],
    ] as const) {
      taskOutputsResult.data = [
        taskOutput({
          title,
          materialization: {
            ...taskOutput().materialization,
            fileName: title,
            mediaType: type,
          },
        }),
      ];
      const createUrl = vi.fn();
      vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl }));
      downloadOutputContent.mockResolvedValue({
        bytes: new TextEncoder().encode('<svg><script>x</script></svg>'),
        mediaType: type,
        fileName: title,
        etag: null,
        safePreview: receipt,
      });
      const view = render(<TaskWorkspaceView taskId="task-alpha" />);
      fireEvent.click(
        screen.getByRole('button', { name: `View output ${title}` }),
      );
      await waitFor(() =>
        expect(screen.getByText(/download-only/i)).toBeTruthy(),
      );
      expect(screen.queryByRole('img')).toBeNull();
      expect(createUrl).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  test('canonical delete dialog traps both tab directions and returns focus for Escape and Cancel', async () => {
    taskOutputsResult.data = [taskOutput()];
    render(<TaskWorkspaceView taskId="task-alpha" />);
    const trigger = screen.getByRole('button', {
      name: 'Delete output local.md',
    });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('alertdialog');
    const input = screen.getByRole('textbox', {
      name: 'Confirm deletion of local.md',
    });
    const remove = screen.getByRole('button', { name: 'Delete local.md' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    remove.focus();
    fireEvent.keyDown(remove, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    input.focus();
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    const reopenedInput = screen.getByRole('textbox', {
      name: 'Confirm deletion of local.md',
    });
    await waitFor(() => expect(document.activeElement).toBe(reopenedInput));
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel deleting local.md' }),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('persists same-intent operation IDs across remount, rejects corrupt values, and clears on success', async () => {
    const view = render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/i }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Keep src/app.ts as output' }),
    );
    const [first, options] = createOutputMutation.mutate.mock.calls[0];
    act(() => options.onError(new Error('timeout')));
    view.unmount();
    const remount = render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/i }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Keep src/app.ts as output' }),
    );
    expect(createOutputMutation.mutate.mock.calls[1][0].operationId).toBe(
      first.operationId,
    );
    await act(async () => {
      await createOutputMutation.mutate.mock.calls[1][1].onSuccess(
        taskOutput(),
      );
    });
    remount.unmount();
    const next = render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/i }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Keep src/app.ts as output' }),
    );
    expect(createOutputMutation.mutate.mock.calls[2][0].operationId).not.toBe(
      first.operationId,
    );
    next.unmount();
  });

  test('replaces corrupt persisted output operation identity', () => {
    const intent = encodeURIComponent(
      JSON.stringify({
        taskId: 'task-alpha',
        relativePath: 'src/app.ts',
        title: 'app.ts',
      }),
    );
    window.sessionStorage.setItem(
      `station.task-output-operation.v1:${intent}`,
      'not a valid operation id!',
    );
    render(<TaskWorkspaceView taskId="task-alpha" />);
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/i }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Keep src/app.ts as output' }),
    );
    expect(createOutputMutation.mutate.mock.calls[0][0].operationId).not.toBe(
      'not a valid operation id!',
    );
  });

  test('renders pinned inputs directly after Kept answers with authored content and disclosed origin', () => {
    turnReferencesResult.data = [];
    userInputReferencesResult.data = [
      {
        id: 'input-link',
        state: 'available',
        sessionId: 'session-origin',
        turnId: 'turn-origin',
        eventId: 'event-origin',
        input: {
          prompt: 'A very long hostile-looking prompt '.repeat(30),
          attachments: [
            { name: 'brief.pdf', mediaType: 'application/pdf', size: 2048 },
          ],
        },
      },
    ];
    render(<TaskWorkspaceView taskId="task-alpha" />);
    const basis = screen.getByRole('region', { name: 'Kept answers' });
    const inputs = screen.getByRole('region', { name: 'Pinned inputs' });
    expect(
      basis.compareDocumentPosition(inputs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(inputs.textContent).toContain(
      'Explicitly pinned input from this Task’s work context. It was not inferred to support any answer.',
    );
    expect(inputs.textContent).toContain(
      'brief.pdf · application/pdf · 2,048 bytes',
    );
    const origin = inputs.querySelector('details');
    expect(origin?.open).toBe(false);
    fireEvent.click(screen.getByText('View origin'));
    expect(inputs.textContent).toContain('session-origin');
    expect(inputs.textContent).toContain('turn-origin');
    expect(inputs.textContent).toContain('event-origin');
    expect(basis.contains(inputs)).toBe(false);
  });

  test('withholds unavailable pinned-input identity and cached detail', () => {
    userInputReferencesResult.data = [{ state: 'unavailable' }];
    render(<TaskWorkspaceView taskId="task-alpha" />);
    const inputs = screen.getByRole('region', { name: 'Pinned inputs' });
    expect(inputs.textContent).toContain(
      'This pinned input cannot be reopened by this Station.',
    );
    expect(inputs.textContent).not.toMatch(/session|turn|event|\d/i);
  });

  test('renders a generic retry when the protected read has no current data', () => {
    userInputReferencesResult = {
      data: undefined,
      isLoading: false,
      error: new Error('protected tuple must not render'),
    };
    render(<TaskWorkspaceView taskId="task-alpha" />);
    const region = screen.getByRole('region', { name: 'Pinned inputs' });
    expect(region.textContent).toContain('Pinned inputs are unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText(/protected tuple/i)).toBeNull();
  });

  test('does not invent an authored-prompt label for an attachment-only input', () => {
    userInputReferencesResult.data = [
      {
        id: 'attachment-only',
        state: 'available',
        sessionId: 'session-a',
        turnId: 'turn-a',
        eventId: 'event-a',
        input: {
          prompt: '',
          attachments: [{ name: 'only.png', mediaType: 'image/png', size: 12 }],
        },
      },
    ];
    render(<TaskWorkspaceView taskId="task-alpha" />);
    const region = screen.getByRole('region', { name: 'Pinned inputs' });
    expect(region.textContent).toContain('only.png · image/png · 12 bytes');
    expect(screen.queryByText('Authored prompt')).toBeNull();
  });
});
