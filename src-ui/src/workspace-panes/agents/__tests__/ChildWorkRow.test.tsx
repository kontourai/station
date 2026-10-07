// @vitest-environment jsdom

/**
 * #2459: one child-work row. What it must never do is invent: a time, a
 * count or an outcome nobody reported, or a button wired to nothing.
 */

import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ChildWorkRowModel } from '../childWorkSelectors';

const useOrchestrationSessionQuery = vi.fn();
const interruptMutate = vi.fn();
const stopMutate = vi.fn();
// #2486 review: a configurable mock so a test can drive the mutation's own
// `.data` (a real `ProviderTaskStopResult`, e.g. `no-active-task`) — every
// other test relies on the plain default shape set in `beforeEach`.
const useStopProviderTaskMutation = vi.fn();
// #3163: the transcript query, driven with the contract's page shape.
const useChildWorkTranscriptQuery = vi.fn();
const fetchNextPage = vi.fn();
const { FakeStationHttpError } = vi.hoisted(() => ({
  FakeStationHttpError: class extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`);
    }
  },
}));

vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionQuery: (...args: unknown[]) =>
    useOrchestrationSessionQuery(...args),
  useInterruptDelegatedTaskMutation: () => ({
    mutate: interruptMutate,
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
  useStopProviderTaskMutation: (...args: unknown[]) =>
    useStopProviderTaskMutation(...args),
  useChildWorkTranscriptQuery: (...args: unknown[]) =>
    useChildWorkTranscriptQuery(...args),
  StationHttpError: FakeStationHttpError,
}));

import { ChildWorkRow } from '../ChildWorkRow';

function row(
  item: Partial<ChildWorkItem> = {},
  model: Partial<ChildWorkRowModel> = {},
): ChildWorkRowModel {
  return {
    key: 'k',
    title: 'Survey the repo',
    provenance: { kind: 'none' },
    level: 0,
    ...model,
    item: {
      producer: 'engine-subagent',
      reporterThreadId: 'exec-1',
      childId: 'task-1',
      status: 'running',
      ...item,
    },
  };
}

const onOpenSession = vi.fn();

function mount(model: ChildWorkRowModel, now = 100_000) {
  return render(
    <ul>
      <ChildWorkRow
        row={model}
        now={now}
        showProvenance={false}
        onOpenSession={onOpenSession}
      />
    </ul>,
  );
}

beforeEach(() => {
  useOrchestrationSessionQuery.mockReturnValue({ data: undefined });
  useStopProviderTaskMutation.mockReturnValue({
    mutate: stopMutate,
    isPending: false,
    isSuccess: false,
    isError: false,
    data: undefined,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('an unreported start and unreported usage render absent, not as zero', () => {
  const { container } = mount(row());
  const meta = container.querySelector('.child-work-row__meta')?.textContent;
  // Only the kind: no elapsed (no start was reported) and no usage clause.
  expect(meta).toBe('Subagent');
  expect(container.textContent).not.toMatch(/0 tokens|0:00|tool use/);
});

test('reported values print — including a reported zero', () => {
  const { container } = mount(
    row(
      {
        kindLabel: 'Explore',
        usage: { totalTokens: 0, toolUses: 1, durationMs: 61_000 },
      },
      { startedAtMs: 40_000 },
    ),
    100_000,
  );
  expect(container.querySelector('.child-work-row__meta')?.textContent).toBe(
    'Explore · 1:00 · 0 tokens · 1 tool use · ran 1:01',
  );
});

test('a settled child with no reported end shows no elapsed', () => {
  const { container } = mount(
    row({ status: 'completed' }, { startedAtMs: 40_000 }),
  );
  expect(container.querySelector('.child-work-row__meta')?.textContent).toBe(
    'Subagent',
  );
});

test('unresolved and unconfirmed-stop terminals never read as Completed or Stopped', () => {
  mount(row({ status: 'unresolved' }));
  expect(screen.getByText('No result')).toBeTruthy();
  expect(screen.queryByText('Completed')).toBeNull();
  cleanup();
  mount(row({ status: 'stopped-unconfirmed' }));
  expect(screen.getByText('Stop requested — not confirmed')).toBeTruthy();
  expect(screen.queryByText('Stopped')).toBeNull();
  expect(screen.queryByText('Completed')).toBeNull();
});

test('a transcript-file handle gets no button; a session handle opens that session', () => {
  mount(
    row({
      status: 'completed',
      result: {
        summary: 'Found it',
        handle: { kind: 'transcript-file', path: '/tmp/out.jsonl' },
      },
    }),
  );
  expect(screen.queryByRole('button', { name: /open/i })).toBeNull();
  cleanup();
  mount(
    row({
      producer: 'station-delegate',
      reporterThreadId: 'd-1',
      childId: 'd-1',
      result: { handle: { kind: 'session', threadId: 'd-1' } },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
  expect(onOpenSession).toHaveBeenCalledWith('d-1');
});

test('Stop renders only from the row model, and reaches the matching seam', () => {
  mount(row({ controls: { stop: 'provider-task-stop' } }));
  // The item has a seam, but the model derived no control (no wired cell).
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  cleanup();
  mount(
    row(
      { controls: { stop: 'provider-task-stop' } },
      { stop: 'provider-task-stop' },
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(stopMutate).toHaveBeenCalledWith({
    threadId: 'exec-1',
    taskId: 'task-1',
  });
  expect(interruptMutate).not.toHaveBeenCalled();
});

test('#2486: Stop says it also ends the parent turn only when the row model says so — never a copy hardcoded for every engine', () => {
  mount(
    row(
      { controls: { stop: 'provider-task-stop' } },
      { stop: 'provider-task-stop', stopEndsParentTurn: true },
    ),
  );
  expect(screen.getByRole('button', { name: 'Stop' }).title).toBe(
    'Stop this subagent and the turn that started it',
  );
  cleanup();
  mount(
    row(
      { controls: { stop: 'provider-task-stop' } },
      { stop: 'provider-task-stop' },
    ),
  );
  expect(screen.getByRole('button', { name: 'Stop' }).title).toBe('');
});

test('#2486 review: a no-active-task response resets the row instead of leaving it stuck on "Stopping…", with an honest note — engine-generic, not Codex-specific copy', () => {
  useStopProviderTaskMutation.mockReturnValue({
    mutate: stopMutate,
    // A mutation that resolved successfully — react-query's own shape for
    // "the call finished, without error" — but the ENGINE-neutral
    // `ProviderTaskStopResult` it resolved to says there was nothing to
    // stop (the child's own turn/started had not arrived yet).
    isPending: false,
    isSuccess: true,
    isError: false,
    data: { outcome: 'no-active-task', taskId: 'task-1' },
  });
  mount(
    row(
      { controls: { stop: 'provider-task-stop' } },
      { stop: 'provider-task-stop' },
    ),
  );
  // Never stuck on the pending label for a call that already finished.
  expect(screen.queryByText('Stopping…')).toBeNull();
  const stopButton = screen.getByRole('button', {
    name: 'Stop',
  }) as HTMLButtonElement;
  expect(stopButton.disabled).toBe(false);
  expect(screen.getByText('Nothing to stop yet — try again.')).toBeTruthy();
  // A delegate's stop (a different mutation entirely) is unaffected — the
  // reset is scoped to `provider-task-stop`, never assumed for every kind.
  cleanup();
  mount(
    row(
      {
        producer: 'station-delegate',
        controls: { stop: 'delegate-interrupt' },
      },
      { stop: 'delegate-interrupt' },
    ),
  );
  expect(screen.queryByText('Nothing to stop yet — try again.')).toBeNull();
});

test('a truncated summary says so; a delegate’s usage is read only once the row is opened', () => {
  mount(
    row({
      producer: 'station-delegate',
      reporterThreadId: 'd-1',
      childId: 'd-1',
      status: 'completed',
      result: { summary: 'Long report', summaryTruncated: true },
    }),
  );
  expect(useOrchestrationSessionQuery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Survey the repo/ }));
  expect(screen.getByText('Long report')).toBeTruthy();
  expect(screen.getByText(/Summary cut at 4,000 characters/)).toBeTruthy();
  expect(useOrchestrationSessionQuery).toHaveBeenCalledWith(
    'd-1',
    expect.objectContaining({ enabled: true }),
  );
});

const refetch = vi.fn();
const transcriptQuery = (overrides: Record<string, unknown> = {}) => ({
  refetch,
  isRefetching: false,
  data: undefined,
  error: null,
  isPending: false,
  isError: false,
  isSuccess: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  fetchNextPage,
  ...overrides,
});

const TRANSCRIPT = {
  kind: 'claude-subagent' as const,
  sessionId: '00000000-0000-4000-8000-000000000003',
  agentId: 'task-1',
};

test('#3163: an engine subagent shows its own reported model, with where it came from', () => {
  const { container } = mount(
    row({
      model: { id: 'claude-sonnet-4-5-20250929', source: 'subagent-reply' },
    }),
  );
  const model = container.querySelector('.child-work-row__model');
  expect(model?.textContent).toBe('claude-sonnet-4-5-20250929');
  expect(model?.getAttribute('title')).toBe(
    "Reported on the subagent's own reply",
  );
});

test('#3163: an unreported model says so, and nothing else stands in for it', () => {
  const { container } = mount(row({ kindLabel: 'general-purpose' }));
  const model = container.querySelector('.child-work-row__model');
  expect(model?.textContent).toBe('model not reported');
  expect(model?.getAttribute('data-reported')).toBe('false');
  expect(model?.getAttribute('title')).toBeNull();
});

test('#3163: a Station delegate claims no model on its row (its session shows its own)', () => {
  const { container } = mount(
    row({ producer: 'station-delegate', childId: 'delegate-1' }),
  );
  expect(container.querySelector('.child-work-row__model')).toBeNull();
});

test('#3163: a child without a transcript offers none', () => {
  useChildWorkTranscriptQuery.mockReturnValue(transcriptQuery());
  mount(row());
  expect(screen.queryByRole('button', { name: 'View transcript' })).toBeNull();
  expect(useChildWorkTranscriptQuery).not.toHaveBeenCalled();
});

test('#3163: View transcript reads the child by session and id, renders it read-only, and pages on request', () => {
  useChildWorkTranscriptQuery.mockReturnValue(
    transcriptQuery({
      isSuccess: true,
      hasNextPage: true,
      data: {
        pages: [
          {
            entries: [
              { message: 0, kind: 'text', role: 'user', text: 'Reply INNER' },
              {
                message: 1,
                kind: 'tool-call',
                name: 'Agent',
                input: '{"prompt":"x"}',
              },
              { message: 2, kind: 'tool-result', text: 'INNER DONE' },
              { message: 3, kind: 'text', role: 'assistant', text: 'DONE' },
            ],
            nextOffset: 30,
          },
        ],
      },
    }),
  );
  mount(row({ status: 'completed', transcript: TRANSCRIPT }));
  // Closed: nothing is read.
  expect(useChildWorkTranscriptQuery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'View transcript' }));
  expect(useChildWorkTranscriptQuery).toHaveBeenCalledWith({
    threadId: 'exec-1',
    childId: 'task-1',
  });
  const region = screen.getByRole('region', { name: 'Subagent transcript' });
  expect(region.textContent).toContain('Reply INNER');
  expect(region.textContent).toContain('Tool · Agent');
  expect(region.textContent).toContain('INNER DONE');
  expect(region.querySelectorAll('textarea, input')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(fetchNextPage).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Hide transcript' }));
  expect(
    screen.queryByRole('region', { name: 'Subagent transcript' }),
  ).toBeNull();
});

test('#3163: a transcript the engine no longer has says so', () => {
  useChildWorkTranscriptQuery.mockReturnValue(
    transcriptQuery({ isError: true, error: new FakeStationHttpError(503) }),
  );
  mount(row({ status: 'completed', transcript: TRANSCRIPT }));
  fireEvent.click(screen.getByRole('button', { name: 'View transcript' }));
  expect(screen.getByRole('alert').textContent).toBe(
    'The engine no longer has this transcript.',
  );
});

test('#3163: a running child’s open transcript re-reads when the child reports, and offers Refresh', () => {
  vi.useFakeTimers();
  useChildWorkTranscriptQuery.mockReturnValue(
    transcriptQuery({
      isSuccess: true,
      data: {
        pages: [
          {
            entries: [
              { message: 0, kind: 'text', role: 'user', text: 'Reply INNER' },
            ],
          },
        ],
      },
    }),
  );
  const view = render(
    <ul>
      <ChildWorkRow
        row={row({ transcript: TRANSCRIPT, progress: 'Reading files' })}
        now={100_000}
        showProvenance={false}
        onOpenSession={onOpenSession}
      />
    </ul>,
  );
  const toggle = screen.getByRole('button', { name: 'View transcript' });
  fireEvent.click(toggle);
  const region = screen.getByRole('region', { name: 'Subagent transcript' });
  expect(toggle.getAttribute('aria-controls')).toBe(region.id);
  expect(refetch).not.toHaveBeenCalled();
  view.rerender(
    <ul>
      <ChildWorkRow
        row={row({ transcript: TRANSCRIPT, progress: 'Writing the answer' })}
        now={100_000}
        showProvenance={false}
        onOpenSession={onOpenSession}
      />
    </ul>,
  );
  // Debounced: nothing until the child has been quiet for 2 s.
  expect(refetch).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1_999);
  });
  expect(refetch).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(refetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(refetch).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

test('#3163: a child reporting every 500 ms for 10 s still gets its transcript re-read, at most every 2 s', () => {
  vi.useFakeTimers();
  useChildWorkTranscriptQuery.mockReturnValue(
    transcriptQuery({ isSuccess: true, data: { pages: [{ entries: [] }] } }),
  );
  const mountAt = (progress: string) => (
    <ul>
      <ChildWorkRow
        row={row({ transcript: TRANSCRIPT, progress })}
        now={100_000}
        showProvenance={false}
        onOpenSession={onOpenSession}
      />
    </ul>
  );
  const view = render(mountAt('step 0'));
  fireEvent.click(screen.getByRole('button', { name: 'View transcript' }));
  for (let step = 1; step <= 20; step++) {
    view.rerender(mountAt(`step ${step}`));
    act(() => {
      vi.advanceTimersByTime(500);
    });
  }
  // 10 s of reports every 500 ms: one re-read per 2 s window, every window.
  expect(refetch).toHaveBeenCalledTimes(5);
  vi.useRealTimers();
});

test('#3163: a change after a throttled re-read fires another one', () => {
  vi.useFakeTimers();
  useChildWorkTranscriptQuery.mockReturnValue(
    transcriptQuery({ isSuccess: true, data: { pages: [{ entries: [] }] } }),
  );
  const mountAt = (progress: string) => (
    <ul>
      <ChildWorkRow
        row={row({ transcript: TRANSCRIPT, progress })}
        now={100_000}
        showProvenance={false}
        onOpenSession={onOpenSession}
      />
    </ul>
  );
  const view = render(mountAt('first'));
  fireEvent.click(screen.getByRole('button', { name: 'View transcript' }));
  view.rerender(mountAt('second'));
  act(() => {
    vi.advanceTimersByTime(2_000);
  });
  expect(refetch).toHaveBeenCalledTimes(1);
  view.rerender(mountAt('third'));
  act(() => {
    vi.advanceTimersByTime(2_000);
  });
  expect(refetch).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

test('#3163: unmounting with a re-read pending cancels it', () => {
  vi.useFakeTimers();
  useChildWorkTranscriptQuery.mockReturnValue(
    transcriptQuery({ isSuccess: true, data: { pages: [{ entries: [] }] } }),
  );
  const mountAt = (progress: string) => (
    <ul>
      <ChildWorkRow
        row={row({ transcript: TRANSCRIPT, progress })}
        now={100_000}
        showProvenance={false}
        onOpenSession={onOpenSession}
      />
    </ul>
  );
  const view = render(mountAt('first'));
  fireEvent.click(screen.getByRole('button', { name: 'View transcript' }));
  view.rerender(mountAt('second'));
  view.unmount();
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  expect(refetch).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test('#3163: a settled child’s transcript offers no Refresh', () => {
  useChildWorkTranscriptQuery.mockReturnValue(
    transcriptQuery({ isSuccess: true, data: { pages: [{ entries: [] }] } }),
  );
  mount(row({ status: 'completed', transcript: TRANSCRIPT }));
  fireEvent.click(screen.getByRole('button', { name: 'View transcript' }));
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
});
