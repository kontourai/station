/** @vitest-environment jsdom */
import {
  PROJECT_LIBRARY_V1,
  type ProjectLibraryItem,
} from '@kontourai/station-contracts/project-library';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const flags = new Set<string>();
const navigate = vi.fn();
const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const addUpload = vi.fn<(path: string) => Promise<Response>>();
const apiBase = 'http://station.test';
let authorityKey = 'authority-a';

function captureScope() {
  const capturedKey = authorityKey;
  return {
    apiBase,
    authorityKey: capturedKey,
    isCurrent: () => authorityKey === capturedKey,
  };
}
let items: ProjectLibraryItem[] = [];
let libraryState: 'ok' | 'error' = 'ok';

vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flags,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: captureScope,
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('@kontourai/station-sdk/project-library', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@kontourai/station-sdk/project-library')
  >()),
  readProjectLibraryCapability: async () => true,
  downloadProjectLibraryContent: vi.fn(async () => ({
    bytes: new TextEncoder().encode('quarterly findings'),
    mediaType: 'text/plain',
    safePreview: null,
  })),
}));

import { ProjectLibrarySection } from '../ProjectLibrarySection';

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (slug: string) => (
    <QueryClientProvider client={client}>
      <ProjectLibrarySection slug={slug} />
    </QueryClientProvider>
  );
  const view = render(tree('research'));
  return { showProject: (slug: string) => view.rerender(tree(slug)) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const ok = (data: unknown) => Response.json({ success: true, data });
const refused = () =>
  Response.json({ success: false, error: 'boom' }, { status: 400 });
const files = (...names: string[]) =>
  names.map((name) => new File(['x'], name));

function libraryRequests(slug = 'research') {
  return request.mock.calls
    .filter(
      ([input]) => new URL(input).pathname === `/api/projects/${slug}/library`,
    )
    .map(([, init]) => init?.method ?? 'GET');
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
  authorityKey = 'authority-a';
  setClientCredentialResolver(() => ({
    origin: apiBase,
    requestAuthority: captureScope(),
  }));
  addUpload.mockReset().mockImplementation(async (path) => {
    const added = { ...uploadItem, relativePath: path };
    items.push(added);
    return ok(added);
  });
  request.mockReset().mockImplementation(async (input, init) => {
    const url = new URL(input);
    const match =
      /^\/api\/projects\/(research|other)\/library(\/uploads)?$/.exec(
        url.pathname,
      );
    if (match?.[2] && init?.method === 'PUT') {
      const path = url.searchParams.get('path');
      if (path) return addUpload(path);
    }
    if (match && !match[2] && init?.method === 'GET') {
      if (libraryState === 'error') return refused();
      return ok({
        version: PROJECT_LIBRARY_V1,
        projectId: match[1],
        items: match[1] === 'research' ? items : [],
        partial: false,
        truncated: false,
      });
    }
    throw new Error(`Unexpected Library request: ${init?.method} ${url}`);
  });
  vi.stubGlobal('fetch', request);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver();
});

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
    expect(await screen.findByText('site/a.md')).toBeTruthy();
    expect(addUpload.mock.calls).toEqual([['site/a.md']]);
    expect(libraryRequests()).toEqual(['GET', 'GET']);
  });

  test('refreshes the mounted Library once after a batch with a rejected upload', async () => {
    addUpload.mockImplementationOnce(async () => refused());
    mount();
    await screen.findByText('notes/brief.md');
    fireEvent.change(screen.getByLabelText('Choose files to add'), {
      target: { files: files('rejected.md', 'second.md', 'third.md') },
    });

    expect(await screen.findByText('Added 2 files.')).toBeTruthy();
    expect(screen.getByText("1 file didn't upload: rejected.md")).toBeTruthy();
    expect(await screen.findByText('second.md')).toBeTruthy();
    expect(screen.getByText('third.md')).toBeTruthy();
    expect(screen.queryByText('rejected.md')).toBeNull();
    expect(addUpload.mock.calls).toEqual([
      ['rejected.md'],
      ['second.md'],
      ['third.md'],
    ]);
    expect(libraryRequests()).toEqual(['GET', 'GET']);
  });

  test('a batch takes a fresh Library snapshot when the initial read is still pending', async () => {
    const read = request.getMockImplementation()!;
    const pending = deferred<void>();
    request.mockImplementationOnce(async (input, init) => {
      const beforeUploads = await read(input, init);
      await pending.promise;
      return beforeUploads;
    });

    mount();
    const input = await screen.findByLabelText('Choose files to add');
    await vi.waitFor(() => expect(libraryRequests()).toEqual(['GET']));
    fireEvent.change(input, {
      target: { files: files('first.md', 'second.md') },
    });
    try {
      expect(await screen.findByText('Added 2 files.')).toBeTruthy();
      expect(libraryRequests()).toEqual(['GET', 'GET']);
      expect(await screen.findByText('first.md')).toBeTruthy();
      expect(screen.getByText('second.md')).toBeTruthy();
    } finally {
      await act(async () => pending.resolve());
    }
    expect(screen.getByText('first.md')).toBeTruthy();
    expect(screen.getByText('second.md')).toBeTruthy();
  });

  test('a batch refreshes its original Project without publishing status on the new Project', async () => {
    const originalUpload = addUpload.getMockImplementation()!;
    const held = deferred<void>();
    addUpload.mockImplementationOnce(async (path) => {
      await held.promise;
      return originalUpload(path);
    });
    const view = mount();
    await screen.findByText('notes/brief.md');
    fireEvent.change(screen.getByLabelText('Choose files to add'), {
      target: { files: files('first.md', 'second.md') },
    });
    await vi.waitFor(() => expect(addUpload).toHaveBeenCalledTimes(1));
    view.showProject('other');
    await screen.findByText('This Library is empty');
    await act(async () => held.resolve());
    await vi.waitFor(() => expect(addUpload).toHaveBeenCalledTimes(2));

    expect(screen.queryByText('Added 2 files.')).toBeNull();
    expect(libraryRequests('other')).toEqual(['GET']);
    const putProjects = request.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([input]) => new URL(input).pathname);
    expect(putProjects).toEqual([
      '/api/projects/research/library/uploads',
      '/api/projects/research/library/uploads',
    ]);
    view.showProject('research');
    expect(await screen.findByText('second.md')).toBeTruthy();
  });

  test('a batch stops sending files after its Station authority changes', async () => {
    const held = deferred<Response>();
    addUpload.mockImplementationOnce(() => held.promise);
    const view = mount();
    await screen.findByText('notes/brief.md');
    fireEvent.change(screen.getByLabelText('Choose files to add'), {
      target: { files: files('first.md', 'second.md') },
    });
    await vi.waitFor(() => expect(addUpload).toHaveBeenCalledTimes(1));
    authorityKey = 'authority-b';
    view.showProject('research');
    await screen.findByText('notes/brief.md');
    await act(async () =>
      held.resolve(ok({ ...uploadItem, relativePath: 'first.md' })),
    );

    expect(addUpload.mock.calls).toEqual([['first.md']]);
    expect(libraryRequests()).toEqual(['GET', 'GET']);
    expect(screen.queryByText("Some files didn't upload")).toBeNull();
    expect(screen.queryByText('first.md')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add files' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  test('a failed refresh leaves the upload outcome visible and offers Retry', async () => {
    mount();
    await screen.findByText('notes/brief.md');
    libraryState = 'error';
    fireEvent.change(screen.getByLabelText('Choose files to add'), {
      target: { files: files('added.md') },
    });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText('Added 1 file.')).toBeTruthy();
    expect(screen.queryByText('Adding 1 of 1…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add files' })).toHaveProperty(
      'disabled',
      false,
    );

    libraryState = 'ok';
    fireEvent.click(retry);
    expect(await screen.findByText('added.md')).toBeTruthy();
  });

  test('nothing renders while the preview is off', () => {
    flags.clear();
    mount();
    expect(screen.queryByText('Library')).toBeNull();
  });
});
