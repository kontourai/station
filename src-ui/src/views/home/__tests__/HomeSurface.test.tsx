/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { HomeWorkItem } from '../home-view-model';

// #928: Home reveals Activity as a region surface rather than navigating to a
// route, and `useShowSurface` reads the region model through a provider this
// file does not mount. The double is what the assertions below read.
const showSurface = vi.hoisted(() => vi.fn());
const showSurfacePage = vi.hoisted(() => vi.fn());
vi.mock('../../../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurface,
  useShowSurfacePage: () => showSurfacePage,
}));
// The rows' git locations and project colours are read from the session
// and Project queries (the dock's own hooks), and this file mounts no query
// client. The cross-surface agreement is pinned in ActivityList.test and
// ChatInboxHoverCard.test, which feed those reads.
vi.mock('../../../hooks/useGitLocationByThreadId', () => ({
  useGitLocationByThreadId: () => new Map(),
}));
const accentProbe = vi.hoisted(() => ({
  accents: new Map<string, string>(),
}));
vi.mock('../../../hooks/useProjectAccents', () => ({
  useProjectAccents: () => accentProbe.accents,
}));

// The start composer owns its own tests (`HomeStartComposer.test.tsx`); here
// it is the one "Start work" form whose place and compactness Home decides.
vi.mock('../../../components/home/HomeStartComposer', () => ({
  HomeStartComposer: ({ compact }: { compact?: boolean }) => (
    <form aria-label="Start work" data-compact={String(Boolean(compact))} />
  ),
}));
vi.mock('../../../hooks/useProjectIcons', () => ({
  useProjectIcons: () => new Map(),
}));

import { HomeSurface } from '../HomeSurface';

// The surface name the Activity rename retired (archive#3280), in the
// affordance positions it used to occupy.
const LEGACY_SURFACE_LABEL = /\b(?:view|open|all)\s+sessions\b/i;

const NOW = Date.now();
const min = (n: number) => NOW - n * 60_000;

function item(
  id: string,
  title: string,
  project: string,
  minutesAgo: number,
  lifecycleLabel: HomeWorkItem['lifecycleLabel'] = 'Completed',
  extra: Partial<HomeWorkItem> = {},
): HomeWorkItem {
  return {
    id,
    kind: 'orchestration',
    kindLabel: 'Session',
    title,
    projectLabel: project,
    agentLabel: 'Codex',
    modelLabel: 'gpt-5.4',
    updatedAt: min(minutesAgo),
    lifecycleLabel,
    ...extra,
  } as HomeWorkItem;
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    projects: [{ id: 'p1', slug: 'station', name: 'Station' }],
    agents: [{ slug: 'codex-agent', name: 'Codex' }],
    defaultSelection: {
      agent: { slug: 'codex-agent', name: 'Codex' },
      effectiveModel: { label: 'gpt-5.4' },
    },
    workItems: [] as HomeWorkItem[],
    workLoading: false,
    workDegraded: false,
    workError: false,
    retryWork: vi.fn(),
    remoteUnavailable: [],
    remoteAuthenticationRequired: [],
    startReady: true,
    startIdentity: 'Codex · gpt-5.4',
    primaryWorkItem: undefined,
    continueWork: vi.fn(),
    ...overrides,
    // Cast through `unknown` to the real prop type rather than `any`: the
    // double is deliberately partial, but naming the target keeps a field
    // rename visible here instead of silently absorbed.
  } as unknown as Parameters<typeof HomeSurface>[0]['model'];
}

function renderHome(
  overrides: Record<string, unknown> = {},
  onNavigate = vi.fn(),
  continuation: Parameters<typeof HomeSurface>[0]['continuation'] = null,
) {
  const m = model(overrides);
  render(
    <HomeSurface
      model={m}
      continuation={continuation}
      onNavigate={onNavigate}
    />,
  );
  return { model: m, onNavigate };
}

