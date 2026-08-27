/** @vitest-environment jsdom */

import {
  WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
  type WorkspaceBrowserPreviewPaneState,
} from '@kontourai/station-contracts/workspace-browser-preview';
import { describe, expect, test } from 'vitest';
import {
  admitRestoredBrowserPreviewPaneInstance,
  browserPreviewPanePresentationLabel,
  createBrowserPreviewPaneInstance,
  isCanonicalBrowserPreviewPaneInstance,
} from '../browserPreviewPaneInstance';
import {
  readBrowserPreviewPaneState,
  writeBrowserPreviewPaneState,
} from '../browserPreviewPaneStateStorage';

const state: WorkspaceBrowserPreviewPaneState = {
  version: WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
  projectId: 'project-uuid-1',
  requestedUrl: 'http://127.0.0.1:5173/',
  viewportPreference: 'responsive',
  updatedAt: '2026-08-09T12:00:00.000Z',
};

describe('Browser Preview pane instance and state boundary', () => {
  test('mints opaque identities while retaining the canonical project identity only in bound context', () => {
    const instance = createBrowserPreviewPaneInstance(
      state,
      'project-uuid-1',
      '0123456789abcdef0123456789abcdef',
    );

    expect(instance).toMatchObject({
      descriptorId: 'pane:builtin:workspace-preview:browser-preview',
      instanceId: 'browser-preview:0123456789abcdef0123456789abcdef',
      stateKey: 'browser-preview:0123456789abcdef0123456789abcdef',
      boundContext: {
        projectId: 'project-uuid-1',
        sourceId: 'builtin:workspace-browser-preview',
      },
    });
    expect(
      createBrowserPreviewPaneInstance(
        state,
        'project-slug-not-the-canonical-id',
        '0123456789abcdef0123456789abcdef',
      ),
    ).toBeNull();
  });

  test('restores only a matching canonical instance and separately parsed state', () => {
    const storage = window.localStorage;
    storage.clear();
    const instance = createBrowserPreviewPaneInstance(
      state,
      'project-uuid-1',
      '0123456789abcdef0123456789abcdef',
    )!;
    expect(
      writeBrowserPreviewPaneState(storage, instance.stateKey, state),
    ).toBe(true);
    expect(readBrowserPreviewPaneState(storage, instance.stateKey)).toEqual(
      state,
    );
    expect(isCanonicalBrowserPreviewPaneInstance(instance, state)).toBe(true);
    expect(
      admitRestoredBrowserPreviewPaneInstance(
        'project-uuid-1',
        instance,
        storage,
      ),
    ).toEqual(instance);
    expect(
      admitRestoredBrowserPreviewPaneInstance(
        'project-uuid-2',
        instance,
        storage,
      ),
    ).toBeNull();
    expect(
      browserPreviewPanePresentationLabel('project-uuid-1', instance, storage),
    ).toBe('Browser Preview');
  });
});
