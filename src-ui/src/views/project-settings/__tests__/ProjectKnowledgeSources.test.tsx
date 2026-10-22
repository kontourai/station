// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ProjectKnowledgeSources } from '../ProjectKnowledgeSources';

const state = vi.hoisted(() => ({
  create: vi.fn(),
  validate: vi.fn(),
  disconnect: vi.fn(),
}));
const root = {
  id: 'root:acme',
  scope: { kind: 'project' as const, projectSlug: 'acme' },
  adapterId: 'kit-default-store',
  displayName: 'Notes',
  storeRoot: '/host/notes',
  createdAt: '2026-10-22T00:00:00Z',
};
vi.mock('@kontourai/station-sdk', () => ({
  useKnowledgeRootsQuery: () => ({ data: [root], refetch: vi.fn() }),
  useKnowledgeAdaptersQuery: () => ({
    data: [{ id: 'kit-default-store', displayName: 'Default store' }],
  }),
  useCreateKnowledgeRootMutation: () => ({ mutateAsync: state.create }),
  useValidateKnowledgeRootMutation: () => ({ mutateAsync: state.validate }),
  useDeleteKnowledgeRootMutation: () => ({
    mutateAsync: state.disconnect,
    reset: vi.fn(),
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.validate.mockResolvedValue({ ok: true });
  state.create.mockResolvedValue(root);
  state.disconnect.mockResolvedValue({ id: root.id });
});
const authority = { apiBase: 'http://station.test', authorityKey: 'a' };

test('editing an existing source invalidates validation before connection', async () => {
  render(<ProjectKnowledgeSources slug="acme" authority={authority} />);
  const path = screen.getByLabelText('Path on the Station host');
  const connect = screen.getByRole('button', { name: 'Connect store' });
  expect(connect.hasAttribute('disabled')).toBe(true);
  fireEvent.change(path, { target: { value: '/host/first' } });
  fireEvent.click(screen.getByRole('button', { name: 'Validate store' }));
  await waitFor(() => expect(connect.hasAttribute('disabled')).toBe(false));
  fireEvent.change(path, { target: { value: '/host/second' } });
  expect(connect.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Validate store' }));
  await waitFor(() => expect(connect.hasAttribute('disabled')).toBe(false));
  fireEvent.click(connect);
  await waitFor(() =>
    expect(state.create).toHaveBeenCalledWith({
      scope: { kind: 'project', projectSlug: 'acme' },
      adapterId: 'kit-default-store',
      storeRoot: '/host/second',
    }),
  );
});

test('disconnect confirmation submits the observed root and explains retained files', async () => {
  render(<ProjectKnowledgeSources slug="acme" authority={authority} />);
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  expect(screen.getByText(/Its files remain on the host/)).toBeTruthy();
  const buttons = screen.getAllByRole('button', { name: 'Disconnect' });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() =>
    expect(state.disconnect).toHaveBeenCalledWith({
      rootId: root.id,
      expectedRoot: root,
    }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
