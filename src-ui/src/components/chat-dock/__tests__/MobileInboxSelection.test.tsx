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
import { MobileInboxSelection } from '../MobileInboxSelection';

const mutate = vi.hoisted(() => vi.fn());
vi.mock('../useConversationWorkState', () => ({
  useConversationWorkState: () => ({
    supported: true,
    settled: {},
    change: { mutateAsync: mutate, isPending: false },
  }),
}));
beforeEach(() => mutate.mockReset());
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
function tray(items: HomeWorkItem[], onChange = vi.fn()) {
  return (
    <MobileInboxSelection
      selected={new Set(items.map((item) => item.id))}
      groups={[{ id: 'idle', label: 'Open', items }]}
      onChange={onChange}
      isCurrent={() => true}
      snooze={vi.fn()}
      dismiss={vi.fn()}
      details={vi.fn()}
    />
  );
}
it('settles each selected conversation once and retains the refused row for retry', async () => {
  const onChange = vi.fn();
  mutate
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('refused'));
  render(tray([row('one'), row('two')], onChange));
  fireEvent.click(screen.getByRole('button', { name: 'Settle' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(new Set(['two'])));
  expect(mutate.mock.calls).toEqual([
    [{ conversationId: 'one', settled: true }],
    [{ conversationId: 'two', settled: true }],
  ]);
  expect(screen.getByRole('status').textContent).toContain('Try again');
});
it('stops a batch when its Station selection disappears during the first write', async () => {
  let finish!: () => void;
  mutate.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const mounted = render(tray([row('one'), row('two')]));
  fireEvent.click(screen.getByRole('button', { name: 'Settle' }));
  expect(mutate).toHaveBeenCalledTimes(1);
  mounted.unmount();
  await act(async () => finish());
  expect(mutate).toHaveBeenCalledTimes(1);
});
it('keeps mixed running and open selections from settling or dismissing', () => {
  render(tray([row('one'), { ...row('two'), lifecycleLabel: 'Running' }]));
  for (const name of ['Settle', 'Dismiss'])
    expect(screen.getByRole('button', { name })).toHaveProperty(
      'disabled',
      true,
    );
});
