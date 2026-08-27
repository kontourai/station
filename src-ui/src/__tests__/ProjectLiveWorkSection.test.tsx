/**
 * @vitest-environment jsdom
 */

/**
 * station#3202. The sidebar badge named a number and the project page showed
 * none of what it counted — "what does the '6' next to kontour mean? should be
 * clear when I click into that how to 'resolve' those things", refined to "or
 * it's ongoing work that's active". These cover the destination: the two live
 * lanes, scoped to this project, with rows a reader can act on.
 */
import type { ProjectTaskRoomBrowserLiveSnapshot } from '@kontourai/station-contracts/project-task-room-browser';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  agents: [] as Array<Record<string, unknown>>,
  focus: vi.fn(),
  navigate: vi.fn(),
  roomDiscoveries: new Map<string, Record<string, unknown>>(),
  roomStreams: new Map<
    string,
    { onRoom?(value: ProjectTaskRoomBrowserLiveSnapshot): void }
  >(),
  roomStreamCalls: vi.fn(),
  roomCommand: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionsQuery: () => ({ data: mocks.sessions }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => mocks.agents,
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock('../contexts/open-chats-store', () => ({
  openChatsStore: { focus: mocks.focus },
}));
vi.mock('@kontourai/station-sdk/project-task-rooms', () => ({
  useProjectTaskRoomDiscoveryQuery: (taskId: string) => ({
    data: mocks.roomDiscoveries.get(taskId) ?? { kind: 'unavailable' },
    isLoading: false,
  }),
  useProjectTaskRoomStream: (
    taskId: string,
    callbacks: { onRoom?(value: ProjectTaskRoomBrowserLiveSnapshot): void },
  ) => {
    mocks.roomStreamCalls(taskId);
    mocks.roomStreams.set(taskId, callbacks);
  },
  useCommandProjectTaskRoomLiveMutation: () => ({
    isPending: false,
    mutateAsync: mocks.roomCommand,
  }),
}));

import { ProjectLiveWorkSection } from '../views/project-page/ProjectLiveWorkSection';

function session(overrides: Record<string, unknown>) {
  return {
    threadId: 'thread-1',
    provider: 'claude',
    controlMode: 'managed',
    status: 'open',
    projectSlug: 'station',
    assignedAgentSlug: 'station',
    displayTitle: 'Ship the badge fix',
    createdAt: '2026-08-02T19:00:00.000Z',
    updatedAt: '2026-08-02T20:00:00.000Z',
    answerability: { answerable: true },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.sessions.length = 0;
  mocks.agents.length = 0;
  mocks.agents.push(
    { slug: 'station', name: 'Station' },
    { slug: 'codex', name: 'Codex' },
  );
  mocks.focus.mockClear();
  mocks.navigate.mockClear();
  mocks.roomDiscoveries.clear();
  mocks.roomStreams.clear();
  mocks.roomStreamCalls.mockClear();
  mocks.roomCommand.mockReset();
  mocks.roomCommand.mockResolvedValue({ kind: 'unavailable' });
});

function liveSnapshot(
  publication: 'published' | 'private' = 'published',
  sessionId = 'task-session',
): ProjectTaskRoomBrowserLiveSnapshot {
  return {
    generation: 'generation-1',
    viewerActorId: 'actor-viewer',
    scope: { projectId: 'project-1', taskId: 'task-1' },
    state: 'active',
    participants: [
      {
        actor: { actorId: 'actor-1', kind: 'agent', label: 'Codex' },
        work: {
          sessionId,
          workName: 'Implement the live room',
          workState: 'working',
          startedAt: 1,
        },
        publication,
      },
    ],
    panes: [],
    cursors: [],
  };
}

describe('ProjectLiveWorkSection', () => {
  test('renders nothing at all when nothing is live in this project', () => {
    // Never a "0 live" block: a permanent empty section costs every reader
    // space to tell most of them there is nothing to read.
    mocks.sessions.push(
      session({ threadId: 'finished', lifecycleState: 'completed' }),
      session({
        threadId: 'elsewhere',
        projectSlug: 'beacon',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
    );

    const { container } = render(<ProjectLiveWorkSection slug="station" />);
    expect(container.innerHTML).toBe('');
  });

  test('groups the project’s live sessions into the Sessions list’s own lanes', () => {
    mocks.sessions.push(
      session({
        threadId: 'waiting',
        displayTitle: 'Reply needed on the migration',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
      session({
        threadId: 'running',
        displayTitle: 'Overnight regression run',
        assignedAgentSlug: 'codex',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
    );

    render(<ProjectLiveWorkSection slug="station" />);

    expect(screen.getByText('Needs you · 1')).toBeTruthy();
    expect(screen.getByText('Active now · 1')).toBeTruthy();
    // Identity a reader can act on: the session's own title (never a thread
    // id), whose it is, and what state it is in.
    expect(
      screen.getByRole('button', {
        name: /Reply needed on the migration.*Station.*Waiting on you/i,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: /Overnight regression run.*Codex.*Running/i,
      }),
    ).toBeTruthy();
    expect(screen.queryByText('waiting')).toBeNull();
    expect(screen.queryByText('running')).toBeNull();
  });

  /**
   * The owner asked that the two populations be distinguishable at a glance,
   * not only by reading a heading. The lane modifier is what carries the rail
   * colour and the filled-vs-outline state chip in CSS, and the call to action
   * names the difference in one word: a Needs-you row is yours to discharge,
   * an Active-now row is something to look at.
   */
  test('marks the two lanes apart beyond their heading text', () => {
    mocks.sessions.push(
      session({
        threadId: 'waiting',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
      session({
        threadId: 'running',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
    );

    const { container } = render(<ProjectLiveWorkSection slug="station" />);

    expect(
      container.querySelector('.project-page__live-work-lane--needsYou'),
    ).toBeTruthy();
    expect(
      container.querySelector('.project-page__live-work-lane--activeNow'),
    ).toBeTruthy();
    expect(screen.getByText('Reply')).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
  });

  test('anchors every row with its agent’s icon, engine-named when no agent resolves', () => {
    mocks.sessions.push(
      session({
        threadId: 'known',
        displayTitle: 'Known agent',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
      session({
        threadId: 'unknown',
        displayTitle: 'Detached transcript',
        assignedAgentSlug: undefined,
        provider: 'codex',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
    );

    const { container } = render(<ProjectLiveWorkSection slug="station" />);

    expect(
      container.querySelectorAll('.project-page__live-work-icon'),
    ).toHaveLength(2);
    // An unattributable session is named for its ENGINE, never dressed up as
    // an agent it might not be and never shown as a bare thread id.
    expect(
      screen.getByRole('button', { name: /Detached transcript.*Codex/i }),
    ).toBeTruthy();
  });

  /**
   * station#3227 A1. This section's row state used to be
   * `sessionLifecycleLabel(session.lifecycleState)` — the raw wire state,
   * with none of the fold's overrides — while its lane heading came from the
   * fold. So a row filed under "Needs you" said *Running*, and a session
   * nothing could answer said *"Waiting on you"*.
   *
   * This walks the RENDERED lanes rather than asserting one word per shape:
   * every row's state word must be one this heading is allowed to sit above.
   */
  test('no rendered row contradicts the lane heading above it', () => {
    const LANE_VOCABULARY: Record<string, string[]> = {
      needsYou: [
        'Needs attention',
        'Waiting on you',
        'Review pending',
        'Blocked',
      ],
      activeNow: ['Running', 'Ready', 'Queued', "Can't answer here"],
    };

    mocks.sessions.push(
      // A1 shape 1 (#1069): attached, never ran a turn.
      session({
        threadId: 'idle-running',
        displayTitle: 'Attached but idle',
        lifecycleState: 'running',
        hasActiveTurn: false,
      }),
      // A1 shape 2: a review is pending while a turn is in flight.
      session({
        threadId: 'review-while-running',
        displayTitle: 'Review pending mid-turn',
        lifecycleState: 'running',
        hasActiveTurn: true,
        pendingReview: true,
      }),
      // A1 shape 4 (#1783): nothing can answer it.
      session({
        threadId: 'stranded',
        displayTitle: 'Stranded request',
        lifecycleState: 'needs_input',
        answerability: {
          answerable: false,
          qualification: 'provider_absent',
          observedBy: 'station-test',
          observedAt: '2026-08-02T19:30:00.000Z',
        },
      }),
      session({
        threadId: 'waiting',
        displayTitle: 'Waiting on a decision',
        lifecycleState: 'needs_input',
      }),
      session({
        threadId: 'running',
        displayTitle: 'Live turn',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
      session({
        threadId: 'queued',
        displayTitle: 'Not started yet',
        lifecycleState: 'queued',
      }),
    );

    const { container } = render(<ProjectLiveWorkSection slug="station" />);

    const rendered = Array.from(
      container.querySelectorAll('.project-page__live-work-lane'),
    ).flatMap((lane) => {
      const laneId = Array.from(lane.classList)
        .map((name) => name.replace('project-page__live-work-lane--', ''))
        .find((name) => name in LANE_VOCABULARY);
      const heading =
        lane.querySelector('.project-page__live-work-eyebrow')?.textContent ??
        '';
      return Array.from(
        lane.querySelectorAll('.project-page__live-work-state'),
      ).map((state) => ({
        laneId,
        heading,
        word: state.textContent?.trim() ?? '',
      }));
    });

    // Both lanes populated and every session accounted for — a walk over an
    // empty render would pass while checking nothing.
    expect(rendered).toHaveLength(6);
    expect(new Set(rendered.map((row) => row.laneId))).toEqual(
      new Set(['needsYou', 'activeNow']),
    );

    for (const row of rendered) {
      expect(
        LANE_VOCABULARY[row.laneId ?? ''],
        `a row under "${row.heading}" says "${row.word}"`,
      ).toContain(row.word);
    }

    // The three A1 shapes, by the word they used to print.
    expect(
      screen.getByRole('button', { name: /Attached but idle.*Ready/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: /Review pending mid-turn.*Needs attention/i,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: /Stranded request.*Can't answer here/i,
      }),
    ).toBeTruthy();
  });

  test('a finished run is not listed here — it belongs to the Sessions list', () => {
    mocks.sessions.push(
      session({
        threadId: 'running',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
      session({
        threadId: 'finished',
        displayTitle: 'Yesterday’s deploy',
        lifecycleState: 'completed',
      }),
    );

    render(<ProjectLiveWorkSection slug="station" />);
    expect(screen.queryByText('Yesterday’s deploy')).toBeNull();
    expect(screen.queryByText(/Recently finished/)).toBeNull();
  });

  test('opening a row reopens that session', () => {
    mocks.sessions.push(
      session({
        threadId: 'waiting',
        model: 'claude-opus',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
    );

    render(<ProjectLiveWorkSection slug="station" />);
    fireEvent.click(
      screen.getByRole('button', { name: /Ship the badge fix/i }),
    );

    expect(mocks.focus).toHaveBeenCalledWith({
      conversationId: 'waiting',
      agentSlug: 'station',
      projectSlug: 'station',
      projectName: undefined,
      model: 'claude-opus',
      threadId: 'waiting',
    });
  });

  test('a session Station cannot reopen falls through to the sessions surface', () => {
    // `read-only-attached` is the shared open policy's navigate branch. The
    // row must still be actionable rather than silently no-oping.
    mocks.sessions.push(
      session({
        threadId: 'attached',
        controlMode: 'read-only-attached',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
    );

    render(<ProjectLiveWorkSection slug="station" />);
    fireEvent.click(
      screen.getByRole('button', { name: /Ship the badge fix/i }),
    );

    expect(mocks.focus).toHaveBeenCalledWith({ threadId: 'attached' });
  });

  test('links out to the Sessions list for everything it deliberately omits', () => {
    mocks.sessions.push(
      session({
        threadId: 'running',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
    );

    render(<ProjectLiveWorkSection slug="station" />);
    fireEvent.click(screen.getByRole('button', { name: 'All activity' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/activity');
  });

  test('matches only published task-room presence and exposes separate accessible actions', () => {
    mocks.sessions.push(
      session({
        threadId: 'task-session',
        lifecycleState: 'running',
        hasActiveTurn: true,
        delegation: { taskId: 'task-1' },
      }),
    );
    mocks.roomDiscoveries.set('task-1', {
      kind: 'existing',
      capabilities: { live: true },
    });
    const { container } = render(<ProjectLiveWorkSection slug="station" />);
    act(() => mocks.roomStreams.get('task-1')?.onRoom?.(liveSnapshot()));

    expect(
      screen.getByText('Codex published: Implement the live room'),
    ).toBeTruthy();
    expect(
      container.querySelector('.project-page__live-work-presence'),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Watch Ship the badge fix' }),
    );
    expect(mocks.roomCommand).toHaveBeenCalledWith({
      command: 'watch',
      paneId: 'project-live:task-1',
      targetActorId: 'actor-1',
    });
    expect(
      screen.getByRole('button', { name: 'Follow Ship the badge fix' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Jump in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(mocks.focus).toHaveBeenCalledTimes(2);
    expect(mocks.focus).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: 'task-session' }),
    );
  });

  test.each([
    ['private', liveSnapshot('private')],
    ['another session', liveSnapshot('published', 'other-session')],
  ])(
    'does not project %s presence onto the session row',
    (_label, snapshot) => {
      mocks.sessions.push(
        session({
          threadId: 'task-session',
          lifecycleState: 'running',
          hasActiveTurn: true,
          delegation: { taskId: 'task-1' },
        }),
      );
      mocks.roomDiscoveries.set('task-1', {
        kind: 'existing',
        capabilities: { live: true },
      });
      const { container } = render(<ProjectLiveWorkSection slug="station" />);
      act(() => mocks.roomStreams.get('task-1')?.onRoom?.(snapshot));
      expect(screen.getByText('No published task-room presence')).toBeTruthy();
      expect(
        container.querySelector('.project-page__live-work-presence'),
      ).toBeNull();
      expect(
        screen
          .getByRole('button', { name: 'Watch Ship the badge fix' })
          .matches(':disabled'),
      ).toBe(true);
    },
  );

  test('keeps Watch and Follow disabled without the room live capability', () => {
    mocks.sessions.push(
      session({
        threadId: 'task-session',
        lifecycleState: 'running',
        hasActiveTurn: true,
        delegation: { taskId: 'task-1' },
      }),
    );
    mocks.roomDiscoveries.set('task-1', {
      kind: 'existing',
      capabilities: { live: false },
    });
    render(<ProjectLiveWorkSection slug="station" />);
    act(() => mocks.roomStreams.get('task-1')?.onRoom?.(liveSnapshot()));
    expect(
      screen
        .getByRole('button', { name: 'Watch Ship the badge fix' })
        .matches(':disabled'),
    ).toBe(true);
    expect(
      screen
        .getByRole('button', { name: 'Follow Ship the badge fix' })
        .matches(':disabled'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Jump in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chat' })).toBeTruthy();
  });

  test('non-task sessions never gain room presence or room commands', () => {
    mocks.sessions.push(
      session({
        threadId: 'ordinary-session',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
    );
    const { container } = render(<ProjectLiveWorkSection slug="station" />);
    expect(mocks.roomStreamCalls).not.toHaveBeenCalled();
    expect(
      container.querySelector('.project-page__live-work-presence'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /Watch/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Jump in' })).toBeNull();
  });

  test('shares one stream context for two sessions delegated to the same task', () => {
    mocks.sessions.push(
      session({
        threadId: 'task-session',
        lifecycleState: 'running',
        hasActiveTurn: true,
        delegation: { taskId: 'task-1' },
      }),
      session({
        threadId: 'task-session-2',
        displayTitle: 'Second worker',
        lifecycleState: 'running',
        hasActiveTurn: true,
        delegation: { taskId: 'task-1' },
      }),
    );
    render(<ProjectLiveWorkSection slug="station" />);
    expect(mocks.roomStreamCalls).toHaveBeenCalledTimes(1);
    expect(mocks.roomStreamCalls).toHaveBeenCalledWith('task-1');
  });
});
