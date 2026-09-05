/** @vitest-environment jsdom */

import type { ProjectTaskRoomBrowserLiveSnapshot } from '@kontourai/station-contracts/project-task-room-browser';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  restart: vi.fn(),
  streamGeneration: 0,
  stream: undefined as
    | {
        onRoom?(value: ProjectTaskRoomBrowserLiveSnapshot): void;
        onDocument?(value: unknown): void;
        onAuthoritativeDocument?(value: {
          kind: 'snapshot' | 'delta';
          revision: string;
          text: string;
        }): void;
        onTerminal?(): void;
      }
    | undefined,
}));
vi.mock('@kontourai/station-sdk/project-task-rooms', () => ({
  parseProjectTaskRoomDocumentResponse: (value: unknown) => value,
  useProjectTaskRoomDiscoveryQuery: () => ({
    data: { kind: 'existing', capabilities: { live: true } },
  }),
  useCommandProjectTaskRoomLiveMutation: () => ({
    mutateAsync: mocks.command,
    isPending: false,
  }),
  useProjectTaskRoomStream: (
    _taskId: string,
    callbacks: NonNullable<typeof mocks.stream>,
    connectionGeneration = 0,
  ) => {
    mocks.stream = callbacks;
    mocks.streamGeneration = connectionGeneration;
    return mocks.restart;
  },
}));

import {
  INTERACTIVE_WORKSPACE_STREAM_RESTART_EVENT,
  subscribeInteractiveWorkspacePerformanceMarks,
} from '../performance/interactive-workspace-performance-hooks';
import {
  ProjectTaskRoomProvider,
  useProjectTaskRoomContext,
} from '../workspace-panes/ProjectTaskRoomContext';

function snapshot(
  label: string,
  generation = 'generation-1',
): ProjectTaskRoomBrowserLiveSnapshot {
  return {
    generation,
    viewerActorId: 'actor-self',
    scope: { projectId: 'project-1', taskId: 'task-1' },
    state: 'active',
    participants: [
      {
        actor: { actorId: `actor-${label}`, kind: 'human', label },
        work: {
          sessionId: generation,
          workName: 'Project task work',
          workState: 'working',
          startedAt: 1,
        },
        publication: 'published',
      },
    ],
    panes: [],
    cursors: [],
    result: { outcome: 'updated' },
  };
}

function Consumer() {
  const room = useProjectTaskRoomContext('task-1');
  return (
    <div>
      <span>{room?.stream}</span>
      <span>{room?.ownActorId}</span>
      <span>{room?.live?.participants[0]?.actor.label ?? 'no-live'}</span>
      <button
        type="button"
        onClick={() => void room?.command({ command: 'join' })}
      >
        Command
      </button>
    </div>
  );
}

function DocumentConsumer() {
  const room = useProjectTaskRoomContext('task-1');
  const [revision, setRevision] = useState('none');
  useLayoutEffect(
    () => room?.subscribeDocument((document) => setRevision(document.revision)),
    [room],
  );
  return <span>{revision}</span>;
}

function ThrowingDocumentConsumer() {
  const room = useProjectTaskRoomContext('task-1');
  useLayoutEffect(
    () =>
      room?.subscribeDocument(() => {
        throw new Error('pane observer failed');
      }),
    [room],
  );
  return null;
}

beforeEach(() => {
  mocks.command.mockReset();
  mocks.restart.mockReset();
  mocks.stream = undefined;
  mocks.streamGeneration = 0;
});

test('restarts the diagnostic stream without a participant and unmount wins', () => {
  const view = render(
    <ProjectTaskRoomProvider taskId="task-1">
      <Consumer />
    </ProjectTaskRoomProvider>,
  );
  act(() =>
    window.dispatchEvent(
      new CustomEvent(INTERACTIVE_WORKSPACE_STREAM_RESTART_EVENT, {
        detail: 'task-1',
      }),
    ),
  );
  expect(mocks.restart).toHaveBeenCalledOnce();
  view.unmount();
  window.dispatchEvent(
    new CustomEvent(INTERACTIVE_WORKSPACE_STREAM_RESTART_EVENT, {
      detail: 'task-1',
    }),
  );
  expect(mocks.restart).toHaveBeenCalledOnce();
});
afterEach(() => vi.useRealTimers());

test('takes viewer identity from the server even when the participant is already published', () => {
  render(
    <ProjectTaskRoomProvider taskId="task-1">
      <Consumer />
    </ProjectTaskRoomProvider>,
  );
  act(() => mocks.stream?.onRoom?.(snapshot('self')));
  expect(screen.getByText('actor-self')).toBeTruthy();
  expect(screen.getByText('self')).toBeTruthy();
});

test('forwards parsed documents synchronously while the stream is current', () => {
  render(
    <ProjectTaskRoomProvider taskId="task-1">
      <DocumentConsumer />
    </ProjectTaskRoomProvider>,
  );

  act(() =>
    mocks.stream?.onAuthoritativeDocument?.({
      kind: 'delta',
      revision: 'revision-2',
      text: 'two',
    }),
  );
  expect(screen.getByText('revision-2')).toBeTruthy();
  act(() => mocks.stream?.onTerminal?.());
  act(() =>
    mocks.stream?.onAuthoritativeDocument?.({
      kind: 'delta',
      revision: 'revision-3',
      text: 'three',
    }),
  );
  expect(screen.getByText('revision-2')).toBeTruthy();
});

