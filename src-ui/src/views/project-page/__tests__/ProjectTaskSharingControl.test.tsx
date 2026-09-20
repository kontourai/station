/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { getPublication, share, unshare } = vi.hoisted(() => ({
  getPublication: vi.fn(),
  share: vi.fn(),
  unshare: vi.fn(),
}));
const authorityState = vi.hoisted(() => ({ current: undefined as unknown }));
const authority = {
  apiBase: 'http://station.test',
  authorityKey: 'operator:1',
  isCurrent: () => true,
};
vi.mock('@kontourai/station-sdk/project-shared-tasks', () => ({
  getProjectSharedTaskPublication: getPublication,
  shareProjectTask: share,
  unshareProjectTask: unshare,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => authorityState.current,
}));

import { ProjectTaskSharingControl } from '../ProjectTaskSharingControl';

const project = {
  stationId: 'station-1',
  localProjectId: 'project-1',
  localProjectSlug: 'example',
  portableProjectId: 'portable-1',
};
const task = { id: 'task-1', createdAt: '2026-09-20T00:00:00.000Z' };
const unshared = { kind: 'unshared' as const, project, task };

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('ProjectTaskSharingControl', () => {
  beforeEach(() => {
    getPublication.mockReset();
    share.mockReset();
    unshare.mockReset();
    authorityState.current = authority;
  });

  test('reviews and publishes the exact Task through the captured authority', async () => {
    getPublication.mockResolvedValue(unshared);
    share.mockResolvedValue({
      kind: 'shared',
      publication: {
        version: 'station.shared-project-task/v1',
        project,
        task: { ...task, title: 'Task', status: 'ready' },
        shareId: '11111111-1111-4111-8111-111111111111',
        sharedAt: '2026-09-20T01:00:00.000Z',
      },
    });
    render(
      <ProjectTaskSharingControl
        slug="example"
        projectId="project-1"
        task={task}
      />,
      { wrapper: wrapper() },
    );
    expect(
      await screen.findByText('Not shared with Project viewers'),
    ).toBeTruthy();
    expect(
      screen.getByText(/existing and future human room messages/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Share Task' }));
    await waitFor(() => expect(share).toHaveBeenCalledOnce());
    expect(share).toHaveBeenCalledWith(
      authority.apiBase,
      'example',
      { project, task },
      expect.objectContaining({ requestScope: authority }),
    );
  });

  test('does not expose management when the operator-only read is denied', async () => {
    getPublication.mockRejectedValue(new Error('not found'));
    render(
      <ProjectTaskSharingControl
        slug="example"
        projectId="project-1"
        task={task}
      />,
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(getPublication).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: /Share|Revoke/ })).toBeNull();
  });

  test('missing request authority cannot read or mutate through an ambient target', () => {
    authorityState.current = undefined;
    render(
      <ProjectTaskSharingControl
        slug="example"
        projectId="project-1"
        task={task}
      />,
      { wrapper: wrapper() },
    );
    expect(getPublication).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(unshare).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Share|Revoke/ })).toBeNull();
  });

  test('shows shared status and revokes with the exact share incarnation', async () => {
    const publication = {
      version: 'station.shared-project-task/v1' as const,
      project,
      task: { ...task, title: 'Task', status: 'ready' as const },
      shareId: '11111111-1111-4111-8111-111111111111',
      sharedAt: '2026-09-20T01:00:00.000Z',
    };
    getPublication.mockResolvedValue({ kind: 'shared', publication });
    unshare.mockResolvedValue({ unshared: true });
    render(
      <ProjectTaskSharingControl
        slug="example"
        projectId="project-1"
        task={task}
      />,
      { wrapper: wrapper() },
    );
    expect(await screen.findByText('Shared with Project viewers')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke sharing' }));
    await waitFor(() => expect(unshare).toHaveBeenCalledOnce());
    expect(unshare).toHaveBeenCalledWith(
      authority.apiBase,
      'example',
      publication.shareId,
      { project, task },
      expect.objectContaining({ requestScope: authority }),
    );
  });

  test('a stale revoke refusal refreshes publication state', async () => {
    const publication = {
      version: 'station.shared-project-task/v1' as const,
      project,
      task: { ...task, title: 'Task', status: 'ready' as const },
      shareId: '11111111-1111-4111-8111-111111111111',
      sharedAt: '2026-09-20T01:00:00.000Z',
    };
    getPublication.mockResolvedValue({ kind: 'shared', publication });
    unshare.mockRejectedValue(new Error('Shared Task not found'));
    render(
      <ProjectTaskSharingControl
        slug="example"
        projectId="project-1"
        task={task}
      />,
      { wrapper: wrapper() },
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke sharing' }),
    );
    await waitFor(() => expect(getPublication).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Sharing state changed/)).toBeTruthy();
  });

  test('same-slug Project replacement cannot reuse the old review for mutation', async () => {
    let releaseOld!: (value: typeof unshared) => void;
    getPublication
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseOld = resolve)),
      )
      .mockResolvedValueOnce({
        ...unshared,
        project: { ...project, localProjectId: 'project-2' },
      });
    const view = render(
      <ProjectTaskSharingControl
        slug="example"
        projectId="project-1"
        task={task}
      />,
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(getPublication).toHaveBeenCalledOnce());
    view.rerender(
      <ProjectTaskSharingControl
        slug="example"
        projectId="project-2"
        task={task}
      />,
    );
    expect(
      await screen.findByText('Not shared with Project viewers'),
    ).toBeTruthy();
    releaseOld(unshared);
    fireEvent.click(screen.getByRole('button', { name: 'Share Task' }));
    await waitFor(() => expect(share).toHaveBeenCalledOnce());
    expect(share.mock.calls[0]![2].project.localProjectId).toBe('project-2');
  });

  test('late old Task mutation cannot settle notice or invalidate the new identity', async () => {
    getPublication.mockResolvedValue(unshared);
    let releaseShare!: (value: unknown) => void;
    share.mockImplementationOnce(
      () => new Promise((resolve) => (releaseShare = resolve)),
    );
    const view = render(
      <ProjectTaskSharingControl
        slug="example"
        projectId="project-1"
        task={task}
      />,
      { wrapper: wrapper() },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Share Task' }));
    await waitFor(() => expect(share).toHaveBeenCalledOnce());
    authorityState.current = {
      ...authority,
      authorityKey: 'operator:2',
    };
    const nextTask = {
      id: 'task-2',
      createdAt: '2026-09-20T02:00:00.000Z',
    };
    getPublication.mockResolvedValue({
      kind: 'unshared',
      project,
      task: nextTask,
    });
    view.rerender(
      <ProjectTaskSharingControl
        slug="example"
        projectId="project-1"
        task={nextTask}
      />,
    );
    expect(
      await screen.findByText('Not shared with Project viewers'),
    ).toBeTruthy();
    releaseShare({ kind: 'shared' });
    await waitFor(() => expect(getPublication).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Task shared with Project viewers/)).toBeNull();
    expect(screen.queryByText(/Sharing state changed/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Share Task' })).toBeTruthy();
  });
});
