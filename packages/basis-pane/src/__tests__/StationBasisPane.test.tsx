// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import {
  StationBasisPane,
  type StationBasisPaneExecutionActionInput,
} from '../StationBasisPane';

const hooks = vi.hoisted(() => ({
  answer: vi.fn(),
  task: vi.fn(),
  viewOverride: null as unknown,
}));
vi.mock('@kontourai/station-sdk/answer-basis', () => ({
  useAnswerBasisQuery: hooks.answer,
}));
vi.mock('@kontourai/station-sdk/task-basis', () => ({
  useTaskBasisQuery: hooks.task,
}));
vi.mock('@kontourai/surface/basis/view', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/surface/basis/view')>();
  return {
    ...actual,
    buildBasisPanelViewModel: (projection: unknown) =>
      hooks.viewOverride ?? actual.buildBasisPanelViewModel(projection),
  };
});

function projection(messageId: string) {
  return {
    version: 'surface.basis-projection/v1',
    answer: {
      owner: { authority: '@kontourai/thread' },
      state: 'available',
      observedAt: '2026-08-25T00:00:00.000Z',
      value: {
        ref: {
          authority: '@kontourai/thread',
          schemaVersion: '1.2.0',
          kind: 'assistant-message',
          standing: 'observed',
          threadId: 'session',
          messageId,
        },
        fact: 'answer-observed',
        observedAt: '2026-08-25T00:00:00.000Z',
      },
    },
    standing: 'execution-only',
    unresolvedReason: null,
    assessment: {
      owner: { authority: '@kontourai/surface' },
      state: 'not-captured',
      observedAt: '2026-08-25T00:00:00.000Z',
    },
    regions: {
      inputs: [],
      execution: [],
      process: [],
      outcomes: [],
      support: [],
      sources: [],
      live: [],
    },
    relationships: [],
    gaps: [],
  };
}

interface QueryFixture {
  data: unknown;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
}
const idle: QueryFixture = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  error: null,
};

function ContinuityActions({
  input,
}: {
  input: StationBasisPaneExecutionActionInput;
}) {
  const inspect = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!input.restoreFocusAction) return;
    // A refreshed kept result makes Keep unavailable, so the host restores the
    // next useful action instead.
    inspect.current?.focus();
    input.onFocusRestoreHandled?.();
  }, [input]);
  return (
    <>
      <button
        type="button"
        aria-label="Inspect tool result"
        onFocus={() => input.onActionFocus?.('inspect')}
        onBlur={() => input.onActionBlur?.()}
        ref={inspect}
      >
        Inspect
      </button>
      <button
        type="button"
        aria-label="Keep in Task"
        onFocus={() => input.onActionFocus?.('keep')}
        onBlur={() => input.onActionBlur?.()}
      >
        Keep
      </button>
    </>
  );
}

function projectionWithExecution(messageId: string) {
  const basis = projection(messageId);
  basis.regions.execution = [
    {
      ref: {
        authority: '@kontourai/thread',
        schemaVersion: '1.2.0',
        kind: 'result',
        threadId: 'session',
        resultId: 'result',
      },
      role: 'execution',
      context: {
        kind: 'thread-result',
        name: 'Retained result',
        terminalStatus: 'success',
        truncatedParts: 0,
        omittedParts: 0,
      },
      gaps: [],
    },
  ] as never;
  return basis;
}

