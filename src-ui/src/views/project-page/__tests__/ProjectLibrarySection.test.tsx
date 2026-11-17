/** @vitest-environment jsdom */
import type { ProjectLibraryItem } from '@kontourai/station-contracts/project-library';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const flags = new Set<string>();
const navigate = vi.fn();
const upload = vi.fn();
const refetch = vi.fn();
let items: ProjectLibraryItem[] = [];
let libraryState: 'ok' | 'error' = 'ok';

vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flags,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-a',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('@kontourai/station-sdk/project-library', () => ({
  readProjectLibraryCapability: async () => true,
  downloadProjectLibraryContent: vi.fn(async () => ({
    bytes: new TextEncoder().encode('quarterly findings'),
    mediaType: 'text/plain',
    safePreview: null,
  })),
  useProjectLibraryQuery: () =>
    libraryState === 'error'
      ? { isPending: false, isError: true, error: new Error('boom'), refetch }
      : {
          isPending: false,
          isError: false,
          data: { items, partial: false, truncated: false },
          refetch,
        },
  useUploadProjectLibraryFileMutation: () => ({ mutateAsync: upload }),
  useDeleteProjectLibraryFileMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

import { ProjectLibrarySection } from '../ProjectLibrarySection';

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectLibrarySection slug="research" />
    </QueryClientProvider>,
  );
}

const uploadItem: ProjectLibraryItem = {
  kind: 'upload',
  relativePath: 'notes/brief.md',
  byteLength: 7,
  mediaType: 'text/markdown',
  modifiedAt: '2026-11-03T00:00:00.000Z',
};
const keptItem: ProjectLibraryItem = {
  kind: 'task-output',
  outputId: 'out-1',
  taskId: 'task-a',
  title: 'Report',
  fileName: 'report.txt',
  sourcePath: 'report.txt',
  mediaType: 'text/plain',
  byteLength: 18,
  contentAvailable: true,
  createdAt: '2026-11-02T00:00:00.000Z',
  task: { state: 'present', title: 'Write the report' },
};
const orphanItem: ProjectLibraryItem = {
  ...keptItem,
  outputId: 'out-2',
  taskId: 'task-gone',
  fileName: 'old.txt',
  createdAt: '2026-11-01T00:00:00.000Z',
  task: { state: 'orphaned' },
};

beforeEach(() => {
  flags.clear();
  flags.add('project-library');
  items = [uploadItem, keptItem, orphanItem];
  libraryState = 'ok';
  navigate.mockReset();
  upload.mockReset().mockResolvedValue({});
  refetch.mockReset();
});
afterEach(cleanup);

describe('ProjectLibrarySection', () => {
  test('lists uploads and kept files, links each to its Task, and marks an orphan', async () => {
    mount();
    const list = await screen.findByRole('list', { name: 'Library files' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(
      within(list).getByRole('button', { name: 'From Write the report' }),
    );
    expect(navigate).toHaveBeenCalledWith('/tasks/task-a');
    expect(within(list).getByText('Orphaned')).toBeTruthy();
    expect(within(list).getByText('Its Task was deleted.')).toBeTruthy();
  });

  test('filters by who added a file and by Task', async () => {
    mount();
    const show = await screen.findByLabelText('Show');
    fireEvent.change(show, { target: { value: 'people' } });
    const list = screen.getByRole('list', { name: 'Library files' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('notes/brief.md')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Task'), {
      target: { value: 'task-gone' },
    });
    expect(
      within(screen.getByRole('list', { name: 'Library files' })).getByText(
        'old.txt',
      ),
    ).toBeTruthy();
  });

  test('previews a kept file in place', async () => {
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Preview report.txt' }),
    );
    expect(await screen.findByText('quarterly findings')).toBeTruthy();
  });

  test('a picked folder uploads its files and skips hidden files and node_modules', async () => {
    mount();
    const input = await screen.findByLabelText('Choose a folder to add');
    const file = (name: string, path: string) =>
      Object.assign(new File(['x'], name), { webkitRelativePath: path });
    fireEvent.change(input, {
      target: {
        files: [
          file('a.md', 'site/a.md'),
          file('config', 'site/.git/config'),
          file('x.js', 'site/node_modules/x/x.js'),
        ],
      },
    });
    expect(
      await screen.findByText(
        'Added 1 file. Skipped 2 hidden or node_modules files.',
      ),
    ).toBeTruthy();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ slug: 'research', relativePath: 'site/a.md' }),
    );
  });

  test('a failed read offers Retry', async () => {
    libraryState = 'error';
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  test('nothing renders while the preview is off', () => {
    flags.clear();
    mount();
    expect(screen.queryByText('Library')).toBeNull();
  });
});
