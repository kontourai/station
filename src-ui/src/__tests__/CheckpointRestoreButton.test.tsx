// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const { preview, confirm, toast, host } = vi.hoisted(() => ({
  preview: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
  host: {
    authorityKey: 'authority-1',
    currentAuthorityKey: 'authority-1',
  },
}));
vi.mock('@kontourai/station-sdk/client', () => ({
  previewCheckpointRestore: preview,
  confirmCheckpointRestore: confirm,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: host.authorityKey,
    isCurrent: () => host.authorityKey === host.currentAuthorityKey,
  }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: toast }),
}));

import { CheckpointRestoreButton } from '../components/chat/CheckpointRestoreButton';

function mount() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <CheckpointRestoreButton sessionId="session-1" turnId="turn-1" />
    </QueryClientProvider>,
  );
  return invalidate;
}

const result = {
  previewId: 'preview-1',
  threadId: 'session-1',
  turnId: 'turn-1',
  phase: 'settle',
  checkpointId: 'checkpoint-1',
  repoRoot: '/repo',
  targetTreeSha: 'a'.repeat(40),
  currentTreeSha: 'b'.repeat(40),
  paths: [{ status: 'M', path: 'src/app.ts' }],
  pathsTruncated: false,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

beforeEach(() => {
  preview.mockReset().mockResolvedValue(result);
  confirm.mockReset().mockResolvedValue({ restored: true });
  toast.mockReset();
  host.authorityKey = 'authority-1';
  host.currentAuthorityKey = 'authority-1';
});

test('previews current workspace effects and cancellation performs no restore', async () => {
  mount();
  fireEvent.click(
    screen.getByRole('button', { name: 'Restore workspace to here…' }),
  );
  expect((await screen.findByRole('alertdialog')).textContent).toContain(
    'src/app.ts',
  );
  expect(screen.getByRole('alertdialog').textContent).toContain(
    'Conversation history and external tool effects are not undone.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(confirm).not.toHaveBeenCalled();
});

test('confirms the exact preview and surfaces restore failures', async () => {
  confirm.mockRejectedValueOnce(new Error('workspace_changed'));
  mount();
  fireEvent.click(
    screen.getByRole('button', { name: 'Restore workspace to here…' }),
  );
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: 'Restore workspace' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain(
      'workspace_changed',
    ),
  );
  expect(confirm).toHaveBeenCalledWith(
    'http://station.test',
    'session-1',
    'turn-1',
    result,
    expect.objectContaining({ authorityKey: 'authority-1' }),
  );
});

test('refreshes only captured workspace query families after confirmed success', async () => {
  const invalidate = mount();
  fireEvent.click(
    screen.getByRole('button', { name: 'Restore workspace to here…' }),
  );
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: 'Restore workspace' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ['coding-files', '/repo'],
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ['coding-diff', '/repo'],
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ['git-status', '/repo'],
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ['git-log', '/repo'],
  });
  expect(invalidate).toHaveBeenCalledTimes(4);
});

test('does not publish a late preview after the owning turn changes', async () => {
  let finish!: (value: typeof result) => void;
  preview.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <CheckpointRestoreButton sessionId="session-1" turnId="turn-1" />
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Restore workspace to here…' }),
  );
  view.rerender(
    <QueryClientProvider client={client}>
      <CheckpointRestoreButton sessionId="session-2" turnId="turn-2" />
    </QueryClientProvider>,
  );
  finish(result);
  await Promise.resolve();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('closes an open preview when its session owner changes', async () => {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <CheckpointRestoreButton sessionId="session-1" turnId="turn-1" />
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Restore workspace to here…' }),
  );
  await screen.findByRole('alertdialog');
  view.rerender(
    <QueryClientProvider client={client}>
      <CheckpointRestoreButton sessionId="session-2" turnId="turn-2" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
});

test('a late confirmation from an expired authority cannot invalidate or reopen UI', async () => {
  let finish!: () => void;
  confirm.mockReturnValueOnce(
    new Promise<void>((resolve) => (finish = resolve)),
  );
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const view = render(
    <QueryClientProvider client={client}>
      <CheckpointRestoreButton sessionId="session-1" turnId="turn-1" />
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Restore workspace to here…' }),
  );
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: 'Restore workspace' }));
  host.currentAuthorityKey = 'authority-2';
  host.authorityKey = 'authority-2';
  view.rerender(
    <QueryClientProvider client={client}>
      <CheckpointRestoreButton sessionId="session-2" turnId="turn-2" />
    </QueryClientProvider>,
  );
  finish();
  await Promise.resolve();
  expect(invalidate).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});
