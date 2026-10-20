/** @vitest-environment jsdom */

import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  AuthorityHarness,
  authoritySwitch,
  installFakeLocks,
  settledStorageSnapshot,
} from '../../../contexts/__tests__/paneRelationsHarness';
import { ActivityReviewProvider } from '../../../contexts/ActivityReviewContext';
import { chatDraftsStore } from '../../../contexts/chat-drafts-store';
import { KeyboardShortcutsProvider } from '../../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../../contexts/NavigationContext';
import { navigationStore } from '../../../contexts/navigation-store';
import { PaneRelationsProvider } from '../../../contexts/PaneRelationsContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../../contexts/RegionModelContext';
import { UnsavedGuardOwnerContext } from '../../../contexts/UnsavedGuardOwnerContext';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import {
  PANE_RELATIONS_STORAGE_KEY,
  parsePaneRelations,
} from '../../../regions/pane-relations';
import { activityReviewInstance } from '../../../workspace-panes/activityReviewPane';
import { RegionActivityReviewPane } from '../../../workspace-panes/RegionActivityReviewPane';
import { SessionsView } from '../../SessionsView';

const network = vi.hoisted(() => ({ read: vi.fn() }));
let sessions: OrchestrationSessionSummary[] = [];
let responseStatus = 200;

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useAgentsQuery: () => ({ data: [], isLoading: false }),
  useProjectsQuery: () => ({ data: [], isSuccess: true }),
  useProjectIdentityQuery: () => ({ isSuccess: false, isError: false }),
  useOrchestrationSessionsQuery: () => ({
    data: sessions,
    isLoading: false,
    refetch: vi.fn(),
  }),
  usePullRequestContextQuery: () => ({ data: { available: false } }),
  usePullRequestsQuery: () => ({ data: undefined }),
  usePullRequestMergeabilityQuery: () => ({ data: undefined }),
  authenticatedFetch: (url: string) => network.read(url),
}));
vi.mock('@kontourai/station-sdk/action-operations', () => ({
  useActionOperationsQuery: () => ({ data: { items: [] } }),
  useCancelActionOperationMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => null,
}));
vi.mock('../../../components/chat-dock/DelegationLauncher', () => ({
  DelegationLauncher: () => null,
}));
vi.mock('../../../components/session-detail/SessionDetail', () => ({
  SessionDetail: ({ session }: { session: OrchestrationSessionSummary }) => (
    <p>Transcript: {session.displayTitle}</p>
  ),
}));

let model: ReturnType<typeof useRegionModel>;
function RelatedRegion() {
  model = useRegionModel();
  const id = model.regions.right.occupant;
  const instance = id ? activityReviewInstance(id) : null;
  return instance ? (
    <UnsavedGuardOwnerContext.Provider value={id} key={id}>
      <RegionActivityReviewPane instance={instance} />
    </UnsavedGuardOwnerContext.Provider>
  ) : null;
}

function session(
  threadId: string,
  title: string,
  projectSlug: string,
  minutes: number,
): OrchestrationSessionSummary {
  const time = new Date(Date.now() - minutes * 60_000).toISOString();
  return {
    threadId,
    provider: 'claude',
    displayTitle: title,
    projectSlug,
    status: 'ready',
    controlMode: 'station-owned',
    lifecycleState: 'completed',
    hasActiveTurn: false,
    isLoaded: false,
    isPersisted: true,
    eventCount: 0,
    createdAt: time,
    updatedAt: time,
    answerability: { answerable: true },
  };
}

function App() {
  return (
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <AuthorityHarness initial={{ station: 'station-a' }}>
          <RegionModelProvider>
            <PaneRelationsProvider>
              <ActivityReviewProvider>
                <SessionsView apiBase="http://station.test" />
                <RelatedRegion />
              </ActivityReviewProvider>
            </PaneRelationsProvider>
          </RegionModelProvider>
        </AuthorityHarness>
      </NavigationProvider>
    </KeyboardShortcutsProvider>
  );
}

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  await act(async () => {
    model.openSurfaceInRegion('activity', { region: 'main' });
  });
  return {
    ...view,
    refresh: () =>
      view.rerender(
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>,
      ),
  };
}

