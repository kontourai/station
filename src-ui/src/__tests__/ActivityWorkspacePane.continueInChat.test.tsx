// @vitest-environment jsdom

import {
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const showSurface = vi.hoisted(() => vi.fn());
const sessionsViewProps = vi.hoisted(() => ({
  current: null as null | {
    onContinueInChat?: (threadId: string, draft: string) => void;
  },
}));

vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurface,
}));
vi.mock('../views/activity/ActivityWorkspacePaneBinding', () => ({
  useActivityWorkspacePaneBinding: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../views/SessionsView', () => ({
  SessionsView: (props: typeof sessionsViewProps.current) => {
    sessionsViewProps.current = props;
    return null;
  },
}));

import { takeAttachedContinuationHandoff } from '../lib/attached-continuation-handoff';
import { ActivityWorkspacePane } from '../views/activity/ActivityWorkspacePane';

/**
 * #3552 with #3454: Activity's message for an external conversation goes to
 * the chat dock's reader of that conversation, which continues it there.
 */
test('Activity hands an external conversation’s draft to the chat dock and opens it there', () => {
  render(
    <ActivityWorkspacePane
      descriptor={WORKSPACE_ACTIVITY_PANE_DESCRIPTOR}
      instance={WORKSPACE_ACTIVITY_PANE_INSTANCE}
    />,
  );
  const handOff = sessionsViewProps.current?.onContinueInChat;
  expect(handOff).toBeTypeOf('function');

  handOff?.('external:codex:thread-1', 'Exact draft');

  expect(showSurface).toHaveBeenCalledWith('chat', {
    session: 'external:codex:thread-1',
  });
  expect(takeAttachedContinuationHandoff('external:codex:thread-1')).toBe(
    'Exact draft',
  );
});
