/**
 * @vitest-environment jsdom
 */
// #5069: Pause/Resume and Archive send the right action, report what they
// stopped, and Delete's confirmation states the server's counts before the
// delete is sent.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(),
  remove: vi.fn(),
  preview: undefined as unknown,
  previewError: null as unknown,
}));

beforeEach(() => {
  mocks.lifecycle.mockReset();
  mocks.remove.mockReset();
  mocks.preview = {
    removes: { layouts: 2, knowledgeDocuments: 1, schedules: 3 },
    stops: { runningSessions: 4 },
    keeps: { tasks: 7, sessions: 12 },
  };
  mocks.previewError = null;
});

vi.mock('@kontourai/station-sdk', () => {
  class StationHttpError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    StationHttpError,
    useProjectLifecycleMutation: () => ({
      mutateAsync: mocks.lifecycle,
      isPending: false,
      error: null,
    }),
    useDeleteProjectMutation: () => ({
      mutateAsync: mocks.remove,
      isPending: false,
    }),
    useProjectDeletionPreviewQuery: (
      _slug: string,
      config: { enabled: boolean },
    ) =>
      config.enabled
        ? {
            data: mocks.previewError ? undefined : mocks.preview,
            error: mocks.previewError,
            isError: Boolean(mocks.previewError),
            refetch: vi.fn(),
          }
        : { data: undefined, error: null, isError: false, refetch: vi.fn() },
  };
});

const {
  ProjectLifecycleSection,
  deletionPreviewLines,
  lifecycleResultSummary,
} = await import('../ProjectLifecycleSection');

describe('ProjectLifecycleSection', () => {
  it('pauses and says how many running chats it stopped', async () => {
    mocks.lifecycle.mockResolvedValue({
      lifecycle: { state: 'paused', changedAt: '2026-11-16T00:00:00.000Z' },
      interrupted: 3,
      stillRunning: 0,
      failed: 0,
    });
    render(
      <ProjectLifecycleSection
        slug="atlas"
        name="Atlas"
        lifecycle={undefined}
        onDeleted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(mocks.lifecycle).toHaveBeenCalledWith('pause');
    await screen.findByText('Paused. Stopped 3 running chats.');
  });

  it('offers Resume while paused and Unarchive while archived', () => {
    const { rerender } = render(
      <ProjectLifecycleSection
        slug="atlas"
        name="Atlas"
        lifecycle={{ state: 'paused', changedAt: '2026-11-16T00:00:00.000Z' }}
        onDeleted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.lifecycle).toHaveBeenCalledWith('resume');
    rerender(
      <ProjectLifecycleSection
        slug="atlas"
        name="Atlas"
        lifecycle={{ state: 'archived', changedAt: '2026-11-16T00:00:00.000Z' }}
        onDeleted={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Pause' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(mocks.lifecycle).toHaveBeenLastCalledWith('unarchive');
  });

  it('with the preview off, offers no Pause or Archive but still lifts a hold', () => {
    const { rerender } = render(
      <ProjectLifecycleSection
        slug="atlas"
        name="Atlas"
        lifecycle={undefined}
        pauseArchiveEnabled={false}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete Project' })).toBeTruthy();
    rerender(
      <ProjectLifecycleSection
        slug="atlas"
        name="Atlas"
        lifecycle={{ state: 'paused', changedAt: '2026-11-16T00:00:00.000Z' }}
        pauseArchiveEnabled={false}
        onDeleted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.lifecycle).toHaveBeenCalledWith('resume');
  });

  it("states the server's counts before deleting", async () => {
    const onDeleted = vi.fn();
    mocks.remove.mockResolvedValue({});
    render(
      <ProjectLifecycleSection
        slug="atlas"
        name="Atlas"
        lifecycle={undefined}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete Project' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(
      'Project settings, 2 Layouts, 1 knowledge document, 3 schedules',
    );
    expect(dialog.textContent).toContain('4 running chats');
    expect(dialog.textContent).toContain(
      '7 Tasks, 12 chats, the repository checkout, pushed branches and pull requests',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(mocks.remove).toHaveBeenCalledWith('atlas');
  });
});

describe('copy helpers', () => {
  it('names the chats still finishing after the wait', () => {
    expect(
      lifecycleResultSummary({
        lifecycle: { state: 'archived', changedAt: 'x' },
        interrupted: 2,
        stillRunning: 1,
        failed: 0,
      }),
    ).toBe('Archived. Stopped 2 running chats. 1 chat still finishing.');
  });

  it('leaves out Stops when nothing is running', () => {
    expect(
      deletionPreviewLines({
        removes: { layouts: 1, knowledgeDocuments: 0, schedules: 0 },
        stops: { runningSessions: 0 },
        keeps: { tasks: 1, sessions: 1 },
      }).stops,
    ).toEqual([]);
  });
});
