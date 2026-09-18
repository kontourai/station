import { describe, expect, test } from 'vitest';
import {
  getWorkingDirectoryLeaf,
  inferProjectNameFromPath,
  looksLikeWorkspacePath,
  normalizeWorkingDirectory,
} from '../project-form-utils';

describe('project-form-utils path handling', () => {
  // POSIX behavior is pinned first so the Windows cases below cannot regress
  // it by sharing a code path.
  test('POSIX paths keep their leaf and root forms', () => {
    expect(normalizeWorkingDirectory('/tmp/project/')).toBe('/tmp/project');
    expect(getWorkingDirectoryLeaf('/tmp/project')).toBe('project');
    expect(inferProjectNameFromPath('/tmp/my-project')).toBe('My Project');
    expect(looksLikeWorkspacePath('/tmp/project')).toBe(true);
    expect(looksLikeWorkspacePath('code/')).toBe(false);
  });

  test('Windows paths take their leaf after the last backslash', () => {
    // Splitting on `/` alone treated the whole path as one segment and named
    // the project after it (the pre-fix behavior this pins out).
    expect(getWorkingDirectoryLeaf('C:\\Users\\brian\\my-project')).toBe(
      'my-project',
    );
    expect(inferProjectNameFromPath('C:\\Users\\brian\\my-project')).toBe(
      'My Project',
    );
    expect(looksLikeWorkspacePath('C:\\Users\\brian\\my-project')).toBe(true);
  });

  test('drive roots survive normalization instead of becoming drive-relative', () => {
    // `D:` alone is the process cwd on drive D — stripping the separator
    // from `D:\` would silently point the project somewhere else entirely.
    expect(normalizeWorkingDirectory('D:\\')).toBe('D:\\');
    expect(normalizeWorkingDirectory('D:/')).toBe('D:/');
    expect(getWorkingDirectoryLeaf('D:\\')).toBe('');
    expect(getWorkingDirectoryLeaf('D:/')).toBe('');
    expect(looksLikeWorkspacePath('D:\\')).toBe(false);
    expect(looksLikeWorkspacePath('D:\\projects')).toBe(true);
  });

  test('trailing backslashes are stripped like trailing slashes', () => {
    expect(normalizeWorkingDirectory('C:\\projects\\work\\')).toBe(
      'C:\\projects\\work',
    );
    expect(getWorkingDirectoryLeaf('C:\\projects\\work\\')).toBe('work');
  });
});
