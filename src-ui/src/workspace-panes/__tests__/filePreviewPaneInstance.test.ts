import { expect, test } from 'vitest';
import {
  admitRestoredFilePreviewPaneInstance,
  createFilePreviewPaneInstance,
  filePreviewPanePresentationLabel,
} from '../filePreviewPaneInstance';
import { writeFilePreviewPaneState } from '../filePreviewPaneStateStorage';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

test('mints opaque, collision-resistant file Preview identities without path geometry', () => {
  const state = {
    version: '1.0' as const,
    projectSlug: 'demo',
    path: 'src/main.ts',
    wrap: true,
  };
  const first = createFilePreviewPaneInstance(
    state,
    'project-uuid',
    'a'.repeat(32),
  )!;
  const second = createFilePreviewPaneInstance(
    { ...state, path: 'src/other.ts' },
    'project-uuid',
    'b'.repeat(32),
  )!;
  expect(first.instanceId).not.toContain('src');
  expect(first.stateKey).not.toContain('main');
  expect(first.instanceId).not.toBe(second.instanceId);
  expect(first.boundContext).toEqual({
    projectId: 'project-uuid',
    sourceId: 'builtin:workspace-file-preview',
  });
});

test('restoration admits only a matching code-owned builtin and its project state', () => {
  const target = storage();
  const instance = createFilePreviewPaneInstance(
    { version: '1.0', projectSlug: 'demo', path: 'src/main.ts', wrap: true },
    'project-uuid',
    'a'.repeat(32),
  )!;
  expect(
    writeFilePreviewPaneState(target, instance.stateKey, {
      version: '1.0',
      projectSlug: 'demo',
      path: 'src/main.ts',
      wrap: true,
    }),
  ).toBe(true);
  expect(
    admitRestoredFilePreviewPaneInstance(
      'project-uuid',
      'demo',
      instance,
      target,
    )?.instanceId,
  ).toBe(instance.instanceId);
  expect(
    admitRestoredFilePreviewPaneInstance(
      'project-uuid',
      'other',
      instance,
      target,
    ),
  ).toBeNull();
  expect(
    admitRestoredFilePreviewPaneInstance(
      'project-uuid',
      'demo',
      { ...instance, descriptorId: 'plugin:evil' },
      target,
    ),
  ).toBeNull();
  expect(
    admitRestoredFilePreviewPaneInstance(
      'project-uuid',
      'demo',
      { ...instance, stateKey: `file-preview:${'b'.repeat(32)}` },
      target,
    ),
  ).toBeNull();
  expect(
    admitRestoredFilePreviewPaneInstance(
      'project-uuid',
      'demo',
      {
        ...instance,
        boundContext: { ...instance.boundContext, taskId: 'decoy' },
      },
      target,
    ),
  ).toBeNull();
  expect(
    filePreviewPanePresentationLabel('project-uuid', 'demo', instance, target),
  ).toBe('File Preview — src/main.ts');
});

test('rejects non-cryptographic or non-canonical nonce shapes', () => {
  const state = {
    version: '1.0' as const,
    projectSlug: 'demo',
    path: 'src/main.ts',
    wrap: true,
  };
  expect(
    createFilePreviewPaneInstance(state, 'project-uuid', 'guessable'),
  ).toBeNull();
  expect(
    createFilePreviewPaneInstance(state, 'project-uuid', 'g'.repeat(32)),
  ).toBeNull();
});
