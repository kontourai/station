import { describe, expect, test } from 'vitest';
import {
  createWorkspaceLayoutPaneInstance,
  isCanonicalWorkspaceLayoutPaneInstance,
  parseWorkspaceLayoutPaneId,
  WORKSPACE_LAYOUT_PANE_DESCRIPTOR,
  WORKSPACE_LAYOUT_PANE_RENDERER_NAME,
  WORKSPACE_LAYOUT_PANE_SOURCE_ID,
  workspaceLayoutPaneId,
} from '../workspace-layout-pane.js';
import { parseWorkspacePaneInstance } from '../workspace-pane.js';
import { BUILTIN_WORKSPACE_PANE_RENDERER_NAMES } from '../workspace-pane-builtin-renderers.js';

const LAYOUT = '1d61ce22-7f4b-4282-86f0-019ef1bc223c';
const PROJECT = 'f2e27d8e-dd81-4fe3-9d6e-9de369389b01';
const BOARD_ID = `board:${LAYOUT}`;
const LAYOUT_ID = `layout:${PROJECT}/${LAYOUT}`;

describe('the Layout pane descriptor (#2157)', () => {
  /**
   * Reverting `supportedRegions` to anything but exactly `['docked']` reds
   * the first assertion; giving the one mode a `contextRequirement` reds the
   * third — a Board has no project, so requiring one would refuse it.
   */
  test('is a dock-only, requirement-free built-in with a registered renderer name', () => {
    expect(WORKSPACE_LAYOUT_PANE_DESCRIPTOR.placement.supportedRegions).toEqual(
      ['docked'],
    );
    expect(WORKSPACE_LAYOUT_PANE_DESCRIPTOR.id).toBe(
      'pane:builtin:workspace-layout',
    );
    expect(WORKSPACE_LAYOUT_PANE_DESCRIPTOR.modes).toEqual([{ id: 'default' }]);
    expect(WORKSPACE_LAYOUT_PANE_DESCRIPTOR.renderer).toEqual({
      kind: 'builtin-component',
      name: WORKSPACE_LAYOUT_PANE_RENDERER_NAME,
    });
    expect(
      BUILTIN_WORKSPACE_PANE_RENDERER_NAMES as readonly string[],
    ).toContain(WORKSPACE_LAYOUT_PANE_RENDERER_NAME);
  });
});

describe('the Layout pane id grammar (#2157)', () => {
  test('mints board:<layoutId> and layout:<projectId>/<layoutId> from the server-shaped ids', () => {
    expect(workspaceLayoutPaneId({ kind: 'board', layoutId: LAYOUT })).toBe(
      BOARD_ID,
    );
    expect(
      workspaceLayoutPaneId({
        kind: 'project',
        projectId: PROJECT,
        layoutId: LAYOUT,
      }),
    ).toBe(LAYOUT_ID);
    expect(parseWorkspaceLayoutPaneId(BOARD_ID)).toEqual({
      kind: 'board',
      layoutId: LAYOUT,
    });
    expect(parseWorkspaceLayoutPaneId(LAYOUT_ID)).toEqual({
      kind: 'project',
      projectId: PROJECT,
      layoutId: LAYOUT,
    });
  });

  /**
   * The id is the pane's identity in `RegionState.panes`, which
   * `regionStatesEqual` joins on a comma, and it is read back from a stored
   * record — so the grammar admits exactly the shape the server mints and
   * nothing that merely starts the same way. Each refused row names a way to
   * be wrong; loosening the UUID rule to `[^/]+` reds the comma, slug and
   * uppercase rows.
   */
  test.each([
    ['board:', 'a bare prefix'],
    ['layout:', 'a bare prefix'],
    [`layout:${LAYOUT}`, 'a project Layout with no project'],
    [`layout:${PROJECT}/`, 'a project with no layout'],
    [`layout:${PROJECT}/${LAYOUT}/extra`, 'a third segment'],
    [`board:${LAYOUT},${LAYOUT}`, 'a comma'],
    ['board:coding', 'a slug rather than an id'],
    [`board:${LAYOUT.toUpperCase()}`, 'an uppercase spelling'],
    [`board:${LAYOUT.slice(0, -1)}`, 'one hex digit short'],
    [`board:${LAYOUT}0`, 'one hex digit long'],
    [`pr:${LAYOUT}`, 'another family'],
    [`layout:${PROJECT}/${LAYOUT}#1`, 'a trailing fragment'],
  ])('refuses %s (%s)', (id) => {
    expect(parseWorkspaceLayoutPaneId(id)).toBeNull();
  });

  test('refuses to mint an id from a part that is not a UUID, so no id carries a comma', () => {
    expect(
      workspaceLayoutPaneId({ kind: 'board', layoutId: 'a,b' }),
    ).toBeNull();
    expect(
      workspaceLayoutPaneId({
        kind: 'project',
        projectId: 'hand-written',
        layoutId: LAYOUT,
      }),
    ).toBeNull();
    expect(
      workspaceLayoutPaneId({ kind: 'board', layoutId: LAYOUT.toUpperCase() }),
    ).toBeNull();
  });
});