function list() {
  const element = document.querySelector('.split-pane__list');
  if (!(element instanceof HTMLElement))
    throw new Error('Activity list missing');
  return element;
}
async function quickReview(title: string) {
  const row = within(list())
    .getByRole('button', { name: title })
    .closest('.split-pane__item-row');
  if (!row) throw new Error('Activity row was not rendered');
  fireEvent.click(
    within(row as HTMLElement).getByRole('button', {
      name: 'More actions',
    }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Quick review' }));
  await screen.findByRole('region', { name: 'Activity quick review' });
}
function review() {
  return screen.getByRole('region', { name: 'Activity quick review' });
}
function saved() {
  return parsePaneRelations(localStorage.getItem(PANE_RELATIONS_STORAGE_KEY))
    .record.entries;
}

beforeEach(() => {
  localStorage.clear();
  deviceSettingsStore.reset('regionArrangement');
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  installFakeLocks();
  sessions = [
    session('a', 'Review alpha', 'one', 1),
    session('outside', 'Unrelated', 'two', 2),
    session('b', 'Review beta', 'one', 3),
    session('c', 'Review gamma', 'one', 4),
  ];
  responseStatus = 200;
  network.read.mockReset();
  network.read.mockImplementation(async (url: string) => {
    const id = decodeURIComponent(
      new URL(url).pathname.split('/').at(-1) ?? '',
    );
    const found = sessions.find((item) => item.threadId === id);
    if (!found) throw new Error(`Unmodeled read: ${url}`);
    return new Response(
      JSON.stringify(
        responseStatus === 200
          ? { success: true, data: { session: found, events: [] } }
          : { success: false, error: 'Read refused' },
      ),
      { status: responseStatus },
    );
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('review and siblings preserve the main selection, search, visible ordering and scroll; Open keeps and reopening focuses', async () => {
  const view = await mount();
  fireEvent.click(within(list()).getByRole('button', { name: 'Review alpha' }));
  const search = screen.getByPlaceholderText('Search activity…');
  fireEvent.change(search, { target: { value: 'Review' } });
  const listElement = view.container.querySelector('.split-pane__list');
  if (!(listElement instanceof HTMLElement)) throw new Error('List missing');
  listElement.scrollTop = 83;
  await quickReview('Review beta');
  await within(review()).findByText('Transcript: Review beta');
  expect(
    within(list())
      .getByRole('button', { name: 'Review alpha' })
      .getAttribute('aria-current'),
  ).toBe('true');
  expect((search as HTMLInputElement).value).toBe('Review');
  expect(listElement.scrollTop).toBe(83);
  fireEvent.click(within(review()).getByRole('button', { name: 'Next' }));
  await waitFor(() =>
    expect(within(review()).getByText('Transcript: Review gamma')).toBeTruthy(),
  );
  expect(within(review()).getByRole('button', { name: 'Next' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.click(within(review()).getByRole('button', { name: 'Previous' }));
  await waitFor(() =>
    expect(within(review()).getByText('Transcript: Review beta')).toBeTruthy(),
  );
  fireEvent.click(within(review()).getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(saved()[0]?.kept).toBe(true));
  const keptId = model.regions.right.occupant;
  await quickReview('Review gamma');
  await within(review()).findByText('Transcript: Review gamma');
  await quickReview('Review beta');
  await within(review()).findByText('Transcript: Review beta');
  expect(model.regions.right.occupant).toBe(keptId);
  expect(saved()).toHaveLength(2);
  expect((search as HTMLInputElement).value).toBe('Review');
  expect(listElement.scrollTop).toBe(83);
});

test('dataset changes remove adjacency without falling through to unfiltered items', async () => {
  const view = await mount();
  fireEvent.change(screen.getByPlaceholderText('Search activity…'), {
    target: { value: 'Review' },
  });
  await quickReview('Review beta');
  await within(review()).findByText('Transcript: Review beta');
  sessions = sessions.filter((item) => item.threadId !== 'a');
  view.refresh();
  await waitFor(() =>
    expect(
      within(review()).getByRole('button', { name: 'Previous' }),
    ).toHaveProperty('disabled', true),
  );
  fireEvent.change(screen.getByPlaceholderText('Search activity…'), {
    target: { value: 'Unrelated' },
  });
  await waitFor(() =>
    expect(
      within(review()).getByRole('button', { name: 'Next' }),
    ).toHaveProperty('disabled', true),
  );
  expect(within(review()).getByRole('status').textContent).toContain(
    'outside Activity',
  );
  expect(within(review()).getByText('Transcript: Review beta')).toBeTruthy();
});

test('a target removed from the filtered source while its covered owner answers a guard is refused without writes', async () => {
  const view = await mount();
  await quickReview('Review alpha');
  await within(review()).findByText('Transcript: Review alpha');
  let proceed: (() => void) | undefined;
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('covered work'),
    (accept) => {
      proceed = accept;
    },
    model.regions.right.occupant,
  );
  const before = await settledStorageSnapshot();
  await quickReview('Review beta');
  expect(proceed).toBeDefined();
  sessions = sessions.filter((item) => item.threadId !== 'b');
  view.refresh();
  await act(async () => {
    proceed?.();
  });
  expect(await settledStorageSnapshot()).toEqual(before);
  expect(within(review()).getByText('Transcript: Review alpha')).toBeTruthy();
  unregister();
});

test('a real draft guard keeps the preview and Cancel preserves source, child, focus and storage', async () => {
  await mount();
  await quickReview('Review alpha');
  await within(review()).findByText('Transcript: Review alpha');
  await act(async () => {
    chatDraftsStore.setActivityDraft(
      'http://station.test',
      'a',
      'Unsent review reply',
    );
  });
  await waitFor(() => expect(saved()[0]?.kept).toBe(true));
  const before = await settledStorageSnapshot();
  const next = within(review()).getByRole('button', { name: 'Next' });
  next.focus();
  fireEvent.click(next);
  const dialog = await screen.findByRole('dialog', { name: 'Unsaved Changes' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(await settledStorageSnapshot()).toEqual(before);
  expect(within(review()).getByText('Transcript: Review alpha')).toBeTruthy();
  expect(chatDraftsStore.getActivityDraft('http://station.test', 'a')).toBe(
    'Unsent review reply',
  );
  await waitFor(() => expect(document.activeElement).toBe(next));
  await act(async () => {
    chatDraftsStore.clearActivityDraft('http://station.test', 'a');
  });
});

test.each([403, 404, 503])(
  'detail read %i has a distinct outcome and the Station fence stops reads after identity loss',
  async (status) => {
    responseStatus = status;
    await mount();
    await quickReview('Review beta');
    const title =
      status === 403
        ? 'Station denied access to this activity'
        : status === 404
          ? 'This activity is no longer available'
          : 'Station could not load this activity';
    await within(review()).findByText(title);
    const count = network.read.mock.calls.length;
    await act(async () => {
      authoritySwitch.set?.('unverified');
    });
    expect(screen.getByText('Checking which Station this is')).toBeTruthy();
    await act(async () => {
      authoritySwitch.set?.({ station: 'station-b' });
    });
    expect(screen.getByText('Opened on another Station')).toBeTruthy();
    expect(network.read).toHaveBeenCalledTimes(count);
  },
);
