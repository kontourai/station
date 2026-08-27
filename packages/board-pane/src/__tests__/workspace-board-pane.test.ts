import { WORKSPACE_ACTIVITY_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-activity-pane';
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
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-file-preview';
import { WORKSPACE_HOME_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-home-pane';
import {
  parseWorkspacePaneDescriptor,
  workspacePaneModesSatisfiableBy,
} from '@kontourai/station-contracts/workspace-pane';
import { workspacePaneHostSuppliableContexts } from '@kontourai/station-contracts/workspace-pane-host';
import { WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-spatial-board';
import {
  WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR,
  WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-task-room';
import { describe, expect, test } from 'vitest';
import {
  createWorkspaceBoardPaneInstance,
  isCanonicalWorkspaceBoardDescriptor,
  isCanonicalWorkspaceBoardPaneInstance,
  WORKSPACE_BOARD_PANE_DESCRIPTOR,
  WORKSPACE_BOARD_PANE_DESCRIPTOR_ID,
  WORKSPACE_BOARD_PANE_RENDERER_NAME,
  WORKSPACE_BOARD_PANE_SOURCE_ID,
} from '../workspace-board-pane';

describe('the Board Workspace Pane declaration', () => {
  test('is a valid, builtin, Project-requiring declaration', () => {
    expect(WORKSPACE_BOARD_PANE_DESCRIPTOR.id).toBe(
      WORKSPACE_BOARD_PANE_DESCRIPTOR_ID,
    );
    expect(WORKSPACE_BOARD_PANE_DESCRIPTOR.renderer).toEqual({
      kind: 'builtin-component',
      name: WORKSPACE_BOARD_PANE_RENDERER_NAME,
    });
    expect(WORKSPACE_BOARD_PANE_DESCRIPTOR.provenance).toEqual({
      origin: 'builtin',
    });
    expect(WORKSPACE_BOARD_PANE_DESCRIPTOR.modes).toEqual([
      { id: 'default', contextRequirement: { project: true } },
    ]);
  });

  test('a Project host scope satisfies the Board mode; an ambient scope does not', () => {
    expect(
      workspacePaneModesSatisfiableBy(
        WORKSPACE_BOARD_PANE_DESCRIPTOR,
        workspacePaneHostSuppliableContexts({
          kind: 'project',
          projectId: 'demo',
          layoutId: 'demo-layout',
        }),
      ).map((mode) => mode.id),
    ).toEqual(['default']);
    // Epic station#4142 M4a acceptance 3: the first explicit NEGATIVE proof
    // of the ambient admission derivation — the Board's declared requirement
    // is what keeps it out of the dock, with no board-specific code anywhere
    // in the admission path.
    expect(
      workspacePaneModesSatisfiableBy(
        WORKSPACE_BOARD_PANE_DESCRIPTOR,
        workspacePaneHostSuppliableContexts({ kind: 'ambient' }),
      ),
    ).toEqual([]);
  });

  test('the ambient dockable set over every builtin declaration plus the Board stays {activity, chat, home}', () => {
    // The same derivation `workspace-pane-modes.test.ts` pins for the
    // contracts-declared builtins, re-run with the Board included: if the
    // Board ever gains a requirement-free mode, this list grows a
    // `pane:builtin:board` entry and the diff names the pane it admits.
    const descriptors = [
      WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
      WORKSPACE_BOARD_PANE_DESCRIPTOR,
      WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
      WORKSPACE_CHAT_PANE_DESCRIPTOR,
      WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
      WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
      WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
      WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
      WORKSPACE_HOME_PANE_DESCRIPTOR,
      WORKSPACE_PLAN_PANE_DESCRIPTOR,
      WORKSPACE_READINESS_PANE_DESCRIPTOR,
      WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR,
      WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR,
      WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
      WORKSPACE_TRUST_PANE_DESCRIPTOR,
    ] as const;
    expect(
      descriptors
        .filter(
          (descriptor) =>
            workspacePaneModesSatisfiableBy(
              descriptor,
              workspacePaneHostSuppliableContexts({ kind: 'ambient' }),
            ).length > 0,
        )
        .map((descriptor) => descriptor.id),
    ).toEqual([
      WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.id,
      WORKSPACE_CHAT_PANE_DESCRIPTOR.id,
      WORKSPACE_HOME_PANE_DESCRIPTOR.id,
    ]);
  });

  test('recognizes its own canonical declaration and refuses a renamed one', () => {
    expect(
      isCanonicalWorkspaceBoardDescriptor(WORKSPACE_BOARD_PANE_DESCRIPTOR),
    ).toBe(true);
    const decoy = parseWorkspacePaneDescriptor({
      version: WORKSPACE_BOARD_PANE_DESCRIPTOR.version,
      id: WORKSPACE_BOARD_PANE_DESCRIPTOR.id,
      name: WORKSPACE_BOARD_PANE_DESCRIPTOR.name,
      description: WORKSPACE_BOARD_PANE_DESCRIPTOR.description,
      rendererId: 'renderer:plugin:decoy',
      renderer: WORKSPACE_BOARD_PANE_DESCRIPTOR.renderer,
      placement: WORKSPACE_BOARD_PANE_DESCRIPTOR.placement,
      modes: WORKSPACE_BOARD_PANE_DESCRIPTOR.modes,
      provenance: { origin: 'builtin' },
      lifecycle: { stage: 'preview' },
    });
    expect(decoy).not.toBeNull();
    expect(isCanonicalWorkspaceBoardDescriptor(decoy!)).toBe(false);
  });
});

describe('the Board Workspace Pane occurrence', () => {
  test('binds exactly one Project and round-trips its own canonical check', () => {
    const instance = createWorkspaceBoardPaneInstance('project-1');
    expect(instance).not.toBeNull();
    expect(instance?.instanceId).toBe('workspace-board:project-1');
    expect(instance?.stateKey).toBe('workspace-board:project-1');
    expect(instance?.boundContext).toEqual({
      projectId: 'project-1',
      sourceId: WORKSPACE_BOARD_PANE_SOURCE_ID,
    });
    expect(isCanonicalWorkspaceBoardPaneInstance(instance!)).toBe(true);
  });

  test('refuses an occurrence missing the Project binding or carrying extra context', () => {
    const instance = createWorkspaceBoardPaneInstance('project-1')!;
    expect(
      isCanonicalWorkspaceBoardPaneInstance({
        ...instance,
        boundContext: { sourceId: WORKSPACE_BOARD_PANE_SOURCE_ID },
      }),
    ).toBe(false);
    expect(
      isCanonicalWorkspaceBoardPaneInstance({
        ...instance,
        boundContext: {
          ...instance.boundContext,
          taskId: 'smuggled',
        },
      }),
    ).toBe(false);
    const other = createWorkspaceBoardPaneInstance('project-2')!;
    expect(
      isCanonicalWorkspaceBoardPaneInstance({
        ...instance,
        instanceId: other.instanceId,
      }),
    ).toBe(false);
  });
});