describe('the Layout pane occurrence (#2157)', () => {
  test('a Board binds no project; a project Layout binds the project its id names', () => {
    const board = createWorkspaceLayoutPaneInstance({
      kind: 'board',
      layoutId: LAYOUT,
    });
    expect(board).not.toBeNull();
    expect(String(board?.instanceId)).toBe(BOARD_ID);
    expect(String(board?.stateKey)).toBe(BOARD_ID);
    expect(board?.boundContext).toEqual({
      sourceId: WORKSPACE_LAYOUT_PANE_SOURCE_ID,
    });
    const layout = createWorkspaceLayoutPaneInstance({
      kind: 'project',
      projectId: PROJECT,
      layoutId: LAYOUT,
    });
    expect(String(layout?.instanceId)).toBe(LAYOUT_ID);
    expect(layout?.boundContext).toEqual({
      projectId: PROJECT,
      sourceId: WORKSPACE_LAYOUT_PANE_SOURCE_ID,
    });
    expect(
      createWorkspaceLayoutPaneInstance({ kind: 'board', layoutId: 'x' }),
    ).toBeNull();
    for (const instance of [board, layout]) {
      if (!instance) throw new Error('the occurrence must mint');
      expect(isCanonicalWorkspaceLayoutPaneInstance(instance)).toBe(true);
    }
  });

  /**
   * Each impostor differs from the minted occurrence in one field; the
   * canonical check refuses all of them. Dropping the `projectId` equality
   * reds the "another project" row, and dropping the key-count check reds
   * the "extra binding" row.
   */
  test.each([
    [
      'a state key that is not the id',
      {
        descriptorId: 'pane:builtin:workspace-layout',
        instanceId: BOARD_ID,
        stateKey: 'other',
        boundContext: { sourceId: WORKSPACE_LAYOUT_PANE_SOURCE_ID },
      },
    ],
    [
      'a Board that binds a project',
      {
        descriptorId: 'pane:builtin:workspace-layout',
        instanceId: BOARD_ID,
        stateKey: BOARD_ID,
        boundContext: {
          projectId: PROJECT,
          sourceId: WORKSPACE_LAYOUT_PANE_SOURCE_ID,
        },
      },
    ],
    [
      'a project Layout bound to another project',
      {
        descriptorId: 'pane:builtin:workspace-layout',
        instanceId: LAYOUT_ID,
        stateKey: LAYOUT_ID,
        boundContext: {
          projectId: '00000000-0000-0000-0000-000000000000',
          sourceId: WORKSPACE_LAYOUT_PANE_SOURCE_ID,
        },
      },
    ],
    [
      'a project Layout with no project binding',
      {
        descriptorId: 'pane:builtin:workspace-layout',
        instanceId: LAYOUT_ID,
        stateKey: LAYOUT_ID,
        boundContext: { sourceId: WORKSPACE_LAYOUT_PANE_SOURCE_ID },
      },
    ],
    [
      'an extra binding',
      {
        descriptorId: 'pane:builtin:workspace-layout',
        instanceId: LAYOUT_ID,
        stateKey: LAYOUT_ID,
        boundContext: {
          projectId: PROJECT,
          layoutId: LAYOUT,
          sourceId: WORKSPACE_LAYOUT_PANE_SOURCE_ID,
        },
      },
    ],
    [
      'another source',
      {
        descriptorId: 'pane:builtin:workspace-layout',
        instanceId: BOARD_ID,
        stateKey: BOARD_ID,
        boundContext: { sourceId: 'builtin:board' },
      },
    ],
    [
      'another descriptor',
      {
        descriptorId: 'pane:builtin:board',
        instanceId: BOARD_ID,
        stateKey: BOARD_ID,
        boundContext: { sourceId: WORKSPACE_LAYOUT_PANE_SOURCE_ID },
      },
    ],
  ])('refuses %s', (_label, candidate) => {
    const impostor = parseWorkspacePaneInstance({
      version: '1.0',
      ...candidate,
    });
    if (!impostor) throw new Error('fixture must parse');
    expect(isCanonicalWorkspaceLayoutPaneInstance(impostor)).toBe(false);
  });
});
