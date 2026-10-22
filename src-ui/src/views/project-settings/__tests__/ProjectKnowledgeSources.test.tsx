// @vitest-environment jsdom
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ProjectKnowledgeSources } from '../ProjectKnowledgeSources';

const state = vi.hoisted(() => ({
  roots: [] as KnowledgeStoreRoot[],
  create: vi.fn(),
  attach: vi.fn(),
  validate: vi.fn(),
  disconnect: vi.fn(),
}));
const root = {
  id: 'root:acme',
  projectId: 'project-acme',
  scope: { kind: 'project' as const, projectSlug: 'acme' },
  adapterId: 'kit-default-store',
  displayName: 'Notes',
  storeRoot: '/host/notes',
  createdAt: '2026-10-22T00:00:00Z',
};
vi.mock('@kontourai/station-sdk', () => ({
  useAttachKnowledgeRootProjectMutation: () => ({
    mutateAsync: state.attach,
    reset: vi.fn(),
  }),
  useKnowledgeRootsQuery: () => ({ data: state.roots, refetch: vi.fn() }),
  useKnowledgeAdaptersQuery: () => ({
    data: [{ id: 'kit-default-store', displayName: 'Default store' }],
  }),
  useCreateKnowledgeRootMutation: () => ({
    mutateAsync: state.create,
    data: root,
  }),
  useValidateKnowledgeRootMutation: () => ({ mutateAsync: state.validate }),
  useDeleteKnowledgeRootMutation: () => ({
    mutateAsync: state.disconnect,
    reset: vi.fn(),
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.roots = [root];
  state.validate.mockResolvedValue({ ok: true });
  state.create.mockResolvedValue(root);
  state.disconnect.mockResolvedValue({ id: root.id });
});
const authority = { apiBase: 'http://station.test', authorityKey: 'a' };

test('editing an existing source invalidates validation before connection', async () => {
  render(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  const path = screen.getByLabelText('Path on the Station host');
  const connect = screen.getByRole('button', { name: 'Connect store' });
  expect(connect.hasAttribute('disabled')).toBe(true);
  fireEvent.change(path, { target: { value: '/host/first' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check source' }));
  await waitFor(() => expect(connect.hasAttribute('disabled')).toBe(false));
  fireEvent.change(path, { target: { value: '/host/second' } });
  expect(connect.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check source' }));
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
  render(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
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

test('a connected default-format store prevents another managed alias', () => {
  render(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  expect(
    screen.queryByRole('button', { name: 'Create managed store' }),
  ).toBeNull();
  expect(
    screen.getByText(/A default-format store is already connected/),
  ).toBeTruthy();
});

test('a removed store restores managed creation despite a retained creation result', () => {
  const view = render(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  expect(
    screen.queryByRole('button', { name: 'Create managed store' }),
  ).toBeNull();
  state.roots = [];
  view.rerender(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Create managed store' }),
  ).toBeTruthy();
  expect(
    screen.queryByText(/A default-format store is already connected/),
  ).toBeNull();
});

test('legacy attachment confirms member visibility and pins the exact registration and current Project', async () => {
  const legacy = { ...root, projectId: undefined };
  state.roots = [legacy];
  state.attach.mockResolvedValue(root);
  render(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Attach to this Project' }),
  );
  expect(screen.getByText(/Project members with view access/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Attach store' }));
  await waitFor(() =>
    expect(state.attach).toHaveBeenCalledWith({
      expectedRoot: legacy,
      projectSlug: 'acme',
      projectId: 'project-acme',
    }),
  );
});
