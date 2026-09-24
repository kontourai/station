/** @vitest-environment jsdom */

import {
  WORKSPACE_BROWSER_PANE_STATE_VERSION,
  type WorkspaceBrowserPaneState,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { describe, expect, test } from 'vitest';
import {
  admitRestoredBrowserPreviewPaneInstance,
  browserPreviewPanePresentationLabel,
  createBrowserPreviewPaneInstance,
  isCanonicalBrowserPreviewPaneInstance,
  removeRemovedBrowserPreviewPaneState,
} from '../browserPreviewPaneInstance';
import {
  readBrowserPreviewPaneState,
  writeBrowserPreviewPaneState,
} from '../browserPreviewPaneStateStorage';

const state: WorkspaceBrowserPaneState = {
  version: WORKSPACE_BROWSER_PANE_STATE_VERSION,
  projectId: 'project-uuid-1',
  browserSessionId: 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77',
  updatedAt: '2026-09-22T12:00:00.000Z',
};
const NONCE = '0123456789abcdef0123456789abcdef';
const storageKey = (stateKey: string) =>
  `station:browser-preview-pane-state:v1:${encodeURIComponent(stateKey)}`;

describe('Browser pane instance and state boundary (v2)', () => {
  test('mints opaque identities while retaining the canonical project identity only in bound context', () => {
    const instance = createBrowserPreviewPaneInstance(
      state,
      'project-uuid-1',
      NONCE,
    );
    expect(instance).toMatchObject({
      descriptorId: 'pane:builtin:workspace-preview:browser-preview',
      instanceId: `browser-preview:${NONCE}`,
      stateKey: `browser-preview:${NONCE}`,
      boundContext: {
        projectId: 'project-uuid-1',
        sourceId: 'builtin:workspace-browser-preview',
      },
    });
    expect(
      createBrowserPreviewPaneInstance(state, 'another-project', NONCE),
    ).toBeNull();
  });

  test('persists only the session reference, and restores only a matching canonical instance', () => {
    const storage = window.localStorage;
    storage.clear();
    const instance = createBrowserPreviewPaneInstance(
      state,
      'project-uuid-1',
      NONCE,
    )!;
    expect(
      writeBrowserPreviewPaneState(storage, instance.stateKey, state),
    ).toBe(true);
    expect(JSON.parse(storage.getItem(storageKey(instance.stateKey))!)).toEqual(
      state,
    );
    expect(readBrowserPreviewPaneState(storage, instance.stateKey)).toEqual({
      version: '2.0',
      state,
    });
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
    ).toBe('Browser');
    expect(
      removeRemovedBrowserPreviewPaneState('project-uuid-1', instance, storage),
    ).toBe(true);
    expect(storage.getItem(storageKey(instance.stateKey))).toBeNull();
  });

  test('a v1 record under the same key is still restored, as a migration', () => {
    const storage = window.localStorage;
    storage.clear();
    const instance = createBrowserPreviewPaneInstance(
      state,
      'project-uuid-1',
      NONCE,
    )!;
    const v1 = {
      version: '1.0',
      projectId: 'project-uuid-1',
      requestedUrl: 'http://127.0.0.1:5173/',
      viewportPreference: 'responsive',
      updatedAt: '2026-08-09T12:00:00.000Z',
    };
    storage.setItem(storageKey(instance.stateKey), JSON.stringify(v1));
    expect(readBrowserPreviewPaneState(storage, instance.stateKey)).toEqual({
      version: '1.0',
      migration: {
        projectId: 'project-uuid-1',
        requestedUrl: 'http://127.0.0.1:5173/',
        viewportPreference: 'responsive',
      },
    });
    expect(
      admitRestoredBrowserPreviewPaneInstance(
        'project-uuid-1',
        instance,
        storage,
      ),
    ).toEqual(instance);
  });

  test('a malformed record is removed and admits nothing', () => {
    const storage = window.localStorage;
    storage.clear();
    const instance = createBrowserPreviewPaneInstance(
      state,
      'project-uuid-1',
      NONCE,
    )!;
    storage.setItem(
      storageKey(instance.stateKey),
      JSON.stringify({ ...state, browserSessionId: 'not-a-session' }),
    );
    expect(readBrowserPreviewPaneState(storage, instance.stateKey)).toBeNull();
    expect(storage.getItem(storageKey(instance.stateKey))).toBeNull();
    expect(
      admitRestoredBrowserPreviewPaneInstance(
        'project-uuid-1',
        instance,
        storage,
      ),
    ).toBeNull();
  });
});