function keptGateEvaluation(selectedEvidence = 1) {
  return {
    referenceId: 'flow-evaluation-link',
    kept: true,
    evaluation: {
      ref: {
        runId: 'flow-run',
        gateId: 'review',
        evaluationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      evaluatedAt: '2026-08-26T00:00:00.000Z',
      originalVerdict: 'pass',
      kind: 'recheck',
      trigger: 'freshness',
      previousRef: {
        runId: 'flow-run',
        gateId: 'review',
        evaluationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      currentStanding: 'invalidated',
      currentRun: { status: 'active', currentStep: 'review' },
      currentPersistedGateRef: {
        runId: 'flow-run-current',
        gateId: 'review',
        evaluationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
      validityAsOf: '2026-08-26T00:30:00.000Z',
      validityScope: 'retained-immutable-bundle',
      externalRevocation: 'not-observed',
      exceptionId: 'approved-exception',
      routeBack: {
        attempt: 2,
        maxAttempts: 3,
        reason: 'Need a fresh review',
        selectedRoute: 'review',
      },
      selectedEvidence: Array.from(
        { length: selectedEvidence },
        (_, index) => ({
          evidenceId: `selected-evidence-${index}`,
          standing: 'superseded',
          freshness: 'stale',
          revocationCodes: ['superseded-by-recheck'],
          authority: 'active',
        }),
      ),
    },
  };
}

function StatefulExecutionActions() {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" onClick={() => setOpen(true)}>
      {open ? 'Inspector open' : 'Open stateful inspector'}
    </button>
  );
}

describe('StationBasisPane', () => {
  test('remounts host action state across delimiter-colliding Task and answer tuples', async () => {
    hooks.answer.mockReturnValue(idle);
    hooks.task.mockReturnValue({
      ...idle,
      data: projectionWithExecution('same-answer'),
    });
    const occurrences: string[] = [];
    const renderActions = (input: StationBasisPaneExecutionActionInput) => {
      occurrences.push(input.occurrenceKey);
      return <StatefulExecutionActions key={input.occurrenceKey} />;
    };
    const authority = {
      apiBase: 'http://station.test',
      authorityKey: 'same-authority',
    };
    const view = render(
      <StationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'task:a',
          answerReferenceId: 'answer',
        }}
        requestScope={authority}
        renderExecutionActions={renderActions}
      />,
    );
    fireEvent.click(
      screen.getByText(/Context records describe surrounding work/),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Open stateful inspector' }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open stateful inspector' }),
    );
    expect(screen.getByText('Inspector open')).toBeTruthy();
    const originalOccurrence = occurrences[occurrences.length - 1];
    view.rerender(
      <StationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'task',
          answerReferenceId: 'a:answer',
        }}
        requestScope={authority}
        renderExecutionActions={renderActions}
      />,
    );
    expect(occurrences[occurrences.length - 1]).not.toBe(originalOccurrence);
    expect(screen.queryByText('Inspector open')).toBeNull();
  });
  test('renders Surface-owned direct answer standing and disclosure', () => {
    hooks.answer.mockReturnValue({ ...idle, data: projection('one') });
    hooks.task.mockReturnValue(idle);
    render(
      <StationBasisPane
        scope={{ kind: 'direct-answer', sessionId: 'session', turnId: 'turn' }}
      />,
    );
    expect(screen.getByText('Current answer')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Unassessed');
    expect(
      screen.getByText(/Context records describe surrounding work/),
    ).toBeTruthy();
  });

  test('progressively reveals large context collections without dropping the control focus', () => {
    const large = projection('large');
    large.regions.outcomes = Array.from({ length: 25 }, (_, index) => ({
      ref: {
        authority: '@kontourai/station',
        schemaVersion: '1',
        kind: 'task-output',
        taskId: 'task',
        outputId: `output-${index}`,
      },
      role: 'outcome',
      context: {
        kind: 'station-output',
        title: `Output ${index}`,
        mediaType: 'text/plain',
        byteLength: index,
        digest: `sha256-${index}`,
      },
      gaps: [],
    })) as never;
    hooks.answer.mockReturnValue({ ...idle, data: large });
    hooks.task.mockReturnValue(idle);
    render(
      <StationBasisPane
        scope={{ kind: 'direct-answer', sessionId: 'session', turnId: 'turn' }}
      />,
    );
    expect(screen.getByText('Output 19')).toBeTruthy();
    expect(screen.queryByText('Output 20')).toBeNull();
    const more = screen.getByRole('button', { name: 'Show more Outcomes' });
    more.focus();
    fireEvent.click(more);
    expect(screen.getByText('Output 24')).toBeTruthy();
    expect(document.activeElement).toBe(more);
    expect(more.textContent).toBe('All items shown');
    expect(more.getAttribute('aria-disabled')).toBe('true');
    expect((more as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(more);
    expect(screen.getByText('Output 24')).toBeTruthy();
  });

  test('keeps Whole Task standing-free while selecting exact server-ordered answers', async () => {
    hooks.answer.mockReturnValue(idle);
    hooks.task.mockReturnValue({
      ...idle,
      data: {
        version: 'station.task-basis-collection/v4',
        taskId: 'task',
        answers: [
          { answerReferenceId: 'answer-one', projection: projection('one') },
          { answerReferenceId: 'answer-two', projection: projection('two') },
        ],
        gaps: [{ state: 'restricted' }],
        unassociated: [
          {
            kind: 'task-output',
            taskId: 'task',
            outputId: 'output-one',
            kept: true,
          },
        ],
        keptToolResults: [],
        keptGateEvaluations: [],
      },
    });
    render(<StationBasisPane scope={{ kind: 'whole-task', taskId: 'task' }} />);
    expect(
      screen.getByText('Whole Task has no aggregate standing.'),
    ).toBeTruthy();
    expect(
      screen.getByText(/Some kept answer context is restricted/),
    ).toBeTruthy();
    expect(
      screen.getByText('Kept in Task, not associated with an answer'),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByText(/Context records describe surrounding work/),
    );
    await waitFor(() =>
      expect(
        screen
          .getByText(/Context records describe surrounding work/)
          .closest('details'),
      ).toHaveProperty('open', true),
    );
    const second = screen.getByRole('button', { name: /answer-two/ });
    fireEvent.click(second);
    expect(second.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() =>
      expect(
        screen
          .getByText(/Context records describe surrounding work/)
          .closest('details'),
      ).toHaveProperty('open', false),
    );
  });

  test('retains selection and control focus across a large native Whole Task collection', () => {
    hooks.answer.mockReturnValue(idle);
    hooks.task.mockReturnValue({
      ...idle,
      data: {
        version: 'station.task-basis-collection/v4',
        taskId: 'task',
        answers: Array.from({ length: 25 }, (_, index) => ({
          answerReferenceId: `answer-${index + 1}`,
          projection: projection(`message-${index + 1}`),
        })),
        gaps: [],
        unassociated: [],
        keptToolResults: [],
        keptGateEvaluations: [],
      },
    });
    render(<StationBasisPane scope={{ kind: 'whole-task', taskId: 'task' }} />);
    const more = screen.getByRole('button', { name: 'Show more kept answers' });
    more.focus();
    fireEvent.click(more);
    const last = screen.getByRole('button', { name: /answer-25/ });
    fireEvent.click(last);
    expect(last.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(more);
    expect(more.textContent).toBe('All kept answers shown');
    expect(more.getAttribute('aria-disabled')).toBe('true');
    expect((more as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(more);
    expect(last.getAttribute('aria-pressed')).toBe('true');
  });

  test('renders a separate Flow-owned Process receipt with bounded, deferred evidence details', () => {
    hooks.answer.mockReturnValue(idle);
    hooks.task.mockReturnValue({
      ...idle,
      data: {
        version: 'station.task-basis-collection/v4',
        taskId: 'task',
        answers: [
          { answerReferenceId: 'answer', projection: projection('one') },
        ],
        unassociated: [],
        keptToolResults: [],
        keptGateEvaluations: [keptGateEvaluation(21)],
        gaps: [{ state: 'restricted', scope: 'process' }],
      },
    });
    render(<StationBasisPane scope={{ kind: 'whole-task', taskId: 'task' }} />);
    const process = screen.getByRole('region', {
      name: 'Process kept gate evaluations',
    });
    expect(process.textContent).toContain('Process / Kept gate evaluations');
    expect(process.textContent).toContain(
      'Gate review — original verdict pass. At last check: invalidated;',
    );
    expect(
      screen.getByText('Some kept Process context is restricted.'),
    ).toBeTruthy();
    expect(process.textContent).not.toContain('selected-evidence-0');
    const receipt = screen
      .getByText('Process receipt details', { selector: 'summary' })
      .closest('details') as HTMLDetailsElement;
    receipt.open = true;
    fireEvent(receipt, new Event('toggle', { bubbles: true }));
    expect(process.textContent).toContain('External revocation');
    expect(process.textContent).toContain('Not observed');
    expect(process.textContent).toContain('Retained immutable bundle');
    expect(process.textContent).toContain('Need a fresh review');
    expect(process.textContent).toContain('selected-evidence-19');
    expect(process.textContent).not.toContain('selected-evidence-20');
    const more = screen.getByRole('button', {
      name: 'Show more selected evidence',
    });
    more.focus();
    fireEvent.click(more);
    expect(process.textContent).toContain('selected-evidence-20');
    expect(document.activeElement).toBe(more);
    expect(more.textContent).toBe('All selected evidence shown');
    expect(more.getAttribute('aria-disabled')).toBe('true');
  });

  test('renders canonical kept execution rows even when no answers are available', () => {
    hooks.answer.mockReturnValue(idle);
    hooks.task.mockReturnValue({
      ...idle,
      data: {
        version: 'station.task-basis-collection/v4',
        taskId: 'task',
        answers: [],
        unassociated: [],
        keptToolResults: [
          {
            referenceId: 'kept-result',
            ref: {
              authority: '@kontourai/thread',
              schemaVersion: '1.2.0',
              kind: 'result',
              threadId: 'session',
              resultId: 'result',
            },
            kept: true,
            associatedAnswerReferenceIds: [],
          },
        ],
        keptGateEvaluations: [],
        gaps: [],
      },
    });
    const actions = vi.fn(() => <button type="button">Inspect result</button>);
    render(
      <StationBasisPane
        scope={{ kind: 'whole-task', taskId: 'task' }}
        renderExecutionActions={actions}
      />,
    );
    expect(
      screen.getByText('No kept answers are currently available.'),
    ).toBeTruthy();
    expect(screen.getByText('Kept result result')).toBeTruthy();
    expect(
      screen.getByText('Kept in Task, not associated with an available answer'),
    ).toBeTruthy();
    expect(actions).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: expect.objectContaining({
          authority: '@kontourai/thread',
          kind: 'result',
          threadId: 'session',
          resultId: 'result',
        }),
        keptReference: expect.objectContaining({ referenceId: 'kept-result' }),
      }),
    );
  });

  test('fails closed when Surface cannot provide a thread-result identity', () => {
    hooks.viewOverride = {
      title: 'Basis',
      standing: { label: 'Unassessed', description: 'No assessment.' },
      gaps: [],
      disclosures: {
        assessment: 'expanded',
        context: 'expanded',
        relationships: 'collapsed',
        technical: 'collapsed',
      },
      assessment: null,
      contextNotice: 'Context',
      contextGroups: [
        {
          id: 'execution',
          label: 'Execution',
          items: [
            {
              id: 'ownerless-result',
              label: 'Result',
              ref: {
                authority: '@kontourai/station',
                schemaVersion: '1',
                kind: 'task-output',
                taskId: 'task',
                outputId: 'output',
              },
              facts: [],
              gaps: [],
            },
          ],
        },
      ],
      relationships: [],
      technical: null,
      footer: 'Footer',
    };
    hooks.answer.mockReturnValue({ ...idle, data: projection('one') });
    hooks.task.mockReturnValue(idle);
    render(
      <StationBasisPane
        scope={{ kind: 'direct-answer', sessionId: 'session', turnId: 'turn' }}
      />,
    );
    const unavailable = screen.getByRole('button', {
      name: 'Result identity not captured; cannot keep',
    });
    expect((unavailable as HTMLButtonElement).disabled).toBe(true);
    hooks.viewOverride = null;
  });

  test('keeps disclosure and action continuity across a payload-free same-authority refetch without rendering withheld data', async () => {
    const basis = projectionWithExecution('one');
    let taskResult: QueryFixture = { ...idle, data: basis };
    hooks.answer.mockReturnValue(idle);
    hooks.task.mockImplementation(() => taskResult);
    const view = render(
      <StationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'task',
          answerReferenceId: 'answer',
        }}
        requestScope={{ apiBase: 'http://station.test', authorityKey: 'one' }}
        renderExecutionActions={(input) => <ContinuityActions input={input} />}
      />,
    );
    const context = screen
      .getByText(/Context records describe surrounding work/)
      .closest('details') as HTMLDetailsElement;
    fireEvent.click(
      screen.getByText(/Context records describe surrounding work/),
    );
    await waitFor(() => expect(context.open).toBe(true));
    const keep = screen.getByRole('button', { name: 'Keep in Task' });
    keep.focus();
    fireEvent.focus(keep);

    // The protected SDK query drops data while React Query reports a refetch,
    // rather than an initial `isLoading` read.
    taskResult = { ...idle, data: undefined, isFetching: true };
    view.rerender(
      <StationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'task',
          answerReferenceId: 'answer',
        }}
        requestScope={{ apiBase: 'http://station.test', authorityKey: 'one' }}
        renderExecutionActions={(input) => <ContinuityActions input={input} />}
      />,
    );
    expect(screen.getByText('Loading Basis…')).toBeTruthy();
    expect(screen.queryByText('Retained result')).toBeNull();

    taskResult = { ...idle, data: basis };
    view.rerender(
      <StationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'task',
          answerReferenceId: 'answer',
        }}
        requestScope={{ apiBase: 'http://station.test', authorityKey: 'one' }}
        renderExecutionActions={(input) => <ContinuityActions input={input} />}
      />,
    );
    await waitFor(() =>
      expect(
        screen
          .getByText(/Context records describe surrounding work/)
          .closest('details'),
      ).toHaveProperty('open', true),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Inspect tool result' }),
      ),
    );
  });

  test('resets continuity for a different subject or authority and never renders revoked payloads', async () => {
    const basis = projectionWithExecution('one');
    let taskResult: QueryFixture = { ...idle, data: basis };
    hooks.answer.mockReturnValue(idle);
    hooks.task.mockImplementation(() => taskResult);
    const view = render(
      <StationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'task:a',
          answerReferenceId: 'answer',
        }}
        requestScope={{ apiBase: 'http://station.test', authorityKey: 'one' }}
      />,
    );
    fireEvent.click(
      screen.getByText(/Context records describe surrounding work/),
    );
    await waitFor(() =>
      expect(
        screen
          .getByText(/Context records describe surrounding work/)
          .closest('details'),
      ).toHaveProperty('open', true),
    );

    view.rerender(
      <StationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'task',
          answerReferenceId: 'a:answer',
        }}
        requestScope={{ apiBase: 'http://station.test', authorityKey: 'two' }}
      />,
    );
    await waitFor(() =>
      expect(
        screen
          .getByText(/Context records describe surrounding work/)
          .closest('details'),
      ).toHaveProperty('open', false),
    );

    taskResult = { ...idle, data: basis, error: new Error('revoked') };
    view.rerender(
      <StationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'task',
          answerReferenceId: 'a:answer',
        }}
        requestScope={{ apiBase: 'http://station.test', authorityKey: 'two' }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Basis is unavailable.',
    );
    expect(screen.queryByText('Retained result')).toBeNull();
  });

  test('does not restore an action after focus left it for the Context summary', () => {
    const basis = projectionWithExecution('one');
    let taskResult: QueryFixture = { ...idle, data: basis };
    hooks.answer.mockReturnValue(idle);
    hooks.task.mockImplementation(() => taskResult);
    const view = render(
      <StationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'task',
          answerReferenceId: 'answer',
        }}
        requestScope={{ apiBase: 'http://station.test', authorityKey: 'one' }}
        renderExecutionActions={(input) => <ContinuityActions input={input} />}
      />,
    );
    const keep = screen.getByRole('button', { name: 'Keep in Task' });
    const summary = screen.getByText(
      /Context records describe surrounding work/,
    );
    keep.focus();
    fireEvent.focus(keep);
    fireEvent.blur(keep, { relatedTarget: summary });
    summary.focus();

    taskResult = { ...idle, data: undefined, isLoading: true };
    view.rerender(
      <StationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'task',
          answerReferenceId: 'answer',
        }}
        requestScope={{ apiBase: 'http://station.test', authorityKey: 'one' }}
        renderExecutionActions={(input) => <ContinuityActions input={input} />}
      />,
    );
    taskResult = { ...idle, data: basis };
    view.rerender(
      <StationBasisPane
        scope={{
          kind: 'task-answer',
          taskId: 'task',
          answerReferenceId: 'answer',
        }}
        requestScope={{ apiBase: 'http://station.test', authorityKey: 'one' }}
        renderExecutionActions={(input) => <ContinuityActions input={input} />}
      />,
    );
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'Inspect tool result' }),
    );
  });

  test.each(['pointerdown', 'keydown'] as const)(
    'user %s during the payload-free refresh cancels pending restoration',
    (eventType) => {
      const basis = projectionWithExecution('one');
      let taskResult: QueryFixture = { ...idle, data: basis };
      hooks.answer.mockReturnValue(idle);
      hooks.task.mockImplementation(() => taskResult);
      const pane = () => (
        <StationBasisPane
          scope={{
            kind: 'task-answer',
            taskId: 'task',
            answerReferenceId: 'answer',
          }}
          requestScope={{ apiBase: 'http://station.test', authorityKey: 'one' }}
          renderExecutionActions={(input) => (
            <ContinuityActions input={input} />
          )}
        />
      );
      const view = render(pane());
      screen.getByRole('button', { name: 'Keep in Task' }).focus();
      taskResult = { ...idle, data: undefined, isLoading: true };
      view.rerender(pane());
      expect(screen.queryByText('Retained result')).toBeNull();
      if (eventType === 'pointerdown') fireEvent.pointerDown(document.body);
      else fireEvent.keyDown(document.body, { key: 'Tab' });
      taskResult = { ...idle, data: basis };
      view.rerender(pane());
      expect(document.activeElement).not.toBe(
        screen.getByRole('button', { name: 'Inspect tool result' }),
      );
    },
  );
});
