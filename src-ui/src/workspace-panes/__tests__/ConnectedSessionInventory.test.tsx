/** @vitest-environment jsdom */

import type { SessionInventoryProjection } from '@kontourai/station-contracts/session-inventory';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { commitSessionInventorySelection } from '../sessionInventorySelection';

const hooks = vi.hoisted(() => ({
  inventory: vi.fn(),
  page: vi.fn(),
  inspection: vi.fn(),
  tasks: vi.fn(),
  keep: vi.fn(),
  answer: vi.fn(),
  authority: {
    apiBase: 'http://station.test',
    authorityKey: 'epoch-a',
  },
}));

vi.mock('@kontourai/station-sdk/session-inventory', () => ({
  useSessionInventoryQuery: (...args: unknown[]) => hooks.inventory(...args),
  useSessionInventoryGroupPage: (...args: unknown[]) => hooks.page(...args),
}));
vi.mock('@kontourai/station-sdk/session-outputs', () => ({
  useSessionOutputInspection: (...args: unknown[]) => hooks.inspection(...args),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useTasksQuery: (...args: unknown[]) => hooks.tasks(...args),
}));
vi.mock('@kontourai/station-sdk/session-output-actions', () => ({
  useKeepSessionOutputMutation: () => ({
    isPending: false,
    mutateAsync: hooks.keep,
  }),
}));
vi.mock('@kontourai/station-sdk/answer-basis', () => ({
  useAnswerBasisQuery: (...args: unknown[]) => hooks.answer(...args),
}));
vi.mock('@kontourai/surface/basis/view', () => ({
  buildBasisPanelViewModel: () => ({
    title: 'Current answer',
    standing: { label: 'Grounded', description: 'Owner-backed.' },
    gaps: [],
    assessment: {
      claimStatus: 'supported',
      freshness: 'current',
      evidence: [
        {
          id: 'evidence',
          label: 'Evidence',
          items: Array.from({ length: 21 }, (_, index) => ({
            id: `evidence-${index + 1}`,
            label: `Evidence ${index + 1}`,
            source: 'owner',
            observedAt: 'now',
          })),
        },
      ],
    },
  }),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => hooks.authority,
}));

const output = {
  kind: 'station-session-output' as const,
  key: 'output',
  owner: { owner: 'thread', id: 'output' },
  relations: ['produced-by'] as const,
  output: {
    ref: { sessionId: 'session', eventId: 'event-output' },
    turnId: 'turn',
    toolCallId: 'call',
    declaredAt: '2026-08-27T00:00:00.000Z',
    label: 'report.txt',
    descriptor: {
      kind: 'workspace-file' as const,
      relativePath: 'report.txt',
      digest: 'a'.repeat(64),
      length: 1,
    },
  },
};

const projection: SessionInventoryProjection = {
  version: 'station.session-inventory/v1',
  scope: { kind: 'whole-session', sessionId: 'session' },
  groups: [
    {
      id: 'outputs',
      owner: { owner: 'thread', id: 'outputs' },
      state: 'available',
      count: { kind: 'at-least', value: 2 },
      items: [output],
      continuation: 'next-outputs',
      gaps: [],
    },
  ],
};

const requestScope = {
  apiBase: 'http://station.test',
  authorityKey: 'epoch-a',
};

