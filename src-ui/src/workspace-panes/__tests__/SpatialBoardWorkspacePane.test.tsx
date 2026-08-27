/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWorkspaceSpatialBoardPaneInstance } from '@kontourai/station-contracts/workspace-spatial-board';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const replace = vi.fn();
const remove = vi.fn();
const create = vi.fn();
const undo = vi.fn();
const undoReset = vi.fn();
const setTitle = vi.fn();
const setCamera = vi.fn();
const cleanup = vi.fn();
const refetch = vi.fn();
const resolutionRefetch = vi.fn();
const queryClient = {
  setQueryData: vi.fn(),
  getQueryCache: () => ({ findAll: () => [] }),
};
let resolvedState: { data: { revision: number; pins: unknown[] } };
let replaceError: Error | null = null;
let removeError: Error | null = null;
let createError: Error | null = null;
let undoError: Error | null = null;
let titleError: Error | null = null;
let cameraError: Error | null = null;
let cleanupError: Error | null = null;
let resolvedLoading = false;
let resolvedError = false;
const board = {
  schemaVersion: 2,
  id: 'personal',
  revision: 3,
  title: 'Work Board',
  camera: { x: 0, y: 0, zoom: 1 },
  pins: [
    {
      id: 'pin-session',
      reference: { kind: 'session', id: 'session-1' },
      x: 240,
      y: 20,
      width: 200,
      height: 120,
      order: 1,
    },
    {
      id: 'pin-task',
      reference: { kind: 'task', id: 'task-1', projectId: 'project-a' },
      x: 10,
      y: 20,
      width: 200,
      height: 120,
      order: 0,
    },
  ],
  undo: { title: 'Board', camera: { x: 0, y: 0, zoom: 1 }, pins: [] },
};
const INITIAL_PINS = board.pins;

vi.mock('@kontourai/station-sdk/spatial-board', () => ({
  SpatialBoardRequestError: class SpatialBoardRequestError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string,
    ) {
      super(message);
    }
    get conflict() {
      return this.status === 409 || this.code === 'spatial_board_conflict';
    }
  },
  useSpatialBoardQuery: () => ({
    data: board,
    isLoading: false,
    isError: false,
    refetch,
  }),
  useResolvedSpatialBoardQuery: () => ({
    ...resolvedState,
    isLoading: resolvedLoading,
    isError: resolvedError,
    refetch: resolutionRefetch,
  }),
  useCreateSpatialBoardPinMutation: () => ({
    mutate: create,
    isPending: false,
    error: createError,
  }),
  useReplaceSpatialBoardPinMutation: () => ({
    mutate: replace,
    isPending: false,
    error: replaceError,
  }),
  useRemoveSpatialBoardPinMutation: () => ({
    mutate: remove,
    isPending: false,
    error: removeError,
  }),
  useUndoSpatialBoardMutation: () => ({
    mutate: undo,
    reset: undoReset,
    isPending: false,
    error: undoError,
  }),
  useSetSpatialBoardTitleMutation: () => ({
    mutate: setTitle,
    isPending: false,
    error: titleError,
  }),
  useSetSpatialBoardCameraMutation: () => ({
    mutate: setCamera,
    isPending: false,
    error: cameraError,
  }),
  useCleanupSpatialBoardPinsMutation: () => ({
    mutate: cleanup,
    isPending: false,
    error: cleanupError,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => queryClient,
}));

import { WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-spatial-board';
import { workBoardPerformanceDriver } from '../../performance/work-board-performance-bridge';
import { SpatialBoardWorkspacePane } from '../SpatialBoardWorkspacePane';

describe('SpatialBoardWorkspacePane', () => {
  beforeEach(() => {
    replace.mockReset();
    remove.mockReset();
    create.mockReset();
    undo.mockReset();
    undoReset.mockReset();
    setTitle.mockReset();
    setCamera.mockReset();
    cleanup.mockReset();
    refetch.mockReset();
    resolutionRefetch.mockReset();
    refetch.mockResolvedValue({ status: 'success', data: board });
    replaceError = null;
    removeError = null;
    createError = null;
    undoError = null;
    titleError = null;
    cameraError = null;
    cleanupError = null;
    resolvedLoading = false;
    resolvedError = false;
    board.title = 'Work Board';
    board.revision = 3;
    board.camera = { x: 0, y: 0, zoom: 1 };
    board.pins = INITIAL_PINS;
    resolvedState = {
      data: {
        revision: 3,
        pins: [
          {
            pinId: 'pin-session',
            reference: { kind: 'session', id: 'session-1' },
            state: 'current',
            title: 'Release session',
          },
          {
            pinId: 'pin-task',
            reference: { kind: 'task', id: 'task-1', projectId: 'project-a' },
            state: 'stale',
          },
        ],
      },
    };
  });

  test('renders current owner facts and honest stale state', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    expect(screen.getAllByText('task project-a/task-1')).toHaveLength(4);
    // station#3965: the chip reads as words now; the state still drives the
    // class, so the styling contract is unchanged.
    expect(screen.getAllByText('Moved')).toHaveLength(2);
    expect(screen.getAllByText('Release session')).toHaveLength(2);
    expect(screen.getAllByText('Linked')).toHaveLength(2);
    expect(
      screen.getByRole('list', { name: 'Pinned work in order' }),
    ).toBeTruthy();
  });

  test('separates resolution loading and failure from an unconfirmed pin', () => {
    resolvedLoading = true;
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    const view = render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    expect(screen.getByText('Resolving pinned work…')).toBeTruthy();
    resolvedLoading = false;
    resolvedError = true;
    view.rerender(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Couldn’t resolve pinned work',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry resolution' }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(resolutionRefetch).toHaveBeenCalledTimes(1);
  });

  test('makes an empty board actionable and focuses disclosed pin controls', () => {
    board.pins = [];
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add a pin' }));
    expect(document.querySelector('details')?.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByLabelText('Reference kind'),
    );
  });

  test('does not mount performance hooks or marker attributes in an ordinary build', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    expect(workBoardPerformanceDriver()).toBeUndefined();
    expect(
      document.querySelectorAll('[data-station-work-board-listener]'),
    ).toHaveLength(0);
  });

  test('keyboard movement and resize use the exact current revision', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const mover = screen.getByRole('button', {
      name: /task project-a\/task-1.*Arrow keys move/i,
    });
    fireEvent.keyDown(mover, { key: 'ArrowRight' });
    expect(replace).toHaveBeenLastCalledWith({
      expectedRevision: 3,
      pin: expect.objectContaining({ id: 'pin-task', x: 20, width: 200 }),
    });
    fireEvent.keyDown(mover, { key: 'ArrowDown', shiftKey: true });
    expect(replace).toHaveBeenLastCalledWith({
      expectedRevision: 3,
      pin: expect.objectContaining({ id: 'pin-task', height: 240 }),
    });
  });

  test('pins exact user-entered Session identity', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    fireEvent.change(screen.getByLabelText('Reference kind'), {
      target: { value: 'session' },
    });
    fireEvent.change(screen.getByLabelText('Exact reference ID'), {
      target: { value: 'session-new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pin work' }));
    expect(create).toHaveBeenCalledWith(
      {
        expectedRevision: 3,
        pin: expect.objectContaining({
          reference: { kind: 'session', id: 'session-new' },
        }),
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  test('pins a Task only with its exact canonical Project slug', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-uuid-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    fireEvent.change(screen.getByLabelText('Exact reference ID'), {
      target: { value: 'task-current' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pin work' }));
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Exact Task Project slug'), {
      target: { value: 'station-berd-dogfood' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pin work' }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        pin: expect.objectContaining({
          reference: {
            kind: 'task',
            id: 'task-current',
            projectId: 'station-berd-dogfood',
          },
        }),
      }),
      expect.anything(),
    );
  });

  test('pins an exact Flow run with optional exact gate identity', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    fireEvent.change(screen.getByLabelText('Reference kind'), {
      target: { value: 'flow-run' },
    });
    fireEvent.change(screen.getByLabelText('Exact reference ID'), {
      target: { value: 'run-1' },
    });
    fireEvent.change(screen.getByLabelText('Exact Project ID'), {
      target: { value: 'project-a' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pin work' }));
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pin: expect.objectContaining({
          reference: {
            kind: 'run',
            owner: 'flow',
            id: 'run-1',
            projectId: 'project-a',
          },
        }),
      }),
      expect.anything(),
    );
    fireEvent.change(screen.getByLabelText('Exact gate ID (optional)'), {
      target: { value: 'gate-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pin work' }));
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pin: expect.objectContaining({
          reference: {
            kind: 'run',
            owner: 'flow',
            id: 'run-1',
            projectId: 'project-a',
            gateId: 'gate-1',
          },
        }),
      }),
      expect.anything(),
    );
  });

  test('offers every supported owner kind without copying owner facts', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const options = within(
      screen.getByLabelText('Reference kind'),
    ).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Task',
      'Session',
      'Project',
      'Approval request',
      'Scheduled outcome',
      'Receipt',
      'Gate or run',
      'Artifact',
      'Agent',
    ]);
  });

  test('classifies an exact missing Task and keeps its full owner identity', () => {
    resolvedState = {
      data: {
        revision: 3,
        pins: [
          {
            pinId: 'pin-task',
            reference: { kind: 'task', id: 'task-1', projectId: 'project-a' },
            state: 'missing',
          },
        ],
      },
    };
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    expect(screen.getAllByText('Not found')).toHaveLength(2);
    expect(screen.getAllByText('task project-a/task-1')).toHaveLength(4);
  });

  test('keeps pointer movement local until pointer-up, then writes exactly once', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const mover = screen.getByRole('button', {
      name: /Move task project-a\/task-1.*Arrow keys move/i,
    });
    const card = mover.closest('article');
    expect(card?.style.width).toBe('200px');
    expect(card?.style.height).toBe('240px');
    expect(card?.style.minHeight).toBe('');
    fireEvent.pointerDown(mover, {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(mover, { pointerId: 1, clientX: 30, clientY: 40 });
    expect(replace).not.toHaveBeenCalled();
    fireEvent.pointerUp(mover, { pointerId: 1, clientX: 30, clientY: 40 });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenLastCalledWith({
      expectedRevision: 3,
      pin: expect.objectContaining({ id: 'pin-task', x: 30, y: 50 }),
    });
  });

  test('raises the focused interaction card without persisting a z-order change', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const mover = screen.getByRole('button', {
      name: /Move task project-a\/task-1.*Arrow keys move/i,
    });
    fireEvent.focus(mover);
    expect(mover.closest('article')?.style.zIndex).toBe('10000');
    expect(replace).not.toHaveBeenCalled();
  });

  test('raises a pointer-active card before focus and restores its transient order on release', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const mover = screen.getByRole('button', {
      name: /Move task project-a\/task-1.*Arrow keys move/i,
    });
    const card = mover.closest('article');
    fireEvent.pointerDown(mover, {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    expect(card?.style.zIndex).toBe('10000');
    fireEvent.pointerUp(mover, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(card?.style.zIndex).toBe('1');
    expect(replace).not.toHaveBeenCalled();
  });

  test('converts pointer geometry from zoomed screen space and cancels without a write', () => {
    board.camera = { x: 0, y: 0, zoom: 2 };
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const mover = screen.getByRole('button', {
      name: /Move task project-a\/task-1.*Arrow keys move/i,
    });
    fireEvent.pointerDown(mover, {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(mover, { pointerId: 1, clientX: 30, clientY: 50 });
    fireEvent.pointerUp(mover, { pointerId: 1, clientX: 30, clientY: 50 });
    expect(replace).toHaveBeenLastCalledWith({
      expectedRevision: 3,
      pin: expect.objectContaining({ x: 20, y: 40 }),
    });
    replace.mockReset();
    const resize = screen.getByRole('button', {
      name: 'Resize task project-a/task-1',
    });
    fireEvent.pointerDown(resize, {
      pointerId: 2,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(resize, { pointerId: 2, clientX: 50, clientY: 70 });
    fireEvent.pointerUp(resize, { pointerId: 2, clientX: 50, clientY: 70 });
    expect(replace).toHaveBeenLastCalledWith({
      expectedRevision: 3,
      pin: expect.objectContaining({ width: 220, height: 240 }),
    });
    replace.mockReset();
    fireEvent.pointerDown(mover, {
      pointerId: 3,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(mover, { pointerId: 3, clientX: 30, clientY: 50 });
    fireEvent.pointerCancel(mover, { pointerId: 3 });
    expect(replace).not.toHaveBeenCalled();
  });

  test('commits the latest canvas-pan preview once and cancels it without writing', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const canvas = screen.getByRole('region', { name: 'Spatial canvas' });
    const plane = canvas.querySelector('.spatial-board__plane');
    if (!plane) throw new Error('expected materialised board plane');
    fireEvent.pointerDown(plane, {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(plane, { pointerId: 1, clientX: 40, clientY: 60 });
    fireEvent.pointerUp(plane, { pointerId: 1, clientX: 40, clientY: 60 });
    expect(setCamera).toHaveBeenLastCalledWith({
      expectedRevision: 3,
      camera: { x: 30, y: 50, zoom: 1 },
    });
    setCamera.mockReset();
    fireEvent.pointerDown(plane, {
      pointerId: 2,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(plane, { pointerId: 2, clientX: 40, clientY: 60 });
    fireEvent.pointerCancel(plane, { pointerId: 2 });
    expect(setCamera).not.toHaveBeenCalled();
  });

  test('persists title, camera, and undo at the displayed revision', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    fireEvent.change(screen.getByLabelText('Board title'), {
      target: { value: 'My board' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save title' }));
    expect(setTitle).toHaveBeenCalledWith({
      expectedRevision: 3,
      title: 'My board',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(setCamera).toHaveBeenCalledWith({
      expectedRevision: 3,
      camera: { x: 0, y: 0, zoom: 1.25 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledWith({ expectedRevision: 3 });
  });

  test('keeps a title draft through the save button blur before submitting it', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const input = screen.getByLabelText('Board title');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Blur-safe Work Board' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Save title' }));
    expect(setTitle).toHaveBeenCalledWith({
      expectedRevision: 3,
      title: 'Blur-safe Work Board',
    });
  });

  test('restores a re-observed title without overwriting an active edit', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    const view = render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    board.title = 'Restored Board';
    board.revision = 4;
    view.rerender(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    expect(
      (screen.getByLabelText('Board title') as HTMLInputElement).value,
    ).toBe('Restored Board');
    fireEvent.focus(screen.getByLabelText('Board title'));
    fireEvent.change(screen.getByLabelText('Board title'), {
      target: { value: 'Draft title' },
    });
    board.title = 'Remote Board';
    view.rerender(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    expect(
      (screen.getByLabelText('Board title') as HTMLInputElement).value,
    ).toBe('Draft title');
  });

  test('orders both focus models by pin order and makes the fallback actionable', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const canvas = screen.getByRole('region', { name: 'Spatial canvas' });
    expect(
      within(canvas).getAllByRole('button')[0]?.getAttribute('aria-label'),
    ).toMatch(/task project-a\/task-1.*Arrow keys move/i);
    const ordered = screen.getByRole('list', { name: 'Pinned work in order' });
    const fallbackActions = within(ordered).getAllByRole('button');
    expect(fallbackActions[0]?.getAttribute('aria-label')).toBe(
      'Remove task project-a/task-1 from ordered list',
    );
    fireEvent.click(fallbackActions[0]);
    expect(remove).toHaveBeenLastCalledWith({
      expectedRevision: 3,
      pinId: 'pin-task',
    });
  });

  test('surfaces an ordered-list removal conflict inside the fallback', () => {
    removeError = new Error('conflict');
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const ordered = screen.getByRole('list', { name: 'Pinned work in order' });
    expect(within(ordered).getAllByRole('alert')).toHaveLength(2);
    for (const alert of within(ordered).getAllByRole('alert'))
      expect(alert.textContent).toMatch(
        /Refresh the Board before trying again/,
      );
  });

  test('uses a container-scoped list-first compact fallback without animation', () => {
    const css = readFileSync(
      resolve(
        process.cwd(),
        'src-ui/src/workspace-panes/SpatialBoardWorkspacePane.css',
      ),
      'utf8',
    );
    expect(css).toContain('.spatial-board__ordered');
    expect(css).toContain('display: grid');
    expect(css).not.toContain('transition:');
    expect(css).toContain('container-type: inline-size');
    expect(css).toContain('@container (max-width: 42rem)');
    expect(css).toContain('grid-template-areas: "list" "toggle" "canvas"');
    expect(css).toContain('[data-canvas-visible="true"]');
    expect(css).toContain('flex-direction: column');
  });

  test('surfaces revision conflicts for every non-pin mutation seam', () => {
    titleError = new Error('conflict');
    cameraError = new Error('conflict');
    cleanupError = new Error('conflict');
    createError = new Error('conflict');
    undoError = new Error('conflict');
    resolvedState = {
      data: {
        revision: 3,
        pins: [
          {
            pinId: 'pin-task',
            reference: {
              kind: 'task',
              id: 'task-1',
              projectId: 'project-a',
            },
            state: 'missing',
          },
        ],
      },
    };
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    if (!instance) throw new Error('expected board instance');
    render(
      <SpatialBoardWorkspacePane
        descriptor={WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(6);
    for (const alert of alerts)
      expect(alert.textContent).toMatch(
        /Refresh the Board before trying again/,
      );
  });
});
