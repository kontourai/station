// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { HomeWorkItem } from '../../../views/home/home-view-model';
import {
  resetPendingUndoForTest,
  undoLatestAction,
} from '../../undo/UndoableActionShortcut';
import { MobileInboxSelection } from '../MobileInboxSelection';

const mutate = vi.hoisted(() => vi.fn());
const reopen = vi.hoisted(() => vi.fn());
const work = vi.hoisted(() => ({ supported: true }));
vi.mock('../useConversationWorkState', () => ({
  useConversationWorkState: () => ({
    supported: work.supported,
    settled: {},
    change: { mutateAsync: mutate, mutate: reopen, isPending: false },
  }),
}));
beforeEach(() => {
  mutate.mockReset();
  reopen.mockReset();
  work.supported = true;
  resetPendingUndoForTest();
});
function row(id: string): HomeWorkItem {
  return {
    id,
    conversationId: id,
    kind: 'chat',
    kindLabel: 'Direct chat',
    title: id,
    agentLabel: 'Station',
    projectLabel: 'No project',
    modelLabel: 'Codex',
    lifecycleLabel: 'Recent',
    updatedAt: 1000,
  };
}
function tray(
  items: HomeWorkItem[],
  onChange = vi.fn(),
  dismiss = vi.fn(),
  restore = vi.fn(),
) {
  return (
    <MobileInboxSelection
      selected={new Set(items.map((item) => item.id))}
      groups={[{ id: 'idle', label: 'Open', items }]}
      onChange={onChange}
      isCurrent={() => true}
      snooze={vi.fn()}
      dismiss={dismiss}
      restore={restore}
      details={vi.fn()}
    />
  );
}
it('marks each selected conversation done once by settling, and retains the refused row for retry', async () => {
  const onChange = vi.fn();
  mutate
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('refused'));
  render(tray([row('one'), row('two')], onChange));
  fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(new Set(['two'])));
  expect(mutate.mock.calls).toEqual([
    [{ conversationId: 'one', settled: true }],
    [{ conversationId: 'two', settled: true }],
  ]);
  expect(screen.getByRole('status').textContent).toContain('Try again');
  // What was marked done is undoable with ⌘Z: it reopens exactly that row.
  expect(undoLatestAction()).toBe(true);
  expect(reopen.mock.calls).toEqual([
    [{ conversationId: 'one', settled: false }],
  ]);
});
it('marks running work done on this device, where settlement does not reach it, with Undo', async () => {
  const onChange = vi.fn();
  const dismiss = vi.fn().mockResolvedValue(undefined);
  const restore = vi.fn();
  const running = { ...row('two'), lifecycleLabel: 'Running' as const };
  render(tray([row('one'), running], onChange, dismiss, restore));
  fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  expect(mutate.mock.calls).toEqual([
    [{ conversationId: 'one', settled: true }],
  ]);
  expect(dismiss).toHaveBeenCalledWith(running);
  expect(undoLatestAction()).toBe(true);
  expect(reopen).toHaveBeenCalledWith({
    conversationId: 'one',
    settled: false,
  });
  expect(restore).toHaveBeenCalledWith(running);
});
it('marks every row done on this device when settlement is not available', async () => {
  work.supported = false;
  const onChange = vi.fn();
  const dismiss = vi.fn().mockResolvedValue(undefined);
  render(tray([row('one')], onChange, dismiss));
  fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  expect(mutate).not.toHaveBeenCalled();
  expect(dismiss).toHaveBeenCalledWith(row('one'));
});
it('stops a batch when its Station selection disappears during the first write', async () => {
  let finish!: () => void;
  mutate.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const mounted = render(tray([row('one'), row('two')]));
  fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
  expect(mutate).toHaveBeenCalledTimes(1);
  mounted.unmount();
  await act(async () => finish());
  expect(mutate).toHaveBeenCalledTimes(1);
});
it('keeps a selection holding a row already done from Mark done', () => {
  render(
    <MobileInboxSelection
      selected={new Set(['one', 'two'])}
      groups={[
        { id: 'idle', label: 'Open', items: [row('one')] },
        { id: 'settled', label: 'Settled', items: [row('two')] },
      ]}
      onChange={vi.fn()}
      isCurrent={() => true}
      snooze={vi.fn()}
      dismiss={vi.fn()}
      restore={vi.fn()}
      details={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Mark done' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(screen.getByRole('status').textContent).toBe(
    'Some of these are already done.',
  );
});