function configure() {
  hooks.inventory.mockReturnValue({
    data: projection,
    isLoading: false,
    error: null,
  });
  hooks.page.mockReturnValue({ data: undefined });
  hooks.inspection.mockReturnValue({
    data: { kind: 'metadata' },
    isLoading: false,
    error: null,
  });
  hooks.tasks.mockReturnValue({
    data: [{ id: 'task-a', title: 'Task A' }],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  hooks.keep.mockResolvedValue({ outcome: 'kept' });
  hooks.answer.mockReturnValue({
    data: { protected: 'answer' },
    isLoading: false,
    error: null,
  });
}

const { ConnectedSessionInventory } = await import(
  '../ConnectedSessionInventory'
);

describe('ConnectedSessionInventory', () => {
  test('defers inspection, paging, and Task reads until their explicit actions', async () => {
    configure();
    hooks.inspection.mockClear();
    hooks.tasks.mockClear();
    hooks.page.mockClear();
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    expect(hooks.inspection).not.toHaveBeenCalled();
    expect(hooks.tasks).not.toHaveBeenCalled();
    expect(hooks.page).toHaveBeenLastCalledWith(
      expect.anything(),
      'inputs',
      undefined,
      expect.objectContaining({ enabled: false, requestScope }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Outputs2\+$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect output' }));
    await waitFor(() =>
      expect(hooks.inspection).toHaveBeenLastCalledWith(
        'session',
        'event-output',
        expect.objectContaining({ enabled: true, requestScope }),
      ),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Close Session output' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more Outputs' }));
    await waitFor(() =>
      expect(hooks.page).toHaveBeenLastCalledWith(
        expect.anything(),
        'outputs',
        'next-outputs',
        expect.objectContaining({ enabled: true, requestScope }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep file' }));
    await waitFor(() =>
      expect(hooks.tasks).toHaveBeenLastCalledWith(
        'project',
        expect.objectContaining({ enabled: true, requestScope }),
      ),
    );
  });

  test('keeps only in the explicitly selected Task with the captured authority', async () => {
    configure();
    hooks.keep.mockClear();
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Outputs2\+$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep file' }));
    fireEvent.click(await screen.findByRole('button', { name: /Task A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Task' }));
    await waitFor(() =>
      expect(hooks.keep).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-a',
          sessionId: 'session',
          eventId: 'event-output',
          requestScope,
        }),
      ),
    );
  });

  test('fails closed and retries when an authorized page is denied', async () => {
    configure();
    const refetch = vi.fn();
    hooks.page.mockImplementation(
      (_scope: unknown, _group: unknown, continuation: unknown) =>
        continuation
          ? { data: undefined, error: new Error('denied'), refetch }
          : { data: undefined, error: null, refetch },
    );
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Outputs2\+$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more Outputs' }));
    expect(screen.getByRole('alert').textContent).toContain('unavailable');
    expect(screen.queryByText('report.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry page' }));
    expect(refetch).toHaveBeenCalled();
  });

  test('retains the preview and every authorized page while continuations advance', async () => {
    configure();
    const second = {
      ...output,
      key: 'output-2',
      output: {
        ...output.output,
        ref: { sessionId: 'session', eventId: 'event-2' },
        label: 'page two',
      },
    };
    const third = {
      ...output,
      key: 'output-3',
      output: {
        ...output.output,
        ref: { sessionId: 'session', eventId: 'event-3' },
        label: 'page three',
      },
    };
    hooks.page.mockImplementation(
      (_scope: unknown, _group: unknown, continuation: unknown) => {
        if (continuation === 'next-outputs')
          return {
            data: {
              version: projection.version,
              scope: projection.scope,
              group: {
                ...projection.groups[0]!,
                items: [output, second],
                continuation: 'third-page',
              },
            },
            error: null,
          };
        if (continuation === 'third-page')
          return {
            data: {
              version: projection.version,
              scope: projection.scope,
              group: { ...projection.groups[0]!, items: [third] },
            },
            error: null,
          };
        return { data: undefined, error: null };
      },
    );
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Outputs2\+$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more Outputs' }));
    await waitFor(() => expect(screen.getByText('page two')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Load more Outputs' }));
    await waitFor(() => expect(screen.getByText('page three')).toBeTruthy());
    expect(screen.getByText('report.txt')).toBeTruthy();
    expect(
      screen.getAllByRole('button', { name: /Select item \d+ in Outputs/ }),
    ).toHaveLength(3);
  });

  test('does not publish a late kept result after the bound pane unmounts', async () => {
    configure();
    let resolve: (value: { outcome: 'kept' }) => void = () => {};
    hooks.keep.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    commitSessionInventorySelection(
      { ...requestScope, sessionId: 'session' },
      {
        scope: { kind: 'kept-in-task', sessionId: 'session', taskId: 'task-a' },
        groupId: 'outputs',
      },
    );
    hooks.inventory.mockReturnValue({
      data: {
        ...projection,
        scope: { kind: 'kept-in-task', sessionId: 'session', taskId: 'task-a' },
      },
      isLoading: false,
      error: null,
    });
    const view = render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep file' }));
    expect(hooks.keep).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-a',
        requestScope,
      }),
    );
    view.unmount();
    resolve({ outcome: 'kept' });
    await Promise.resolve();
    expect(screen.queryByText('Kept')).toBeNull();
  });

  test('keeps current-answer assessment disclosure and evidence windows local to its authority tuple', () => {
    configure();
    const current = {
      kind: 'current-answer' as const,
      sessionId: 'session',
      turnId: 'turn-a',
    };
    commitSessionInventorySelection(
      { ...requestScope, sessionId: 'session' },
      { scope: current, groupId: 'inputs' },
    );
    hooks.inventory.mockReturnValue({
      data: {
        ...projection,
        scope: current,
        basis: {} as never,
        basisBinding: {} as never,
      },
      isLoading: false,
      error: null,
    });
    const view = render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    const assessment = screen.getByText('Assessment').closest('details');
    expect(assessment?.open).toBe(false);
    fireEvent.click(screen.getByText('Assessment'));
    expect(assessment?.open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show more Evidence' }));
    expect(screen.getByText(/^Evidence 21/)).toBeTruthy();
    fireEvent.click(screen.getByText('Assessment'));
    fireEvent.click(screen.getByText('Assessment'));
    expect(screen.getByText(/^Evidence 21/)).toBeTruthy();

    hooks.authority = {
      apiBase: 'http://station.test',
      authorityKey: 'epoch-b',
    };
    commitSessionInventorySelection(
      { ...hooks.authority, sessionId: 'session' },
      { scope: current, groupId: 'inputs' },
    );
    view.rerender(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
      />,
    );
    const reauthorizedAssessment = screen
      .getByText('Assessment')
      .closest('details');
    expect(reauthorizedAssessment?.open).toBe(false);
    expect(screen.queryByText(/^Evidence 21/)).toBeNull();
    hooks.authority = requestScope;
  });
});