describe('HomeSurface live-lane focus', () => {
  beforeEach(() => localStorage.clear());

  test('a focused row whose lane empties (Running -> Idle) keeps focus', () => {
    const running = item(
      'a',
      'Wire the delegate verbs',
      'Station',
      2,
      'Running',
    );
    const idle = item('b', 'Audit the ref translation', 'Station', 30, 'Ready');
    const view = render(
      <HomeSurface
        model={model({ workItems: [running, idle] })}
        continuation={null}
        onNavigate={vi.fn()}
      />,
    );
    const open = (title: string) =>
      screen
        .getByText(title)
        .closest<HTMLElement>('.chat-dock-inbox__item') as HTMLElement;
    open('Wire the delegate verbs').focus();
    expect(document.activeElement).toBe(open('Wire the delegate verbs'));

    view.rerender(
      <HomeSurface
        model={model({
          workItems: [{ ...running, lifecycleLabel: 'Ready' }, idle],
        })}
        continuation={null}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.queryByRole('heading', { name: /^Running/ })).toBeNull();
    expect(document.activeElement).toBe(open('Wire the delegate verbs'));
  });
});

describe('HomeSurface composition', () => {
  beforeEach(() => {
    localStorage.clear();
    showSurface.mockClear();
    showSurfacePage.mockClear();
  });

  test('an empty Station keeps its accessible page heading and starter cards', () => {
    renderHome({ workItems: [] });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Home' }),
    ).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Work actions' })).toBeTruthy();
    expect(screen.queryByText('Skip to recent work')).toBeNull();
  });

  test('a page with work leads with the form and the lanes; the cards wait below (V1, Q3, U2)', () => {
    renderHome({
      workItems: [item('a', 'Some work', 'Station', 3, 'Running')],
    });
    expect(screen.queryByRole('heading', { name: "What's next?" })).toBeNull();
    // Document order: the start form, then the work, then the cards (U2: the
    // skip link reaches the work in one stop).
    const skip = screen.getByRole('link', { name: 'Skip to recent work' });
    const recent = screen.getByRole('region', { name: 'Recent work' });
    const actions = screen.getByRole('region', { name: 'Work actions' });
    const form = screen.getByRole('form', { name: 'Start work' });
    expect(skip.getAttribute('href')).toBe(`#${recent.id}`);
    expect(
      form.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      recent.compareDocumentPosition(actions) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // #1582 E5: the card named the project by its SLUG while the sidebar named
  // the same project by its name on the same screen. A `NavigationView` only
  // carries a slug, so the name comes from the catalog record keyed by it.
  test('the last-project card names the project the way the sidebar does', () => {
    renderHome({}, vi.fn(), { type: 'project', slug: 'station' });
    const card = screen.getByRole('button', { name: /Last project/ });
    expect(card.textContent).toContain('Station');
    expect(card.textContent).not.toContain('station');
  });

  test('a layout continuation is named by its project, not its project slug', () => {
    renderHome({}, vi.fn(), {
      type: 'layout',
      projectSlug: 'station',
      layoutSlug: 'coding',
    });
    const card = screen.getByRole('button', { name: /Last project/ });
    expect(card.textContent).toContain('Station');
    expect(card.textContent).not.toContain('station');
  });

  test('a project the catalog no longer holds keeps its slug as the only handle', () => {
    // The section renders a skeleton until the catalog settles, so an
    // unmatched slug here means the project is gone — not that it is loading.
    renderHome({}, vi.fn(), { type: 'project', slug: 'retired-project' });
    const card = screen.getByRole('button', { name: /Last project/ });
    expect(card.textContent).toContain('retired-project');
  });

  // #3312: a section and the form inside it were both named "Start work",
  // two landmarks with one name. The form is the one.
  test.each([[[]], [[item('a', 'Some work', 'Station', 3, 'Running')]]])(
    'Home has one "Start work" landmark, the form (work: %#)',
    (workItems) => {
      renderHome({ workItems });
      expect(screen.getAllByRole('form', { name: 'Start work' })).toHaveLength(
        1,
      );
      expect(screen.queryAllByRole('region', { name: 'Start work' })).toEqual(
        [],
      );
    },
  );

  test('the start composer is compact above a page of work, full on an empty one', () => {
    renderHome({ workItems: [] });
    expect(
      screen.getByRole('form', { name: 'Start work' }).dataset.compact,
    ).toBe('false');
    cleanup();
    renderHome({
      workItems: [item('a', 'Some work', 'Station', 3, 'Running')],
    });
    expect(
      screen.getByRole('form', { name: 'Start work' }).dataset.compact,
    ).toBe('true');
  });

  // The Continue and Last project cards read like the inbox rows (owner,
  // 2026-10): Continue IS the shared work row; Last project carries the
  // project's accent, as the sidebar draws it.
  test('Continue is the shared work row, and opens the work', () => {
    const running = item(
      'a',
      'Wire the delegate verbs',
      'Station',
      2,
      'Running',
    );
    const { model: m } = renderHome({
      workItems: [running],
      primaryWorkItem: running,
    });
    const region = screen.getByRole('region', { name: 'Continue' });
    const row = region.querySelector<HTMLElement>('.chat-dock-inbox__item');
    expect(row?.textContent).toContain('Wire the delegate verbs');
    expect(row?.textContent).toContain('Codex');
    fireEvent.click(row!);
    expect(m.continueWork).toHaveBeenCalledWith(running);
  });

  // Review MED-3b: the item in Continue is not repeated in the list beside
  // it; every other item still is.
  test('the list leaves out the item the Continue card shows, and keeps the rest', () => {
    const newest = item(
      'a',
      'Wire the delegate verbs',
      'Station',
      2,
      'Running',
    );
    const older = item(
      'b',
      'Audit the ref translation',
      'Station',
      30,
      'Running',
    );
    renderHome({ workItems: [newest, older], primaryWorkItem: newest });
    const recent = screen.getByRole('region', { name: 'Recent work' });
    expect(within(recent).queryByText('Wire the delegate verbs')).toBeNull();
    expect(within(recent).getByText('Audit the ref translation')).toBeTruthy();
    expect(screen.getAllByText('Wire the delegate verbs')).toHaveLength(1);
    // The row is the lanes' full-size row, in the lanes' own list.
    const region = screen.getByRole('region', { name: 'Continue' });
    expect(region.querySelector('ul.home-view__task-list')).toBeTruthy();
  });

  // Second review: with one item, Continue holds it and Recent work would
  // be a heading over nothing. It is left out; View Activity sits beside
  // the Continue heading, which is an h2 like the section it replaces.
  test('one item: no empty Recent work, and View Activity beside Continue', () => {
    const only = item('a', 'Wire the delegate verbs', 'Station', 2, 'Running');
    renderHome({ workItems: [only], primaryWorkItem: only });
    expect(screen.queryByRole('region', { name: 'Recent work' })).toBeNull();
    const region = screen.getByRole('region', { name: 'Continue' });
    expect(
      within(region).getByRole('heading', { level: 2, name: 'Continue' }),
    ).toBeTruthy();
    fireEvent.click(
      within(region).getByRole('button', { name: 'View Activity' }),
    );
    expect(showSurfacePage).toHaveBeenCalledWith('activity');
    // The skip link still lands on the work.
    expect(
      screen
        .getByRole('link', { name: 'Skip to recent work' })
        .getAttribute('href'),
    ).toBe(`#${region.id}`);
  });

  test('several items: Recent work holds the rest and keeps View Activity', () => {
    const newest = item(
      'a',
      'Wire the delegate verbs',
      'Station',
      2,
      'Running',
    );
    const older = item(
      'b',
      'Audit the ref translation',
      'Station',
      30,
      'Running',
    );
    renderHome({ workItems: [newest, older], primaryWorkItem: newest });
    const recent = screen.getByRole('region', { name: 'Recent work' });
    expect(
      within(recent).getByRole('button', { name: 'View Activity' }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Continue' })).queryByRole(
        'button',
        { name: 'View Activity' },
      ),
    ).toBeNull();
  });

  test('Last project carries the project accent the sidebar uses', () => {
    accentProbe.accents = new Map([['station', 'rgb(1, 2, 3)']]);
    renderHome({}, vi.fn(), { type: 'project', slug: 'station' });
    const card = screen.getByRole('button', { name: /Last project/ });
    const accent = card.querySelector<HTMLElement>('.home-view__action-accent');
    // The sidebar's colour for this project, from the one shared map.
    expect(accent?.style.backgroundColor).toBe('rgb(1, 2, 3)');
    accentProbe.accents = new Map();
  });

  test.each([true, false])(
    'Home can open agent discovery when chat readiness is %s',
    (startReady) => {
      const { onNavigate } = renderHome({ startReady });
      fireEvent.click(screen.getByRole('button', { name: /Explore agents/ }));
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ type: 'agents' });
    },
  );

  test('renders the activity chart, past one row, alongside one work list', () => {
    renderHome({
      workItems: [
        item('a', 'Wire the delegate verbs', 'Station', 2, 'Running'),
        item('b', 'Audit the ref translation', 'Forage', 300),
      ],
    });
    expect(
      screen.getByRole('heading', { name: 'Where the work has been' }),
    ).toBeTruthy();
    const recent = screen.getByRole('region', { name: 'Recent work' });
    expect(
      within(recent).getByRole('heading', { name: 'Running · 1' }),
    ).toBeTruthy();
    // The one-list constraint, pinned: an item appears exactly once in the
    // list. Two recent-work lists is the failure this composition exists to
    // prevent, and it would read as a duplicate row rather than an error.
    expect(
      within(recent).getAllByText('Audit the ref translation'),
    ).toHaveLength(1);
  });

  test('keeps unattributed activity visible without calling its groups projects', () => {
    renderHome({
      workItems: [
        item('a', 'Attributed work', 'Station', 5, 'Running'),
        item(
          'b',
          'Ambiguous work',
          'ambiguous (station, beacon)',
          10,
          'Running',
        ),
        item('c', 'Unattributed work', 'No project', 15, 'Running'),
        item('d', 'Orphaned task', 'Project unavailable', 20, 'Running'),
        item(
          'e',
          'Guessed work',
          'beacon (unverified name match)',
          25,
          'Running',
        ),
      ],
    });
    const rows = document.querySelectorAll('.home-heat__row');
    expect(rows.length).toBe(5);
  });

  /**
   * The counts and the list must come from ONE lane derivation. A second
   * `useHomeWorkLanes` instance would carry its own snooze snapshot, so this
   * pins the shared one through the observable consequence: a snoozed item is
   * absent from the list AND counted as snoozed by the caption.
   */
  test('a snoozed item is hidden from the list and counted by the shelf', () => {
    localStorage.setItem(
      'station.activity.snoozed',
      JSON.stringify({ snoozy: NOW + 60 * 60_000 }),
    );
    renderHome({
      workItems: [
        item('snoozy', 'Snoozed work', 'Station', 4, 'Running'),
        item('other', 'Visible work', 'Station', 6, 'Running'),
        item('elsewhere', 'Other project work', 'Forage', 8, 'Running'),
      ],
    });
    expect(screen.queryByText('Snoozed work')).toBeNull();
    // The shelf's own heading carries the count: no second strip of numbers.
    expect(screen.getByRole('button', { name: 'Snoozed · 1' })).toBeTruthy();
    expect(document.querySelector('.home-pulse__stats')).toBeNull();
    // …and it is absent from the chart too, which reads the same lanes.
    expect(
      document.querySelector('.home-heat__rows')?.textContent,
    ).not.toContain('Snoozed work');
  });

  /**
   * The sharper form of the same claim, with power over the duplication
   * itself: waking a row is a RUNTIME lane change. Two `useHomeWorkLanes`
   * instances read the same stored snoozes at mount, so a pre-snoozed
   * fixture alone cannot tell one instance from two — but a wake mutates
   * only the instance it was called on, so a second instance would leave the
   * chart still hiding a row the list has just brought back.
   */
  test('waking a row updates the chart, not just the list', () => {
    localStorage.setItem(
      'station.activity.snoozed',
      JSON.stringify({ snoozy: NOW + 60 * 60_000 }),
    );
    renderHome({
      workItems: [
        item('snoozy', 'Snoozed work', 'Station', 4, 'Running'),
        item('other', 'Visible work', 'Station', 6, 'Running'),
        item('elsewhere', 'Other project work', 'Forage', 8, 'Running'),
      ],
    });
    // The newest item in the bucket names the bar, and while snoozy is
    // hidden that is the other row.
    expect(
      screen.queryByRole('button', { name: /open Snoozed work/ }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Snoozed · 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wake Snoozed work' }));

    expect(
      screen.getByRole('button', { name: /open Snoozed work/ }),
    ).toBeTruthy();
  });

  test('a failed load sends the reader to Activity rather than counting nothing', () => {
    const { model: m } = renderHome({ workItems: [], workError: true });
    expect(screen.getByText('Recent work unavailable')).toBeTruthy();
    screen.getByRole('button', { name: 'Open Activity' }).click();
    expect(showSurfacePage).toHaveBeenCalledWith('activity');
    expect(m.retryWork).not.toHaveBeenCalled();
    expect(
      screen.queryAllByRole('button', { name: LEGACY_SURFACE_LABEL }),
    ).toEqual([]);
  });

  test('an empty list renders no chart, only the one-line empty state', () => {
    renderHome({ workItems: [] });
    expect(
      screen.queryByRole('heading', { name: 'Where the work has been' }),
    ).toBeNull();
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
  });

  test('one project row is not a chart either (V3)', () => {
    renderHome({
      workItems: [item('a', 'Some work', 'Station', 3, 'Running')],
    });
    expect(
      screen.queryByRole('heading', { name: 'Where the work has been' }),
    ).toBeNull();
  });
});

describe('HomeSurface: what is clickable', () => {
  beforeEach(() => {
    localStorage.clear();
    showSurface.mockClear();
    showSurfacePage.mockClear();
  });

  test('View Activity opens the Activity page, and promises nothing more', () => {
    const { onNavigate } = renderHome({
      workItems: [item('a', 'Some work', 'Station', 3, 'Running')],
    });
    const recent = screen.getByRole('region', { name: 'Recent work' });
    within(recent).getByRole('button', { name: 'View Activity' }).click();
    // No session: a generic "show me Activity", so no intent is minted and
    // nothing routes (#928 — there is no Activity route left to route to).
    // It is the page verb (Activity takes `main`), not the dock reveal.
    expect(showSurfacePage).toHaveBeenCalledWith('activity');
    expect(showSurface).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    // Activity is the surface's only name here: no retired "Sessions"
    // affordance renders beside the right one.
    expect(
      screen.queryAllByRole('button', { name: LEGACY_SURFACE_LABEL }),
    ).toEqual([]);
  });

  test('a chart bar opens the newest item in that bucket', () => {
    const { model: m } = renderHome({
      workItems: [
        item('older', 'Older work', 'Station', 30, 'Running'),
        item('newer', 'Newer work', 'Station', 5, 'Running'),
        item('elsewhere', 'Other project work', 'Forage', 8, 'Running'),
      ],
    });
    const bar = screen.getByRole('button', { name: /open Newer work/ });
    bar.click();
    expect(m.continueWork).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'newer' }),
    );
  });

  test('a project row whose items agree on a configured slug opens that project', () => {
    const { onNavigate } = renderHome({
      workItems: [
        item('a', 'Work', 'station', 5, 'Running', { projectSlug: 'station' }),
        item('b', 'Other work', 'Forage', 8, 'Running'),
      ],
      projects: [{ id: 'p1', slug: 'station', name: 'Station' }],
    });
    screen.getByRole('button', { name: 'Open the station project' }).click();
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'project',
      slug: 'station',
    });
  });

  test('a row labelled with the project’s NAME opens it too', () => {
    const { onNavigate } = renderHome({
      workItems: [
        item('a', 'Work', 'Station', 5, 'Running', { projectSlug: 'station' }),
        item('b', 'Other work', 'Forage', 8, 'Running'),
      ],
    });
    screen.getByRole('button', { name: 'Open the Station project' }).click();
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'project',
      slug: 'station',
    });
  });

  /**
   * The label-vs-derivation guard. `sessionProjectLabel` prints a caveat when
   * the project binding is a cross-machine NAME match; the session's own
   * local `projectSlug` is a different fact. Linking the caveated label to
   * the local project would answer the question the caveat exists to keep
   * open.
   */
  test('a caveated project label is text, not a link', () => {
    renderHome({
      workItems: [
        item('a', 'Work', 'station (unverified name match)', 5, 'Running', {
          projectSlug: 'station',
        }),
        item('b', 'Other work', 'Forage', 8, 'Running'),
      ],
    });
    expect(screen.queryByRole('button', { name: /project$/ })).toBeNull();
    expect(
      document.querySelector('.home-heat__label')?.tagName.toLowerCase(),
    ).toBe('span');
  });

  test('a slug with no configured project is text, not a link', () => {
    renderHome({
      workItems: [
        item('a', 'Work', 'ghost', 5, 'Running', { projectSlug: 'ghost' }),
      ],
    });
    expect(screen.queryByRole('button', { name: /Open the/ })).toBeNull();
  });

  test('“No project” never becomes a link', () => {
    renderHome({ workItems: [item('a', 'Work', 'No project', 5, 'Running')] });
    expect(screen.queryByRole('button', { name: /Open the/ })).toBeNull();
  });
});

