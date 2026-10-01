/** @vitest-environment jsdom */

import {
  createWorkspaceCodingDiffPaneInstance,
  createWorkspaceCodingFileBrowserPaneInstance,
} from '@kontourai/station-contracts/workspace-coding-panels';
import type { WorkspacePaneInstanceId } from '@kontourai/station-contracts/workspace-pane';
import { withWorkspacePaneInstanceLayoutBinding } from '@kontourai/station-contracts/workspace-pane';
import {
  createWorkspacePaneHostBaselineDocument,
  parseWorkspacePaneHostDocument,
  type WorkspacePaneHostDocumentV1,
} from '@kontourai/station-contracts/workspace-pane-host';
import { paneAdaptationFromLayoutTab } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import { describe, expect, test } from 'vitest';
import {
  admitRestoredFilePreviewPaneInstance,
  createFilePreviewPaneInstance,
} from '../../../workspace-panes/filePreviewPaneInstance';
import {
  readFilePreviewPaneState,
  writeFilePreviewPaneState,
} from '../../../workspace-panes/filePreviewPaneStateStorage';
import {
  persistWorkspacePaneHost,
  workspacePaneHostStorageKey,
} from '../../../workspace-panes/workspacePaneHostStorage';
import { initialWorkspacePaneHostState } from '../../../workspace-panes/workspacePaneHostTransactions';

const PROJECT = 'project-uuid';
const layout = { id: 'layout:coding' } as Parameters<
  typeof withWorkspacePaneInstanceLayoutBinding
>[1];
const scope = {
  kind: 'project' as const,
  projectId: PROJECT,
  layoutId: layout.id,
};
const bind = <
  T extends Parameters<typeof withWorkspacePaneInstanceLayoutBinding>[0],
>(
  instance: T,
) => withWorkspacePaneInstanceLayoutBinding(instance, layout)!;

const coding = bind(
  paneAdaptationFromLayoutTab(
    {
      id: 'coding',
      label: 'Coding',
      component: { kind: 'builtin-component', name: 'coding' },
    },
    {
      layoutSlug: 'coding',
      instanceScope: `project:${PROJECT}:source:builtin:coding`,
      modeContextRequirement: { project: true, source: true },
      boundContext: { projectId: PROJECT, sourceId: 'builtin:coding' },
    },
  )!.instance,
);
const files = bind(createWorkspaceCodingFileBrowserPaneInstance(PROJECT)!);
const diff = bind(createWorkspaceCodingDiffPaneInstance(PROJECT)!);
const previewState = {
  version: '1.0' as const,
  projectSlug: 'demo',
  path: 'src/app.ts',
  wrap: true,
};
const preview = createFilePreviewPaneInstance(
  previewState,
  PROJECT,
  'd'.repeat(32),
)!;

/**
 * What the Coding layout wrote before the stack: its baseline (Coding first,
 * selected) plus what a user did with it — Coding alone in one group of a
 * split, the panes and a File Preview in the other.
 */
function persistedBeforeTheStack(): WorkspacePaneHostDocumentV1 {
  const baseline = createWorkspacePaneHostBaselineDocument(
    'builtin-coding-coding',
    scope,
    [coding, files, diff],
  )!;
  const document = parseWorkspacePaneHostDocument({
    ...baseline,
    instances: [coding, files, diff, preview],
    root: {
      type: 'split',
      id: 'split-1',
      orientation: 'horizontal',
      ratio: 0.4,
      first: {
        type: 'tabs',
        id: 'root',
        instanceIds: [coding.instanceId],
        selectedInstanceId: coding.instanceId,
      },
      second: {
        type: 'tabs',
        id: 'group-2',
        instanceIds: [files.instanceId, diff.instanceId, preview.instanceId],
        selectedInstanceId: diff.instanceId as WorkspacePaneInstanceId,
      },
    },
    activeInstanceId: coding.instanceId,
  });
  if (!document) throw new Error('fixture is not a valid host document');
  return document;
}

/**
 * The stack reuses the stored document id (`builtin-coding-<slug>`) with no
 * migration step of its own: the host's restore drops an occurrence its
 * baseline no longer issues and prunes the group that leaves empty. These pin
 * that the persisted arrangement a user already has comes through that path
 * with the Coding occurrence gone and everything else kept.
 */
describe('a Coding host document persisted before the stack', () => {
  test('restores without the Coding occurrence, its group pruned, every other pane and its state kept', () => {
    const storage = window.localStorage;
    storage.clear();
    expect(persistWorkspacePaneHost(storage, persistedBeforeTheStack())).toBe(
      true,
    );
    expect(
      writeFilePreviewPaneState(storage, preview.stateKey, previewState),
    ).toBe(true);

    // The stack's baseline: the same id and scope, the Coding occurrence out.
    const baseline = createWorkspacePaneHostBaselineDocument(
      'builtin-coding-coding',
      scope,
      [files, diff],
    )!;
    const { document } = initialWorkspacePaneHostState({
      document: baseline,
      storage,
      admitRestoredInstance: (candidate) =>
        admitRestoredFilePreviewPaneInstance(
          PROJECT,
          'demo',
          candidate,
          storage,
        ),
    });

    const ids = document.instances.map((instance) => instance.instanceId);
    expect(ids).toEqual([
      files.instanceId,
      diff.instanceId,
      preview.instanceId,
    ]);
    expect(ids).not.toContain(coding.instanceId);
    // The group that held only Coding is gone; the split collapses to the
    // group the user built, with their selection in it.
    expect(document.root).toEqual({
      type: 'tabs',
      id: 'group-2',
      instanceIds: [files.instanceId, diff.instanceId, preview.instanceId],
      selectedInstanceId: diff.instanceId,
    });
    expect(ids).toContain(document.activeInstanceId);
    // The File Preview's own state is untouched.
    expect(readFilePreviewPaneState(storage, preview.stateKey)).toMatchObject({
      path: 'src/app.ts',
    });
  });

  test('a corrupt stored document is dropped for the baseline, not repaired into a partial one', () => {
    const storage = window.localStorage;
    storage.clear();
    storage.setItem(
      workspacePaneHostStorageKey(scope, 'builtin-coding-coding'),
      '{"version":"1.0","id":"builtin-coding-coding",',
    );
    const baseline = createWorkspacePaneHostBaselineDocument(
      'builtin-coding-coding',
      scope,
      [files, diff],
    )!;
    expect(
      initialWorkspacePaneHostState({ document: baseline, storage }).document,
    ).toBe(baseline);
  });
});
