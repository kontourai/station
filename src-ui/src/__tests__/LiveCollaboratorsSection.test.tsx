/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ data: undefined as any, navigate: vi.fn() }));
vi.mock('@kontourai/station-sdk/live-activity', () => ({
  useLiveActivityQuery: () => ({ data: mocks.data }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));

import { LiveCollaboratorsSection } from '../components/live-activity/LiveCollaboratorsSection';

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
  expect(
    screen.getByText(/3 connected clients · 2 publishing live work/),
  ).toBeTruthy();
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

test('explains a connected client without inferring activity', () => {
  mocks.data = { connectedClients: 1, participants: [] };
  render(<LiveCollaboratorsSection />);
  expect(screen.getByText('Connected — activity not published.')).toBeTruthy();
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
