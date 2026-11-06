// @vitest-environment jsdom
import type {
  ProjectSharedTaskHistory,
  ProjectSharedTaskHumanMessage,
} from '@kontourai/station-contracts/project-shared-task';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import {
  projectTaskHistory,
  SharedTaskHistoryList,
} from '../SharedTaskHistoryList';

const record = (sequence: number): ProjectSharedTaskHumanMessage => ({
  sequence,
  actor: { kind: 'human', label: 'Brian' },
  body: { kind: 'human-message', text: 'A **shared** decision' },
  integrity: 'L0',
  digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
});
const page = (
  records: ProjectSharedTaskHumanMessage[],
): ProjectSharedTaskHistory => ({
  kind: 'available',
  records,
  hasMore: false,
  checkpoint: {
    throughSeq: 3,
    checkpointDigest: 'b'.repeat(64),
    retainedAnchorSeq: 0,
    retainedAnchorDigest: 'c'.repeat(64),
  },
});

test('renders Markdown records, pages and retains rows beside a retryable page failure', async () => {
  const load = vi.fn(),
    retry = vi.fn();
  const props = {
    records: [record(1)],
    readable: true,
    hasEarlier: true,
    onLoadEarlier: load,
    onRetry: retry,
  };
  const view = render(<SharedTaskHistoryList {...props} />);
  expect(
    await screen.findByText('shared', { selector: 'strong' }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Load earlier messages' }),
  );
  expect(load).toHaveBeenCalledOnce();
  view.rerender(<SharedTaskHistoryList {...props} failed />);
  expect(screen.getByRole('list').textContent).toContain('A shared decision');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledOnce();
  view.rerender(<SharedTaskHistoryList {...props} readable={false} failed />);
  expect(screen.queryByRole('list')).toBeNull();
  expect(screen.queryByText('Brian')).toBeNull();
});

test('deduplicates and orders a fixed window; typed failure or checkpoint drift invalidates it', () => {
  expect(
    projectTaskHistory([
      page([record(2)]),
      page([record(1), record(2)]),
    ]).records.map((row) => row.sequence),
  ).toEqual([1, 2]);
  for (const kind of [
    'gap',
    'stale',
    'invalid-cursor',
    'not-found',
    'unavailable',
    'too-large',
  ] as const) {
    expect(projectTaskHistory([page([record(1)]), { kind }])).toMatchObject({
      records: [],
      outcome: kind,
    });
  }
  const changed = page([record(3)]);
  if (changed.kind !== 'available') throw Error('fixture');
  changed.checkpoint.checkpointDigest = 'd'.repeat(64);
  expect(projectTaskHistory([page([record(1)]), changed])).toMatchObject({
    records: [],
    outcome: 'stale',
  });
});

test('loading and empty states are explicit', () => {
  const props = {
    records: [],
    readable: true,
    onLoadEarlier: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<SharedTaskHistoryList {...props} pending />);
  expect(screen.getByLabelText('Loading messages')).toBeTruthy();
  view.rerender(<SharedTaskHistoryList {...props} />);
  expect(screen.getByText('No published messages yet.')).toBeTruthy();
});
