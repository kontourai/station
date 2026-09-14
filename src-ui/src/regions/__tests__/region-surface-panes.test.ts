// @vitest-environment node

import { WORKSPACE_ACTIVITY_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-activity-pane';
import { WORKSPACE_AGENTS_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-agents-pane';
import { WORKSPACE_CHAT_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-chat-pane';
import {
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-file-preview';
import {
  parseWorkspacePaneInstance,
  type WorkspacePaneDescriptor,
} from '@kontourai/station-contracts/workspace-pane';
import {
  WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR,
  WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-task-room';
import { describe, expect, test } from 'vitest';
import { DOCK_REGION_IDS, REGION_SURFACE_REGISTRY } from '../region-model';
import {
  DOCK_HOST_SUPPLIABLE_CONTEXTS,
  dockCanSupply,
  REGION_SURFACE_PANES,
  regionSurfaceOfDescriptor,
  regionSurfaceOfPane,
  regionSurfacePane,
} from '../region-surface-panes';

const PROJECT = { projectId: 'project-uuid', projectSlug: 'alpha' };
const NO_PROJECT = { projectId: null, projectSlug: null };

/** The descriptor each entry is an occurrence of, by surface id. */
const ENTRY_DESCRIPTORS: Record<string, WorkspacePaneDescriptor> = {
  chat: WORKSPACE_CHAT_PANE_DESCRIPTOR,
  activity: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  // #2050: this conversation's background work, beside the conversation.
  'workspace-agents': WORKSPACE_AGENTS_PANE_DESCRIPTOR,
  'coding:terminal': WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
  'coding:diff': WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  'coding:file-browser': WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
};

/**
 * #2045: the inventory is the join between region surfaces and the panes a
 * region host renders them as. Pinned in both directions to the registry's
 * dock-capable surfaces, so a surface that gains a dock placement without a
 * pane (the toolbar would offer a region that renders nothing) and a pane
 * for a surface that declares no dock region (a label no host reads) both
 * fail here rather than at a user's click. #2047: the coding panes join,
 * bound to the dock's project through the entry's factory.
 */
describe('region surface panes (#2045, #2047)', () => {
  test('exactly the surfaces declaring a dock region have a pane', () => {
    const dockCapable = [...REGION_SURFACE_REGISTRY.values()]
      .filter((surface) =>
        surface.regions.some((region) =>
          (DOCK_REGION_IDS as readonly string[]).includes(region),
        ),
      )
      .map((surface) => surface.id)
      .sort();
    expect(dockCapable).toEqual([
      'activity',
      'chat',
      'coding:diff',
      'coding:file-browser',
      'coding:terminal',
      'workspace-agents',
    ]);
    expect([...REGION_SURFACE_PANES.keys()].sort()).toEqual(dockCapable);
  });

  test("each entry's instance under a project is canonical by its own predicate, carries the entry's ids and resolves back to its surface", () => {
    for (const [surfaceId, pane] of REGION_SURFACE_PANES) {
      const instance = pane.instance(PROJECT);
      expect(instance, surfaceId).not.toBeNull();
      if (!instance) continue;
      expect(pane.surfaceId).toBe(surfaceId);
      expect(instance.descriptorId, surfaceId).toBe(pane.descriptorId);
      expect(instance.instanceId, surfaceId).toBe(pane.instanceId);
      expect(pane.isCanonical(instance), surfaceId).toBe(true);
      expect(regionSurfaceOfPane(instance)).toBe(surfaceId);
      expect(regionSurfacePane(surfaceId)).toBe(pane);
      expect(regionSurfaceOfDescriptor(pane.descriptorId)).toBe(surfaceId);
      expect(ENTRY_DESCRIPTORS[surfaceId]?.id, surfaceId).toBe(
        pane.descriptorId,
      );
    }
  });

  /**
   * Reverting `codingPane`'s null-without-project guard (calling `create('')`)
   * fails the first loop: the contract refuses an empty project id with
   * null, so it would pass by accident — which is why the coding factories
   * are ALSO asserted to bind exactly the project they were given, and no
   * layout (#2047 D5: a docked coding pane is the project's).
   */
  test('the coding panes have no instance without a project and bind exactly the given project with no layout; Chat and Activity ignore the context', () => {
    for (const surfaceId of [
      'coding:terminal',
      'coding:diff',
      'coding:file-browser',
    ]) {
      const pane = regionSurfacePane(surfaceId);
      expect(pane?.instance(NO_PROJECT), surfaceId).toBeNull();
      const bound = pane?.instance(PROJECT);
      expect(bound?.boundContext?.projectId, surfaceId).toBe('project-uuid');
      expect(bound?.boundContext?.layoutId, surfaceId).toBeUndefined();
      // A different project is a different occurrence under the same ids.
      const other = pane?.instance({
        projectId: 'other-project',
        projectSlug: 'beta',
      });
      expect(other?.instanceId).toBe(bound?.instanceId);
      expect(other?.boundContext?.projectId).toBe('other-project');
    }
    for (const surfaceId of ['chat', 'activity', 'workspace-agents']) {
      const pane = regionSurfacePane(surfaceId);
      expect(pane?.instance(NO_PROJECT), surfaceId).toBe(
        pane?.instance(PROJECT),
      );
      expect(pane?.instance(PROJECT)?.boundContext?.projectId).toBeUndefined();
    }
  });

  /**
   * The dock's suppliable set is both the catalog filter and what every
   * entry's descriptor must satisfy — one constant, so the two cannot
   * disagree. Adding `task` to the set makes the task-room assertions fail;
   * removing `source` or `workspace` makes every coding entry fail.
   */
  test('the dock supplies project, source and workspace, which every entry needs and the task-room panes exceed', () => {
    expect([...DOCK_HOST_SUPPLIABLE_CONTEXTS].sort()).toEqual([
      'project',
      'source',
      'workspace',
    ]);
    for (const [surfaceId, pane] of REGION_SURFACE_PANES) {
      const descriptor = ENTRY_DESCRIPTORS[surfaceId];
      expect(descriptor, surfaceId).toBeDefined();
      if (!descriptor) continue;
      expect(descriptor.id).toBe(pane.descriptorId);
      expect(dockCanSupply(descriptor), surfaceId).toBe(true);
    }
    expect(dockCanSupply(WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR)).toBe(false);
    expect(dockCanSupply(WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR)).toBe(false);
    // Suppliable is not the same as placeable: a File Preview's context the
    // dock could supply, but it has no surface (no blank canonical instance).
    expect(dockCanSupply(WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR)).toBe(true);
    expect(
      regionSurfaceOfDescriptor(WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR.id),
    ).toBeNull();
  });

  test('a same-shaped impostor and a pane no surface owns resolve to no surface', () => {
    const impostorActivity = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'pane:builtin:activity',
      instanceId: 'workspace-activity-impostor',
      stateKey: 'workspace-activity-impostor',
      boundContext: { sourceId: 'builtin:workspace-activity' },
    });
    const home = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'pane:builtin:home',
      instanceId: 'workspace-home',
      stateKey: 'workspace-home',
      boundContext: { sourceId: 'builtin:workspace-home' },
    });
    const impostorTerminal = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'pane:builtin:coding:terminal',
      instanceId: 'workspace-coding-terminal-2',
      stateKey: 'workspace-coding-terminal-2',
      boundContext: {
        projectId: 'project-uuid',
        sourceId: 'builtin:workspace-coding-terminal',
      },
    });
    if (!impostorActivity || !home || !impostorTerminal)
      throw new Error('fixtures must parse');
    expect(regionSurfaceOfPane(impostorActivity)).toBeNull();
    expect(regionSurfaceOfPane(home)).toBeNull();
    expect(regionSurfaceOfPane(impostorTerminal)).toBeNull();
    expect(regionSurfacePane('home')).toBeUndefined();
    expect(regionSurfaceOfDescriptor('pane:builtin:home')).toBeNull();
  });
});
