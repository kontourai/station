/** @vitest-environment jsdom */

import { WORKSPACE_BASIS_PANE_DESCRIPTOR } from '@kontourai/station-basis-pane/workspace-basis-pane';
import { WORKSPACE_BOARD_PANE_DESCRIPTOR } from '@kontourai/station-board-pane/workspace-board-pane';
import { WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-browser-preview';
import { WORKSPACE_CHAT_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-chat-pane';
import {
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
  WORKSPACE_READINESS_PANE_DESCRIPTOR,
  WORKSPACE_TRUST_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import type { WorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { paneAdaptationFromLayoutTab } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import {
  WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR,
  WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-task-room';
import { expect, test } from 'vitest';
import {
  isCanonicalBuiltinBoardDescriptor,
  isCanonicalBuiltinBrowserPreviewDescriptor,
  isCanonicalBuiltinChatDescriptor,
  isCanonicalBuiltinCodingDiffDescriptor,
  isCanonicalBuiltinCodingFileBrowserDescriptor,
  isCanonicalBuiltinCodingTerminalDescriptor,
  isCanonicalBuiltinFilePreviewDescriptor,
  isCanonicalBuiltinPlanDescriptor,
  isCanonicalBuiltinReadinessDescriptor,
  isCanonicalBuiltinTaskRoomChatDescriptor,
  isCanonicalBuiltinTaskRoomEditorDescriptor,
  isCanonicalBuiltinTrustDescriptor,
} from '../builtinWorkspacePaneCanonical';
import { getBuiltinWorkspacePaneRenderer } from '../builtinWorkspacePaneRegistry';
import { FILE_PREVIEW_PANE_DESCRIPTOR } from '../filePreviewPaneInstance';

/**
 * A lookalike must fail the predicate AND the registry boundary: a registry
 * entry that stopped consulting its predicate would still hand it a renderer.
 */
function expectRefused(
  isCanonical: (descriptor: WorkspacePaneDescriptor) => boolean,
  lookalike: WorkspacePaneDescriptor,
) {
  expect(isCanonical(lookalike)).toBe(false);
  expect(getBuiltinWorkspacePaneRenderer(lookalike)).toBeNull();
}

test('admits only the adapter-minted builtin coding descriptor, never a plugin/decoy tuple', () => {
  const canonical = paneAdaptationFromLayoutTab(
    {
      id: 'coding',
      label: 'Coding',
      component: { kind: 'builtin-component', name: 'coding' },
    },
    {
      layoutSlug: 'coding',
      instanceScope: 'project:demo:source:builtin:coding',
      modeContextRequirement: { project: true, source: true },
      boundContext: { projectId: 'demo', sourceId: 'builtin:coding' },
    },
  )!;
  expect(getBuiltinWorkspacePaneRenderer(canonical.descriptor)).toBeTypeOf(
    'function',
  );
  expect(
    getBuiltinWorkspacePaneRenderer({
      ...canonical.descriptor,
      provenance: { origin: 'plugin', pluginId: 'decoy' },
    }),
  ).toBeNull();
});

test('registers only the code-owned File Preview descriptor', () => {
  expect(
    isCanonicalBuiltinFilePreviewDescriptor(FILE_PREVIEW_PANE_DESCRIPTOR),
  ).toBe(true);
  expect(
    getBuiltinWorkspacePaneRenderer(FILE_PREVIEW_PANE_DESCRIPTOR),
  ).toBeTypeOf('function');
  expectRefused(isCanonicalBuiltinFilePreviewDescriptor, {
    ...FILE_PREVIEW_PANE_DESCRIPTOR,
    rendererId:
      'plugin:file-preview' as typeof FILE_PREVIEW_PANE_DESCRIPTOR.rendererId,
  });
  expectRefused(isCanonicalBuiltinFilePreviewDescriptor, {
    ...FILE_PREVIEW_PANE_DESCRIPTOR,
    modes: [
      {
        id: 'default',
        contextRequirement: {
          ...FILE_PREVIEW_PANE_DESCRIPTOR.modes[0].contextRequirement,
          workspace: true,
        },
      },
    ],
  });
});

test('registers only the code-owned Browser Preview descriptor', () => {
  expect(
    isCanonicalBuiltinBrowserPreviewDescriptor(
      WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
    ),
  ).toBe(true);
  expect(
    getBuiltinWorkspacePaneRenderer(WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR),
  ).toBeTypeOf('function');
  expectRefused(isCanonicalBuiltinBrowserPreviewDescriptor, {
    ...WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
    modes: [{ id: 'default', contextRequirement: { project: true } }],
  });
});

test('registers only the code-owned Chat descriptor', () => {
  expect(isCanonicalBuiltinChatDescriptor(WORKSPACE_CHAT_PANE_DESCRIPTOR)).toBe(
    true,
  );
  expect(
    getBuiltinWorkspacePaneRenderer(WORKSPACE_CHAT_PANE_DESCRIPTOR),
  ).toBeTypeOf('function');
  expectRefused(isCanonicalBuiltinChatDescriptor, {
    ...WORKSPACE_CHAT_PANE_DESCRIPTOR,
    placement: {
      ...WORKSPACE_CHAT_PANE_DESCRIPTOR.placement,
      preferredRegion: 'standalone',
    },
  });
});

test('admits the exact task-room pane declarations and no lookalikes', () => {
  expect(
    isCanonicalBuiltinTaskRoomChatDescriptor(
      WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR,
    ),
  ).toBe(true);
  expect(
    isCanonicalBuiltinTaskRoomEditorDescriptor(
      WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
    ),
  ).toBe(true);
  expect(
    getBuiltinWorkspacePaneRenderer(WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR),
  ).toBeTypeOf('function');
  expectRefused(isCanonicalBuiltinTaskRoomEditorDescriptor, {
    ...WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
    provenance: { origin: 'plugin', pluginId: 'lookalike' },
  });
});

test('registers only the code-owned Files, Diff, and Terminal descriptors', () => {
  expect(
    isCanonicalBuiltinCodingFileBrowserDescriptor(
      WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
    ),
  ).toBe(true);
  expect(
    getBuiltinWorkspacePaneRenderer(
      WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
    ),
  ).toBeTypeOf('function');
  expect(
    isCanonicalBuiltinCodingDiffDescriptor(
      WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
    ),
  ).toBe(true);
  expect(
    getBuiltinWorkspacePaneRenderer(WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR),
  ).toBeTypeOf('function');
  expect(
    isCanonicalBuiltinCodingTerminalDescriptor(
      WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
    ),
  ).toBe(true);
  expect(
    getBuiltinWorkspacePaneRenderer(WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR),
  ).toBeTypeOf('function');
  expectRefused(isCanonicalBuiltinCodingFileBrowserDescriptor, {
    ...WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
    provenance: { origin: 'plugin', pluginId: 'decoy' },
  });
  expectRefused(isCanonicalBuiltinCodingDiffDescriptor, {
    ...WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
    modes: [{ id: 'default', contextRequirement: { project: true } }],
  });
  expectRefused(isCanonicalBuiltinCodingTerminalDescriptor, {
    ...WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
    placement: {
      ...WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR.placement,
      preferredRegion: 'primary',
    },
  });
});

test('registers only the code-owned Plan, Readiness, and Trust descriptors', () => {
  for (const [descriptor, isCanonical] of [
    [WORKSPACE_PLAN_PANE_DESCRIPTOR, isCanonicalBuiltinPlanDescriptor],
    [
      WORKSPACE_READINESS_PANE_DESCRIPTOR,
      isCanonicalBuiltinReadinessDescriptor,
    ],
    [WORKSPACE_TRUST_PANE_DESCRIPTOR, isCanonicalBuiltinTrustDescriptor],
  ] as const) {
    expect(isCanonical(descriptor)).toBe(true);
    expect(getBuiltinWorkspacePaneRenderer(descriptor)).toBeTypeOf('function');
    expectRefused(isCanonical, {
      ...descriptor,
      provenance: { origin: 'plugin', pluginId: 'decoy' },
    });
  }
});

test('registers only the package-declared Board descriptor (epic station#4142 M4a)', () => {
  expect(
    isCanonicalBuiltinBoardDescriptor(WORKSPACE_BOARD_PANE_DESCRIPTOR),
  ).toBe(true);
  expect(
    getBuiltinWorkspacePaneRenderer(WORKSPACE_BOARD_PANE_DESCRIPTOR),
  ).toBeTypeOf('function');
  // A plugin cannot reach the built-in Board renderer by reusing its name.
  expect(
    isCanonicalBuiltinBoardDescriptor({
      ...WORKSPACE_BOARD_PANE_DESCRIPTOR,
      provenance: { origin: 'plugin', pluginId: 'decoy' },
    }),
  ).toBe(false);
  expect(
    getBuiltinWorkspacePaneRenderer({
      ...WORKSPACE_BOARD_PANE_DESCRIPTOR,
      provenance: { origin: 'plugin', pluginId: 'decoy' },
    }),
  ).toBeNull();
  // Nor by weakening the Project requirement its one mode declares.
  expect(
    isCanonicalBuiltinBoardDescriptor({
      ...WORKSPACE_BOARD_PANE_DESCRIPTOR,
      modes: [{ id: 'default' }],
    }),
  ).toBe(false);
});

test('registers only the package-declared lazy Basis descriptor', () => {
  expect(
    getBuiltinWorkspacePaneRenderer(WORKSPACE_BASIS_PANE_DESCRIPTOR),
  ).toBeTypeOf('function');
  expect(
    getBuiltinWorkspacePaneRenderer({
      ...WORKSPACE_BASIS_PANE_DESCRIPTOR,
      provenance: { origin: 'plugin', pluginId: 'decoy' },
    }),
  ).toBeNull();
  expect(
    getBuiltinWorkspacePaneRenderer({
      ...WORKSPACE_BASIS_PANE_DESCRIPTOR,
      modes: [{ id: 'answer' }, { id: 'task' }],
    }),
  ).toBeNull();
  expect(
    getBuiltinWorkspacePaneRenderer({
      ...WORKSPACE_BASIS_PANE_DESCRIPTOR,
      placement: { supportedRegions: ['primary'] },
    }),
  ).toBeNull();
});
