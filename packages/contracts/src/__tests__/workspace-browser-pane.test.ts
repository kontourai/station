import { describe, expect, test } from 'vitest';
import {
  migrateWorkspaceBrowserPaneState,
  parseStoredWorkspaceBrowserPaneState,
  parseWorkspaceBrowserPaneState,
} from '../workspace-browser-pane.js';

const SESSION = 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77';
const v2 = {
  version: '2.0',
  projectId: 'project-uuid-1',
  browserSessionId: SESSION,
  updatedAt: '2026-09-22T12:00:00.000Z',
};
const v1 = {
  version: '1.0',
  projectId: 'project-uuid-1',
  requestedUrl: 'http://127.0.0.1:5173/',
  viewportPreference: 'mobile',
  updatedAt: '2026-08-09T12:00:00.000Z',
};

describe('Browser pane state v2', () => {
  test('parses exactly the four v2 fields', () => {
    expect(parseWorkspaceBrowserPaneState(v2)).toEqual(v2);
    expect(parseWorkspaceBrowserPaneState({ ...v2, url: 'x' })).toBeNull();
    expect(
      parseWorkspaceBrowserPaneState({ ...v2, browserSessionId: 'bs_nope' }),
    ).toBeNull();
    expect(
      parseWorkspaceBrowserPaneState({ ...v2, updatedAt: '2026-09-22' }),
    ).toBeNull();
    expect(
      parseWorkspaceBrowserPaneState({ ...v2, version: '1.0' }),
    ).toBeNull();
    expect(
      parseWorkspaceBrowserPaneState({ ...v2, projectId: ' padded ' }),
    ).toBeNull();
  });

  test('reads a stored record of either version', () => {
    expect(parseStoredWorkspaceBrowserPaneState(v2)).toEqual({
      version: '2.0',
      state: v2,
    });
    expect(parseStoredWorkspaceBrowserPaneState(v1)).toEqual({
      version: '1.0',
      migration: {
        projectId: 'project-uuid-1',
        requestedUrl: 'http://127.0.0.1:5173/',
        viewportPreference: 'mobile',
      },
    });
    expect(parseStoredWorkspaceBrowserPaneState({ version: '3.0' })).toBeNull();
    expect(parseStoredWorkspaceBrowserPaneState(null)).toBeNull();
  });

  test('a v1 migration becomes the v2 record for the session it opened', () => {
    const stored = parseStoredWorkspaceBrowserPaneState(v1);
    if (stored?.version !== '1.0') throw new Error('expected a v1 record');
    expect(
      migrateWorkspaceBrowserPaneState(
        stored.migration,
        SESSION,
        '2026-09-22T12:00:00.000Z',
      ),
    ).toEqual(v2);
    // A bad session id never produces a record.
    expect(
      migrateWorkspaceBrowserPaneState(
        stored.migration,
        'not-a-session',
        '2026-09-22T12:00:00.000Z',
      ),
    ).toBeNull();
  });
});
