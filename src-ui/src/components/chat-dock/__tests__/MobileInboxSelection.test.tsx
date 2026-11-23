// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { toastStore } from '../../../contexts/ToastContext';
import type { HomeWorkItem } from '../../../views/home/home-view-model';
import {
  resetPendingUndoForTest,
  undoLatestAction,
} from '../../undo/UndoableActionShortcut';
import { MobileInboxSelection } from '../MobileInboxSelection';

const mutate = vi.hoisted(() => vi.fn());
const reopen = vi.hoisted(() => vi.fn());
const work = vi.hoisted(() => ({
  supported: true,
  settled: {} as Record<string, string>,
}));
vi.mock('../useConversationWorkState', () => ({
  useConversationWorkState: () => ({
    supported: work.supported,
    settled: work.settled,
    change: { mutateAsync: mutate, mutate: reopen, isPending: false },
  }),
}));
beforeEach(() => {
  mutate.mockReset();
  reopen.mockReset();
  work.supported = true;
  work.settled = {};
  resetPendingUndoForTest();
  toastStore.clear();
});
const notice = () =>
  toastStore
    .getSnapshot()
    .filter((toast) => toast.actions?.some((action) => action.label === 'Undo'))
    .map((toast) => toast.message)
    .at(-1);
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
  // One settled, one only hidden here: the notice says which is which.
  expect(notice()).toBe('1 marked done, 1 hidden on this device');
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
  // Without settlement, putting a row away is Mark done.
  expect(notice()).toBe('Marked done');
});
it('says the selection was only hidden here when settlement reaches none of it', async () => {
  const onChange = vi.fn();
  const dismiss = vi.fn().mockResolvedValue(undefined);
  const running = (id: string) => ({
    ...row(id),
    lifecycleLabel: 'Running' as const,
    conversationId: undefined,
  });
  render(tray([running('one'), running('two')], onChange, dismiss));
  fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  expect(mutate).not.toHaveBeenCalled();
  expect(notice()).toBe('2 hidden on this device');
});
it('says how many were marked done when every row settled', async () => {
  const onChange = vi.fn();
  mutate.mockResolvedValue(undefined);
  render(tray([row('one'), row('two')], onChange));
  fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  expect(notice()).toBe('2 marked done');
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
  work.settled = { two: '2026-11-01T00:00:00.000Z' };
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
// Without the preview the shelf id `settled` is Just finished: not done yet.
it('marks a Just finished row done on this device when settlement is off', async () => {
  work.supported = false;
  const onChange = vi.fn();
  const dismiss = vi.fn().mockResolvedValue(undefined);
  render(
    <MobileInboxSelection
      selected={new Set(['one'])}
      groups={[{ id: 'settled', label: 'Just finished', items: [row('one')] }]}
      onChange={onChange}
      isCurrent={() => true}
      snooze={vi.fn()}
      dismiss={dismiss}
      restore={vi.fn()}
      details={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  expect(dismiss).toHaveBeenCalledWith(row('one'));
});
