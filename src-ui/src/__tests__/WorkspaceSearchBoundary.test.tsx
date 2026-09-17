// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkspaceSearchBoundary } from '../components/CommandPalette';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
type Loader = NonNullable<
  Parameters<typeof WorkspaceSearchBoundary>[0]['load']
>;
function Harness({ load }: { load: Loader }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <WorkspaceSearchBoundary
      load={load}
      query=""
      onQueryChange={() => {}}
      onCommands={() => {}}
      onClose={() => setOpen(false)}
    />
  ) : (
    <span>Closed workspace search</span>
  );
}
test('pending lazy search retains Dialog Escape/Close and a late load cannot reopen it', async () => {
  let finish!: (value: Awaited<ReturnType<Loader>>) => void;
  const load: Loader = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  render(<Harness load={load} />);
  const dialog = screen.getByRole('dialog', {
    name: 'Workspace search (this Station)',
  });
  expect(
    screen.getByRole('button', { name: 'Close workspace search' }),
  ).toBeTruthy();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.getByText('Closed workspace search')).toBeTruthy();
  await act(async () => {
    finish({ default: () => <span>Late workspace content</span> });
  });
  expect(screen.queryByText('Late workspace content')).toBeNull();
});
test('failed lazy search retains close and retries through the same boundary', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const load = vi
    .fn<Loader>()
    .mockRejectedValueOnce(new Error('fixture chunk unavailable'))
    .mockResolvedValue({
      default: () => <span>Retried workspace content</span>,
    });
  render(<Harness load={load} />);
  expect(await screen.findByText('Workspace search unavailable')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Close workspace search' }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry workspace search' }),
  );
  expect(await screen.findByText('Retried workspace content')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});
