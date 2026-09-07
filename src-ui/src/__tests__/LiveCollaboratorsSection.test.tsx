/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ data: undefined as any, navigate: vi.fn() }));
// `RegionModelProvider` wraps the whole application, so `useShowSurface`
// requires it. This harness mounts a fragment of that tree, and nothing
// here asserts a surface reveal, so the command hook is supplied directly.
const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));

vi.mock('@kontourai/station-sdk/live-activity', () => ({
  useLiveActivityQuery: () => ({ data: mocks.data }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));

import {
  LiveCollaboratorsSection,
  liveCollaboratorSummary,
} from '../components/live-activity/LiveCollaboratorsSection';

beforeEach(() => {
  mocks.data = undefined;
  mocks.navigate.mockReset();
});

test('hides empty activity and renders published human/agent work with safe actions', () => {
  const { container, rerender } = render(<LiveCollaboratorsSection />);
  expect(container.innerHTML).toBe('');
  mocks.data = {
    connectedClients: 3,
    participants: [
      {
        id: 'a'.repeat(24),
        actor: { kind: 'human', label: 'Brian' },
        scope: { projectId: 'p', projectSlug: 'station', taskId: '123' },
        work: {
          workName: 'Reviewing auth',
          workState: 'reviewing',
          startedAt: Date.now(),
        },
        watching: { state: 'following', targetLabel: 'Codex' },
      },
      {
        id: 'b'.repeat(24),
        actor: { kind: 'agent', label: 'Codex' },
        scope: { projectId: 'p', projectSlug: 'station', taskId: '123' },
        work: {
          sessionId: 'session-2',
          runId: 'run-2',
          workName: 'Implement roster',
          workState: 'working',
          startedAt: Date.now(),
        },
      },
    ],
  };
  rerender(<LiveCollaboratorsSection />);
  expect(screen.getByText('Live collaborators')).toBeTruthy();
  expect(screen.getByText('3 clients, 2 publishing live work')).toBeTruthy();
  expect(screen.getByText(/Following Codex/)).toBeTruthy();
  expect(
    screen.queryByRole('button', {
      name: "View Brian's session for Reviewing auth",
    }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole('button', {
      name: "Jump in to Brian's Reviewing auth on Task 123",
    }),
  );
  expect(mocks.navigate).toHaveBeenCalledWith('/tasks/123');
  fireEvent.click(
    screen.getByRole('button', {
      name: "View Codex's run for Implement roster",
    }),
  );
  expect(mocks.navigate).toHaveBeenCalledWith(
    '/projects/station/flow-console',
    { run: 'run-2' },
  );
});

// #1582 D5. The panel said the same thing four ways — a heading, a mono
// eyebrow, a mono count pair and a status line — for the state that is almost
// always true. One sentence, and the jargon behind a disclosure.
test('says "just you" for one client publishing nothing, in one line', () => {
  mocks.data = { connectedClients: 1, participants: [] };
  const { container } = render(<LiveCollaboratorsSection />);
  expect(screen.getByText('Just you on this host')).toBeTruthy();
  // The line it replaces is gone, not merely restyled: two renderings of one
  // pair of counts is how a surface starts disagreeing with itself.
  expect(screen.queryByText(/activity not published/)).toBeNull();
  // The jargon is present but collapsed — `details` with no `open`.
  const details = container.querySelector('details');
  expect(details).toBeTruthy();
  expect(details?.hasAttribute('open')).toBe(false);
  expect(screen.getByText('Published work across this host')).toBeTruthy();
});

// Review L2. The details block explains what each number COUNTS, which is a
// claim about the producer: the route sums `sessionCount` over
// `connectedClientPresence.snapshot(activePairedDeviceIds())`, so it counts
// paired devices — not "browsers and CLIs attached", which would include
// anything that had opened a socket.
test('the details block says what connectedClients actually counts', () => {
  mocks.data = { connectedClients: 2, participants: [] };
  render(<LiveCollaboratorsSection />);
  expect(
    screen.getByText(/paired devices connected to this Station/),
  ).toBeTruthy();
  expect(screen.queryByText(/browsers and CLIs/)).toBeNull();
});

test('the sentence is derived from both counts, not from "no participants"', () => {
  // Only the exact pair (one client, nothing published) is "just you". Two
  // clients with nothing published is a different fact and must not claim it.
  expect(liveCollaboratorSummary(1, 0)).toBe('Just you on this host');
  expect(liveCollaboratorSummary(2, 0)).toBe(
    '2 clients, 0 publishing live work',
  );
  expect(liveCollaboratorSummary(1, 1)).toBe(
    '1 client, 1 publishing live work',
  );
  expect(liveCollaboratorSummary(0, 3)).toBe(
    '0 clients, 3 publishing live work',
  );
});

test('keeps simultaneous human rows distinct with opaque roster keys', () => {
  mocks.data = {
    connectedClients: 0,
    participants: [
      {
        id: 'c'.repeat(24),
        actor: { kind: 'human', label: 'Brian' },
        scope: { projectId: 'p', projectSlug: 'station', taskId: '123' },
        work: {
          workName: 'Project task work',
          workState: 'working',
          startedAt: Date.now(),
        },
      },
      {
        id: 'd'.repeat(24),
        actor: { kind: 'human', label: 'Brian' },
        scope: { projectId: 'p', projectSlug: 'station', taskId: '123' },
        work: {
          workName: 'Project task work',
          workState: 'working',
          startedAt: Date.now(),
        },
      },
    ],
  };
  render(<LiveCollaboratorsSection />);
  expect(screen.getAllByText('Brian')).toHaveLength(2);
});
