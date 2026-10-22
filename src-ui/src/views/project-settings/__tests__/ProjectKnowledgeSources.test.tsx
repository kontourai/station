// @vitest-environment jsdom
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ProjectKnowledgeSources } from '../ProjectKnowledgeSources';

const state = vi.hoisted(() => ({
  roots: [] as KnowledgeStoreRoot[],
  manage: true,
  capabilitiesError: false,
  checkingPermissions: false,
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
  useKnowledgeSourceCapabilitiesQuery: () => ({
    isError: state.capabilitiesError,
    isFetching: state.checkingPermissions,
    error: new Error('Permissions unavailable'),
    data: {
      canManageSources: state.manage,
      canAttachLegacy: state.manage,
      canCheckHostPaths: state.manage,
    },
    refetch: vi.fn(),
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
  state.manage = true;
  state.capabilitiesError = false;
  state.checkingPermissions = false;
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
      expectedProjectId: 'project-acme',
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

test('a read-only connection can inspect its source without management actions', () => {
  state.manage = false;
  render(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  expect(screen.getByText('Notes')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Create managed store' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Check source' })).toBeNull();
  expect(screen.queryByLabelText('Path on the Station host')).toBeNull();
  expect(
    screen.getByText(/Source setup is available to the Station operator/),
  ).toBeTruthy();
});

test('failed fresh permissions withhold cached management controls', () => {
  const view = render(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  state.capabilitiesError = true;
  view.rerender(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Check source' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Retry source permissions' }),
  ).toBeTruthy();
});

test.each([
  {
    legacy: false,
    action: 'Disconnect',
    title: 'Disconnect knowledge source?',
    confirm: 'Disconnect',
  },
  {
    legacy: true,
    action: 'Attach to this Project',
    title: 'Attach legacy store?',
    confirm: 'Attach store',
  },
])(
  'an open $confirm confirmation cannot submit after a fresh permission failure',
  ({ legacy, action, title, confirm }) => {
    state.roots = [{ ...root, ...(legacy ? { projectId: undefined } : {}) }];
    const view = render(
      <ProjectKnowledgeSources
        slug="acme"
        projectId="project-acme"
        authority={authority}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: action }));
    const dialog = screen.getByRole('dialog', { name: title });
    state.capabilitiesError = true;
    view.rerender(
      <ProjectKnowledgeSources
        slug="acme"
        projectId="project-acme"
        authority={authority}
      />,
    );
    const submit = within(dialog).getByRole('button', { name: confirm });
    expect(submit.hasAttribute('disabled')).toBe(true);
    expect(
      within(dialog).getByText(/no longer available to this connection/),
    ).toBeTruthy();
    fireEvent.click(submit);
    expect(state.attach).not.toHaveBeenCalled();
    expect(state.disconnect).not.toHaveBeenCalled();
  },
);

test('an open confirmation waits for a fresh permission check before becoming actionable', () => {
  const view = render(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  state.checkingPermissions = true;
  view.rerender(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  const dialog = screen.getByRole('dialog', {
    name: 'Disconnect knowledge source?',
  });
  expect(
    within(dialog)
      .getByRole('button', { name: 'Disconnect' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(
    within(dialog).getByText('Checking source management permission…'),
  ).toBeTruthy();
  state.checkingPermissions = false;
  view.rerender(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  expect(
    within(dialog)
      .getByRole('button', { name: 'Disconnect' })
      .hasAttribute('disabled'),
  ).toBe(false);
});
