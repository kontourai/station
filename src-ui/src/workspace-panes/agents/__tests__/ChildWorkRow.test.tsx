// @vitest-environment jsdom

/**
 * #2459: one child-work row. What it must never do is invent: a time, a
 * count or an outcome nobody reported, or a button wired to nothing.
 */

import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import type { OrchestrationSessionEventWindow } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
const useOrchestrationSessionActivityQuery = vi.fn();
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
  useOrchestrationSessionActivityQuery: (...args: unknown[]) =>
    useOrchestrationSessionActivityQuery(...args),
  useOrchestrationSessionQuery: (...args: unknown[]) =>
    useOrchestrationSessionQuery(...args),
  useInterruptDelegatedTaskMutation: () => ({
    mutate: interruptMutate,
    mutateAsync: interruptMutate,
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
  useOrchestrationSessionActivityQuery
    .mockReset()
    .mockReturnValue({ data: undefined });
  useStopProviderTaskMutation.mockReturnValue({
    mutate: stopMutate,
    mutateAsync: stopMutate,
    isPending: false,
    isSuccess: false,
    isError: false,
    data: undefined,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('an unreported start and unreported usage render absent, not as zero', () => {
  const { container } = mount(row());
  const meta = container.querySelector('.child-work-row__meta')?.textContent;
  // Only the kind: no elapsed (no start was reported) and no usage clause.
  expect(meta).toBe('Subagent');
  expect(container.textContent).not.toMatch(/0 tokens|0s|tool use/);
});

test('a failed provider Stop is translated once by the shared control', async () => {
  const stop = vi
    .fn()
    .mockRejectedValue(new Error('private_stop_machine_failure'));
  useStopProviderTaskMutation.mockReturnValue({
    mutateAsync: stop,
    isPending: false,
    isSuccess: false,
    isError: true,
  });
  mount(row({}, { stop: 'provider-task-stop' }));
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Try again in a moment.');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(document.body.textContent).not.toContain(
    'private_stop_machine_failure',
  );
  expect(stop).toHaveBeenCalledWith({ threadId: 'exec-1', taskId: 'task-1' });
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
    'Explore · 1m 0s',
  );
  expect(screen.queryByText('0 tokens · 1 tool use · ran 1m 1s')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Survey the repo/ }));
  expect(screen.getByText('0 tokens · 1 tool use · ran 1m 1s')).toBeTruthy();
});

test('a settled child with no reported end shows no elapsed', () => {
  const { container } = mount(
    row({ status: 'completed' }, { startedAtMs: 40_000 }),
  );
  expect(container.querySelector('.child-work-row__meta')?.textContent).toBe(
    'Subagent',
  );
  expect(screen.getByText('Summary not reported')).toBeTruthy();
});

test('unresolved and unconfirmed-stop terminals never read as Completed or Stopped', () => {
  mount(row({ status: 'unresolved' }));
  expect(screen.getByText('No result')).toBeTruthy();
  expect(screen.queryByText('Run finished')).toBeNull();
  cleanup();
  mount(row({ status: 'stopped-unconfirmed' }));
  expect(screen.getByText('Stop requested — not confirmed')).toBeTruthy();
  expect(screen.queryByText('Stopped')).toBeNull();
  expect(screen.queryByText('Run finished')).toBeNull();
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
  fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
  expect(onOpenSession).toHaveBeenCalledWith('d-1');
});

