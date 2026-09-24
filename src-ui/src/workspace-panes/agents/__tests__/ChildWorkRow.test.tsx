// @vitest-environment jsdom

/**
 * #2459: one child-work row. What it must never do is invent: a time, a
 * count or an outcome nobody reported, or a button wired to nothing.
 */

import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ChildWorkRowModel } from '../childWorkSelectors';

const useOrchestrationSessionQuery = vi.fn();
const interruptMutate = vi.fn();
const stopMutate = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionQuery: (...args: unknown[]) =>
    useOrchestrationSessionQuery(...args),
  useInterruptDelegatedTaskMutation: () => ({
    mutate: interruptMutate,
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
  useStopProviderTaskMutation: () => ({
    mutate: stopMutate,
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
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
