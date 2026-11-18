import { describe, expect, test } from 'vitest';
import {
  filterProjectLibraryItems,
  type ProjectLibraryItem,
  projectLibraryTasks,
  projectLibraryUploadPath,
  sortProjectLibraryItems,
} from '../project-library.js';

const upload: ProjectLibraryItem = {
  kind: 'upload',
  relativePath: 'notes/brief.md',
  byteLength: 7,
  mediaType: 'text/markdown',
  modifiedAt: '2026-11-02T00:00:00.000Z',
};
const output = (
  taskId: string,
  createdAt: string,
  task: { state: 'present'; title: string } | { state: 'orphaned' },
): ProjectLibraryItem => ({
  kind: 'task-output',
  outputId: `out-${taskId}-${createdAt}`,
  taskId,
  title: 'Report',
  fileName: 'report.txt',
  sourcePath: 'report.txt',
  mediaType: 'text/plain',
  byteLength: 4,
  contentAvailable: true,
  createdAt,
  task,
});

describe('projectLibraryUploadPath', () => {
  test.each([
    ['notes/brief.md', 'notes/brief.md'],
    ['notes\\brief.md', 'notes/brief.md'],
    ['a//b.txt', 'a/b.txt'],
  ])('%s is stored as %s', (input, path) => {
    expect(projectLibraryUploadPath(input)).toEqual({ ok: true, path });
  });

  test.each([
    ['.env', 'hidden'],
    ['repo/.git/config', 'hidden'],
    ['app/node_modules/x/index.js', 'node_modules'],
    ['../escape.txt', 'invalid'],
    ['/etc/passwd', 'invalid'],
    ['C:/Windows/win.ini', 'invalid'],
    ['bad\u0000name', 'invalid'],
    ['trailing.', 'invalid'],
    ['', 'invalid'],
  ])('%s is refused as %s', (input, reason) => {
    expect(projectLibraryUploadPath(input)).toEqual({ ok: false, reason });
  });
});

describe('Library filters', () => {
  const items = [
    upload,
    output('task-a', '2026-11-03T00:00:00.000Z', {
      state: 'present',
      title: 'Write the report',
    }),
    output('task-b', '2026-11-01T00:00:00.000Z', { state: 'orphaned' }),
  ];

  test('added by people, produced by Tasks, and by Task', () => {
    expect(filterProjectLibraryItems(items, { source: 'people' })).toEqual([
      upload,
    ]);
    expect(
      filterProjectLibraryItems(items, { source: 'tasks' }).map(
        (item) => item.kind === 'task-output' && item.taskId,
      ),
    ).toEqual(['task-a', 'task-b']);
    expect(
      filterProjectLibraryItems(items, { source: 'all', taskId: 'task-b' }),
    ).toHaveLength(1);
  });

  test('the Task filter names each Task once and marks a deleted one', () => {
    expect(projectLibraryTasks([...items, items[1]!])).toEqual([
      { taskId: 'task-a', title: 'Write the report', orphaned: false },
      { taskId: 'task-b', title: undefined, orphaned: true },
    ]);
  });

  test('newest first across uploads and outputs', () => {
    expect(
      sortProjectLibraryItems(items).map((item) =>
        item.kind === 'upload' ? item.relativePath : item.taskId,
      ),
    ).toEqual(['task-a', 'notes/brief.md', 'task-b']);
  });
});