test('a collapsed delegate polls one bounded turn, shows its own tool, and clears it on a new turn', async () => {
  vi.useFakeTimers();
  const sdk = await vi.importActual<typeof import('@kontourai/station-sdk')>(
    '@kontourai/station-sdk',
  );
  useOrchestrationSessionActivityQuery.mockImplementation(
    (threadId, _apiBase, config) =>
      sdk.useOrchestrationSessionActivityQuery(
        threadId,
        'http://station.test',
        config,
      ),
  );
  const base = {
    provider: 'codex' as const,
    createdAt: '2026-10-20T00:00:00.000Z',
    turnId: 'turn-old',
    threadId: 'delegate-live',
  };
  const events: CanonicalRuntimeEvent[] = [
    {
      ...base,
      eventId: 'start',
      method: 'turn.started',
      prompt: 'Check the source',
    },
    {
      ...base,
      eventId: 'old-tool',
      method: 'tool.started',
      toolName: 'OldTool',
      itemId: 'old-tool',
      toolCallId: 'old-tool',
      arguments: {},
    },
    {
      ...base,
      turnId: 'turn-new',
      eventId: 'next',
      method: 'turn.started',
      prompt: 'Continue',
    },
    {
      ...base,
      turnId: 'turn-new',
      eventId: 'tool',
      method: 'tool.started',
      toolName: 'Read',
      itemId: 'tool-1',
      toolCallId: 'tool-1',
      arguments: {},
    },
    ...['exec-1', 'sibling'].map(
      (threadId): CanonicalRuntimeEvent => ({
        ...base,
        eventId: threadId,
        method: 'tool.started',
        threadId,
        toolName: `${threadId}-tool`,
        itemId: threadId,
        toolCallId: threadId,
        arguments: {},
      }),
    ),
  ];
  let latestTool: OrchestrationSessionEventWindow['latestTool'];
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({
      success: true,
      data: {
        protocolVersion: 1,
        latestTool,
        session: {
          threadId: 'delegate-live',
          provider: 'codex',
          status: 'running',
          createdAt: base.createdAt,
          updatedAt: base.createdAt,
          controlMode: 'station-owned',
          isLoaded: true,
          isPersisted: true,
          eventCount: 10_000,
          answerability: { answerable: true },
        },
        events: events.map((event, sequence) => ({ sequence, event })),
        hasMore: true,
        nextCursor: 'older-history',
        watermark: events.length,
      } satisfies OrchestrationSessionEventWindow,
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const model = row({
    producer: 'station-delegate',
    childId: 'delegate-live',
    progress: 'Working',
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ul>
        <ChildWorkRow
          row={model}
          now={100_000}
          showProvenance={false}
          onOpenSession={onOpenSession}
        />
      </ul>
    </QueryClientProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(
    screen.getByText('Read', { selector: '.child-work-activity__name' }),
  ).toBeTruthy();
  expect(screen.queryByText('OldTool')).toBeNull();
  expect(screen.queryByText('exec-1-tool')).toBeNull();
  expect(screen.queryByText('sibling-tool')).toBeNull();
  expect(useOrchestrationSessionQuery).not.toHaveBeenCalled();

  events.push({
    ...base,
    turnId: 'turn-new',
    eventId: 'steer',
    method: 'turn.started',
    prompt: 'Continue the same work',
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_050);
  });
  expect(
    screen.getByText('Read', { selector: '.child-work-activity__name' }),
  ).toBeTruthy();

  events.push({
    ...base,
    turnId: undefined,
    eventId: 'untagged-old-tool',
    method: 'tool.started',
    toolName: 'UntaggedOldTool',
    itemId: 'untagged-old',
    toolCallId: 'untagged-old',
    arguments: {},
  });
  events.push({
    ...base,
    turnId: 'turn-next',
    eventId: 'reset',
    method: 'turn.started',
    prompt: 'Next task',
  });
  events.push({
    ...base,
    turnId: 'turn-new',
    eventId: 'late-old-turn-tool',
    method: 'tool.started',
    toolName: 'LateOldTool',
    itemId: 'late-old',
    toolCallId: 'late-old',
    arguments: {},
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_050);
  });
  expect(screen.queryByText('Read')).toBeNull();
  expect(screen.queryByText('LateOldTool')).toBeNull();
  expect(screen.queryByText('UntaggedOldTool')).toBeNull();

  latestTool = { turnId: 'turn-next', name: 'Write' };
  events.length = 0;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_050);
  });
  expect(
    screen.getByText('Write', { selector: '.child-work-activity__name' }),
  ).toBeTruthy();
  expect(screen.queryByText('Read')).toBeNull();

  latestTool = null;
  events.push({
    ...base,
    eventId: 'capped-older-tool',
    method: 'tool.started',
    toolName: 'OlderTool',
    itemId: 'older-tool',
    toolCallId: 'older-tool',
    arguments: {},
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_050);
  });
  expect(
    screen.queryByText('Write', { selector: '.child-work-activity__name' }),
  ).toBeNull();
  expect(screen.queryByText('OlderTool')).toBeNull();
  expect(screen.getByText('Working')).toBeTruthy();
  expect(useOrchestrationSessionQuery).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(5);
  for (const [url] of fetcher.mock.calls) {
    expect(url).toBe(
      'http://station.test/api/orchestration/sessions/delegate-live/event-window?direction=newest&turnLimit=1',
    );
  }
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000);
  });
  expect(fetcher).toHaveBeenCalledTimes(5);
  client.clear();
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
    mutateAsync: stopMutate,
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

test('an engine transcript opens in Chat without mounting an inline reader', () => {
  const onOpenChild = vi.fn();
  const model = row({
    transcript: { kind: 'codex-thread', threadId: 'child' },
  });
  render(
    <ul>
      <ChildWorkRow
        row={model}
        now={100_000}
        showProvenance={false}
        onOpenSession={onOpenSession}
        onOpenChild={onOpenChild}
      />
    </ul>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
  expect(onOpenChild).toHaveBeenCalledWith(model.item, model.title);
  expect(useChildWorkTranscriptQuery).not.toHaveBeenCalled();
});

test('a provider summary is labeled as a report rather than a verified returned artifact', () => {
  mount(
    row({
      status: 'completed',
      result: {
        summary: 'I will investigate next.',
        source: 'provider-summary',
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  expect(screen.getByText('Provider summary')).toBeTruthy();
  expect(screen.getByText('I will investigate next.')).toBeTruthy();
  expect(screen.getByText('No returned result was reported.')).toBeTruthy();
});

test('returned report text is labeled separately from completion and provider summaries', () => {
  mount(
    row({
      status: 'completed',
      result: { summary: 'Found the cause.', source: 'tool-return' },
    }),
  );
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  expect(screen.getByText('Returned result')).toBeTruthy();
  expect(screen.getByText('Found the cause.')).toBeTruthy();
  expect(screen.queryByText('No returned result was reported.')).toBeNull();
});

test('a completed child without report or usage still exposes the missing-result disclosure', () => {
  mount(row({ status: 'completed', result: undefined, usage: undefined }));
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  expect(screen.getByText('No returned result was reported.')).toBeTruthy();
});
