// @vitest-environment jsdom
import type { AttentionItem } from '@kontourai/station-sdk';
import { render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { deviceSettingsStore } from '../../../lib/device-settings-store';

const state = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  useTasksQuery: () => ({ data: [], isLoading: false, isError: false }),
  useBoardAttentionQuery: () => ({
    data: { items: state.items, pendingCount: state.items.length },
    isLoading: false,
    isError: false,
  }),
  useBoardRecentWorkQuery: () => ({
    data: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'station-a',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../contexts/ProjectsContext', () => ({
  useScopedProjectsQuery: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import { PersonalBoardSectionContent } from '../PersonalBoardSections';

const FLOW_HREF = '/projects/station/flow-console?run=run-1';
const source = {
  threadId: 'thread-alpha',
  runId: 'run-1',
  gateId: 'verify',
  projectSlug: 'station',
};
const stamps = {
  createdAt: '2026-06-28T00:00:02.000Z',
  updatedAt: '2026-06-28T00:00:02.000Z',
};
const gateItems: AttentionItem[] = [
  {
    id: 'gate-route-back:run-1:verify',
    kind: 'gate-route-back',
    title: 'Route back: verify',
    ...stamps,
    source,
    openHref: FLOW_HREF,
  },
  {
    id: 'gate-blocked:run-1:verify',
    kind: 'gate-blocked',
    title: 'Blocked: verify',
    ...stamps,
    source,
    openHref: FLOW_HREF,
  },
  {
    id: 'gate-exception:run-1:verify',
    kind: 'gate-exception',
    title: 'Exception needed: verify',
    ...stamps,
    source,
    openHref: FLOW_HREF,
    limitExceeded: true,
  },
];
// A non-gate item keeps its link whatever the Flow preview says.
const failure: AttentionItem = {
  id: 'session-failed:thread-boom',
  kind: 'session-failed',
  title: 'Fix the login redirect',
  ...stamps,
  sessionId: 'thread-boom',
  openHref: '/?surface=activity&session=thread-boom',
  source: { threadId: 'thread-boom' },
};

function renderAttention() {
  state.items = [...gateItems, failure];
  render(
    <PersonalBoardSectionContent
      section={{
        id: 's1',
        kind: 'attention',
        title: 'Needs attention',
        width: 'half',
        limit: 8,
      }}
    />,
  );
  return screen.getByRole('list');
}

afterEach(() =>
  deviceSettingsStore.resetMany([
    'developerToolsEnabled',
    'experimentalFlowEnabled',
  ]),
);

test('with the Flow preview off, gate titles are plain text and other items still link', () => {
  deviceSettingsStore.set('developerToolsEnabled', true);
  deviceSettingsStore.set('experimentalFlowEnabled', false);
  const list = renderAttention();

  for (const item of gateItems) {
    const title = within(list).getByText(item.title);
    expect(title.closest('a')).toBeNull();
  }
  const links = within(list).getAllByRole('link');
  expect(links.map((link) => link.textContent)).toEqual([
    'Fix the login redirect',
  ]);
  expect(links[0].getAttribute('href')).toBe(
    '/?surface=activity&session=thread-boom',
  );
});

test('with the Flow preview on, gate titles link to the run console', () => {
  deviceSettingsStore.set('developerToolsEnabled', true);
  deviceSettingsStore.set('experimentalFlowEnabled', true);
  const list = renderAttention();

  const links = within(list).getAllByRole('link');
  expect(
    links.map((link) => [link.textContent, link.getAttribute('href')]),
  ).toEqual([
    ['Route back: verify', FLOW_HREF],
    ['Blocked: verify', FLOW_HREF],
    ['Exception needed: verify', FLOW_HREF],
    ['Fix the login redirect', '/?surface=activity&session=thread-boom'],
  ]);
});