describe('HomeSurface: agent icons', () => {
  beforeEach(() => localStorage.clear());

  test('a row whose agent is in the catalog draws that agent’s icon', () => {
    renderHome({
      workItems: [
        item('a', 'Work', 'Station', 3, 'Running', {
          agentSlug: 'codex-agent',
        }),
      ],
    });
    expect(document.querySelectorAll('.chat-dock-inbox__avatar')).toHaveLength(
      1,
    );
  });

  /**
   * The rule the brief and `home-view-model.ts`'s `safeAgentLabel` docblock
   * both insist on: an unresolved agent gets NO icon. `agentLabel` is a
   * display string that may already be an engine name; feeding it to
   * `AgentIcon` would mint an identicon for an identity nothing derived —
   * the defect that once put a Model-connection name beside a Station mark.
   */
  test('a row naming an agent this Station does not have draws no icon', () => {
    renderHome({
      workItems: [
        item('a', 'Work', 'Station', 3, 'Running', {
          agentSlug: 'an-agent-that-was-deleted',
        }),
      ],
    });
    expect(document.querySelectorAll('.chat-dock-inbox__avatar')).toHaveLength(
      0,
    );
    // …and the row still says who it was attributed to, in text.
    expect(screen.getAllByText(/Codex/).length).toBeGreaterThan(0);
  });

  test('a row naming no agent at all draws no icon', () => {
    renderHome({ workItems: [item('a', 'Work', 'Station', 3, 'Running')] });
    expect(document.querySelectorAll('.chat-dock-inbox__avatar')).toHaveLength(
      0,
    );
  });
});