test('isolates a throwing document listener from sibling panes', () => {
  render(
    <ProjectTaskRoomProvider taskId="task-1">
      <ThrowingDocumentConsumer />
      <DocumentConsumer />
    </ProjectTaskRoomProvider>,
  );

  expect(() =>
    act(() =>
      mocks.stream?.onAuthoritativeDocument?.({
        kind: 'delta',
        revision: 'revision-2',
        text: 'two',
      }),
    ),
  ).not.toThrow();
  expect(screen.getByText('revision-2')).toBeTruthy();
});

test('heartbeats a joined viewer beyond the production live TTL', async () => {
  vi.useFakeTimers();
  mocks.command.mockResolvedValue({
    kind: 'available',
    generation: 'generation-1',
    snapshot: snapshot('self'),
  });
  render(
    <ProjectTaskRoomProvider taskId="task-1">
      <Consumer />
    </ProjectTaskRoomProvider>,
  );
  act(() => mocks.stream?.onRoom?.(snapshot('self')));
  await act(() => vi.advanceTimersByTimeAsync(31_000));
  expect(mocks.command.mock.calls).toEqual([
    [{ command: 'heartbeat' }],
    [{ command: 'heartbeat' }],
    [{ command: 'heartbeat' }],
  ]);
  // Heartbeats renew the server-side participant TTL; they do not recreate an
  // otherwise healthy SSE stream. Explicit reconnect diagnostics use restart.
  expect(mocks.streamGeneration).toBe(0);
  expect(screen.getByText('live')).toBeTruthy();
  expect(screen.getByText('self')).toBeTruthy();
});

test('does not heartbeat when the viewer has no joined participant', async () => {
  vi.useFakeTimers();
  render(
    <ProjectTaskRoomProvider taskId="task-1">
      <Consumer />
    </ProjectTaskRoomProvider>,
  );
  act(() => mocks.stream?.onRoom?.(snapshot('peer')));
  await act(() => vi.advanceTimersByTimeAsync(31_000));
  expect(mocks.command).not.toHaveBeenCalled();
  expect(mocks.streamGeneration).toBe(0);
});

test('marks the exact server reconnect strategy without document content', () => {
  const marks: unknown[] = [];
  const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks((event) =>
    marks.push(event),
  );
  render(
    <ProjectTaskRoomProvider taskId="task-1">
      <Consumer />
    </ProjectTaskRoomProvider>,
  );
  act(() =>
    mocks.stream?.onDocument?.({
      kind: 'delta',
      revision: `swsr-v1:${'a'.repeat(64)}`,
      diagnostic: true,
    }),
  );
  act(() => {
    mocks.stream?.onDocument?.({
      kind: 'delta',
      revision: `swsr-v1:${'a'.repeat(20_000)}`,
      diagnostic: true,
    });
    mocks.stream?.onDocument?.(
      Object.create({
        kind: 'gap',
        floor: `swsr-v1:${'b'.repeat(64)}`,
        diagnostic: true,
      }),
    );
  });
  expect(marks).toEqual([
    expect.objectContaining({
      kind: 'reconnect-strategy',
      mark: expect.objectContaining({
        taskId: 'task-1',
        strategy: 'delta',
        revision: `swsr-v1:${'a'.repeat(64)}`,
      }),
    }),
  ]);
  unsubscribe();
});

test('keeps SSE authoritative over delayed commands and makes terminal absorbing', async () => {
  let resolveOlder: ((value: unknown) => void) | undefined;
  mocks.command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOlder = resolve;
      }),
  );
  render(
    <ProjectTaskRoomProvider taskId="task-1">
      <Consumer />
    </ProjectTaskRoomProvider>,
  );
  act(() => mocks.stream?.onRoom?.(snapshot('initial')));
  fireEvent.click(screen.getByRole('button', { name: 'Command' }));
  act(() => mocks.stream?.onRoom?.(snapshot('newer')));
  await act(async () => {
    resolveOlder?.({
      kind: 'available',
      generation: 'generation-1',
      snapshot: snapshot('older'),
    });
    await Promise.resolve();
  });
  expect(screen.getByText('newer')).toBeTruthy();

  let resolveAfterTerminal: ((value: unknown) => void) | undefined;
  mocks.command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveAfterTerminal = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Command' }));
  act(() => mocks.stream?.onTerminal?.());
  await act(async () => {
    resolveAfterTerminal?.({
      kind: 'available',
      generation: 'generation-1',
      snapshot: snapshot('resurrected'),
    });
    await Promise.resolve();
  });
  act(() => mocks.stream?.onRoom?.(snapshot('queued-same-generation')));
  expect(screen.getByText('terminal')).toBeTruthy();
  expect(screen.getByText('no-live')).toBeTruthy();
  expect(screen.queryByText('resurrected')).toBeNull();
  expect(screen.queryByText('queued-same-generation')).toBeNull();
});
