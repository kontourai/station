import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { describe, expect, test } from 'vitest';
import { createFilePreviewPaneInstance } from '../filePreviewPaneInstance';
import {
  filePreviewPaneStateStorageKey,
  readFilePreviewPaneState,
  removeFilePreviewPaneState,
  removeUnreferencedFilePreviewPaneState,
  writeFilePreviewPaneState,
} from '../filePreviewPaneStateStorage';
import {
  persistWorkspacePaneHost,
  registerLiveWorkspacePaneHostDocument,
  removeWorkspacePaneHost,
  unregisterLiveWorkspacePaneHostDocument,
} from '../workspacePaneHostStorage';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    values,
  };
}

function preview(index: number, projectSlug = 'demo') {
  const state = {
    version: '1.0' as const,
    projectSlug,
    path: `src/file-${index}.ts`,
    wrap: true,
  };
  return {
    state,
    instance: createFilePreviewPaneInstance(
      state,
      projectSlug,
      index.toString(16).padStart(32, '0'),
    )!,
  };
}

function hostDocument(
  id: string,
  projectId: string,
  layoutId: string,
  instances: readonly WorkspacePaneInstance[],
) {
  return {
    version: '1.1' as const,
    id,
    scope: { kind: 'project' as const, projectId, layoutId },
    instances: [...instances],
    activeInstanceId: instances[0]!.instanceId,
    root: {
      type: 'tabs' as const,
      id: 'root',
      instanceIds: instances.map((instance) => instance.instanceId),
      selectedInstanceId: instances[0]!.instanceId,
    },
  };
}

describe('File Preview pane state storage', () => {
  test('round-trips only strict, data-only state', () => {
    const target = storage();
    expect(
      writeFilePreviewPaneState(target, 'file-preview:a', {
        version: '1.0',
        projectSlug: 'demo',
        path: 'src/main.ts',
        wrap: true,
      }),
    ).toBe(true);
    expect(readFilePreviewPaneState(target, 'file-preview:a')).toMatchObject({
      path: 'src/main.ts',
      wrap: true,
    });
    expect(removeFilePreviewPaneState(target, 'file-preview:a')).toBe(true);
    expect(readFilePreviewPaneState(target, 'file-preview:a')).toBeNull();
  });

  test('discards only a corrupt state entry', () => {
    const target = storage();
    target.values.set(
      filePreviewPaneStateStorageKey('file-preview:bad'),
      '{"path":"../../no"}',
    );
    target.values.set(
      filePreviewPaneStateStorageKey('file-preview:good'),
      JSON.stringify({
        version: '1.0',
        projectSlug: 'demo',
        path: 'src/main.ts',
        wrap: true,
      }),
    );
    expect(readFilePreviewPaneState(target, 'file-preview:bad')).toBeNull();
    expect(readFilePreviewPaneState(target, 'file-preview:good')?.path).toBe(
      'src/main.ts',
    );
  });

  test('reclaims corrupt and interrupted valid orphans when they poison the cap', () => {
    const target = storage();
    for (let index = 1; index <= 23; index += 1) {
      const entry = preview(index);
      target.values.set(
        filePreviewPaneStateStorageKey(entry.instance.stateKey),
        JSON.stringify(entry.state),
      );
    }
    target.values.set(
      filePreviewPaneStateStorageKey(`file-preview:${'f'.repeat(32)}`),
      '{corrupt',
    );
    const next = preview(25);
    expect(
      writeFilePreviewPaneState(target, next.instance.stateKey, next.state),
    ).toBe(true);
    expect(readFilePreviewPaneState(target, next.instance.stateKey)).toEqual(
      next.state,
    );
    expect(
      [...target.values.keys()].filter((key) =>
        key.startsWith('station:file-preview-pane-state:v1:'),
      ),
    ).toHaveLength(1);
  });

  test('preserves references owned by persisted and live hosts in other layouts and projects', () => {
    const target = storage();
    const persisted = preview(1, 'other-project');
    const live = preview(2, 'demo');
    for (let index = 1; index <= 24; index += 1) {
      const entry =
        index === 1 ? persisted : index === 2 ? live : preview(index);
      target.values.set(
        filePreviewPaneStateStorageKey(entry.instance.stateKey),
        JSON.stringify(entry.state),
      );
    }
    expect(
      persistWorkspacePaneHost(
        target,
        hostDocument('persisted-host', 'other-project', 'review', [
          persisted.instance,
        ]),
      ),
    ).toBe(true);
    const liveOwner = Symbol('live-test-host');
    expect(
      registerLiveWorkspacePaneHostDocument(
        target,
        liveOwner,
        hostDocument('live-host', 'demo', 'coding', [live.instance]),
      ),
    ).toBe(true);

    const next = preview(25);
    expect(
      writeFilePreviewPaneState(target, next.instance.stateKey, next.state),
    ).toBe(true);
    expect(
      readFilePreviewPaneState(target, persisted.instance.stateKey),
    ).toEqual(persisted.state);
    expect(readFilePreviewPaneState(target, live.instance.stateKey)).toEqual(
      live.state,
    );
    unregisterLiveWorkspacePaneHostDocument(target, liveOwner);
  });

  test('explicit removal preserves state still referenced by another persisted layout', () => {
    const target = storage();
    const shared = preview(1, 'demo');
    expect(
      writeFilePreviewPaneState(target, shared.instance.stateKey, shared.state),
    ).toBe(true);
    const otherLayout = hostDocument('other-layout-host', 'demo', 'review', [
      shared.instance,
    ]);
    expect(persistWorkspacePaneHost(target, otherLayout)).toBe(true);
    expect(
      removeUnreferencedFilePreviewPaneState(target, shared.instance.stateKey),
    ).toBe(false);
    expect(readFilePreviewPaneState(target, shared.instance.stateKey)).toEqual(
      shared.state,
    );

    expect(
      removeWorkspacePaneHost(target, otherLayout.scope, otherLayout.id),
    ).toBe(true);
    expect(
      removeUnreferencedFilePreviewPaneState(target, shared.instance.stateKey),
    ).toBe(true);
  });
});
