/** @vitest-environment jsdom */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { HomeSurface } from '../HomeSurface';
import type { HomeWorkItem } from '../home-view-model';

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
) {
  const m = model(overrides);
  render(<HomeSurface model={m} continuation={null} onNavigate={onNavigate} />);
  return { model: m, onNavigate };
}

describe('HomeSurface composition', () => {
  beforeEach(() => localStorage.clear());

  test('keeps the page heading and the guided actions', () => {
    renderHome({
      workItems: [item('a', 'Some work', 'Station', 3, 'Running')],
    });
    expect(
      screen.getByRole('heading', { name: 'What do you want to work on?' }),
    ).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Work actions' })).toBeTruthy();
  });

  test('the start card names the agent it can actually open on', () => {
    renderHome();
    const card = screen.getByRole('button', { name: /Start direct chat/ });
    expect(card.textContent).toContain('Codex · gpt-5.4');
  });

  test('with no runnable agent the start card becomes a set-up CTA', () => {
// Finding 5: Home must not name an Agent the New Chat picker refuses one
// click later. On a home where nothing is runnable it stops recommending
// and asks for the setup instead — same destination, honest promise.
    renderHome({
      startReady: false,
      startIdentity: 'No agent is ready yet',
      defaultSelection: {
        agent: undefined,
        effectiveModel: { label: 'Model not reported' },
      },
    });
    expect(screen.queryByRole('button', { name: /Start direct chat/ })).toBe(
      null,
    );
    const cta = screen.getByRole('button', { name: /Set up an agent/ });
    expect(cta.textContent).toContain('Finish setting up an engine to chat');
// And it names no agent at all.
    expect(cta.textContent).not.toContain('Codex');
  });

  test('renders the activity chart and the counts alongside one work list', () => {
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
    expect(within(recent).getByText('Active now')).toBeTruthy();
// The one-list constraint, pinned: an item appears exactly once in the
// list. Two recent-work lists is the failure this composition exists to
// prevent, and it would read as a duplicate row rather than an error.
    expect(
      within(recent).getAllByText('Audit the ref translation'),
    ).toHaveLength(1);
  });

/**
* archive#3227 A7, carried over: the "Projects" number and the chart's rows
* must fold the same list. Pinned as the INVARIANT, not a spot value — the
* fixture deliberately has ONE configured project against five distinct
* project labels, the populations the audit caught disagreeing.
*/
  test('the Projects count equals the project rows the chart renders', () => {
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
    const projectStat = Array.from(
      document.querySelectorAll('.home-pulse__stat'),
    ).find(
      (stat) =>
        stat.querySelector('.home-pulse__label')?.textContent === 'Projects',
    );
    expect(projectStat?.querySelector('.home-pulse__value')?.textContent).toBe(
      String(rows.length),
    );
  });

/**
* The counts and the list must come from ONE lane derivation. A second
* `useHomeWorkLanes` instance would carry its own snooze snapshot, so this
* pins the shared one through the observable consequence: a snoozed item is
* absent from the list AND counted as snoozed by the caption.
*/
  test('a snoozed item is hidden from the list and counted by the caption', () => {
    localStorage.setItem(
      'station.activity.snoozed',
      JSON.stringify({ snoozy: NOW + 60 * 60_000 }),
    );
    renderHome({
      workItems: [
        item('snoozy', 'Snoozed work', 'Station', 4, 'Running'),
        item('other', 'Visible work', 'Station', 6, 'Running'),
      ],
    });
    expect(screen.queryByText('Snoozed work')).toBeNull();
    const snoozedStat = Array.from(
      document.querySelectorAll('.home-pulse__stat'),
    ).find(
      (stat) =>
        stat.querySelector('.home-pulse__label')?.textContent === 'Snoozed',
    );
    expect(snoozedStat?.querySelector('.home-pulse__value')?.textContent).toBe(
      '1',
    );
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
      ],
    });
// The newest item in the bucket names the bar, and while snoozy is
// hidden that is the other row.
    expect(
      screen.queryByRole('button', { name: /open Snoozed work/ }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Snoozed, 1, open the snoozed shelf',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Wake Snoozed work' }));

    expect(
      screen.getByRole('button', { name: /open Snoozed work/ }),
    ).toBeTruthy();
  });

  test('a failed load offers a retry rather than counting nothing', () => {
    const { model: m } = renderHome({ workItems: [], workError: true });
    expect(screen.getByText('Recent work unavailable')).toBeTruthy();
// No counts at all: a caption for lanes that are not on the page would
// print four zeroes over an error.
    expect(document.querySelector('.home-pulse__stats')).toBeNull();
    screen.getByRole('button', { name: 'Open Activity' }).click();
    expect(m.retryWork).not.toHaveBeenCalled();
  });

  test('an empty list renders neither counts nor a chart', () => {
    renderHome({ workItems: [] });
    expect(document.querySelector('.home-pulse__stats')).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Where the work has been' }),
    ).toBeNull();
  });
});

describe('HomeSurface: what is clickable', () => {
  beforeEach(() => localStorage.clear());

  test('View Activity goes to Activity, and promises nothing more', () => {
    const { onNavigate } = renderHome({
      workItems: [item('a', 'Some work', 'Station', 3, 'Running')],
    });
    const recent = screen.getByRole('region', { name: 'Recent work' });
    within(recent).getByRole('button', { name: 'View Activity' }).click();
    expect(onNavigate).toHaveBeenCalledWith({ type: 'activity' });
  });

  test('a chart bar opens the newest item in that bucket', () => {
    const { model: m } = renderHome({
      workItems: [
        item('older', 'Older work', 'Station', 30, 'Running'),
        item('newer', 'Newer work', 'Station', 5, 'Running'),
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

/**
* Counts are controls only where their population is on the page, and the
* accessible name says where it goes rather than repeating the number.
*/
  test('counts with a rendered lane are labelled controls; counts without one are not', () => {
    renderHome({
      workItems: [
        item('a', 'Running work', 'Station', 2, 'Running'),
        item('b', 'Old work', 'Station', 600),
      ],
    });
    expect(
      screen.getByRole('button', {
        name: 'Active now, 1, show the Active now lane',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'Projects, 1, show where the work has been',
      }),
    ).toBeTruthy();
// Nothing is snoozed and nothing is in the "Recently finished" lane, so
// neither renders and neither count offers a destination.
    expect(screen.queryByRole('button', { name: /^Snoozed,/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /^Just finished,/ }),
    ).toBeNull();
  });

  test('the snoozed count opens the collapsed shelf it counts', () => {
    localStorage.setItem(
      'station.activity.snoozed',
      JSON.stringify({ snoozy: NOW + 60 * 60_000 }),
    );
    renderHome({
      workItems: [
        item('snoozy', 'Snoozed work', 'Station', 4, 'Running'),
        item('other', 'Visible work', 'Station', 6, 'Running'),
      ],
    });
    const shelf = screen.getByRole('button', { name: /^Snoozed \(1\)$/ });
    expect(shelf.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Snoozed, 1, open the snoozed shelf',
      }),
    );
    expect(
      screen
        .getByRole('button', { name: /^Snoozed \(1\)$/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByText('Snoozed work')).toBeTruthy();
  });

  test('every count target it offers is an element that exists', () => {
    renderHome({
      workItems: [
        item('a', 'Running work', 'Station', 2, 'Running'),
        item('b', 'Done work', 'Station', 3, 'Completed'),
      ],
    });
// "Just finished" is a rendered lane here, so its control must land on a
// real heading rather than scrolling nowhere.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Just finished, 1, show the Recently finished lane',
      }),
    );
    expect(
      document.getElementById('home-recently-finished-heading'),
    ).toBeTruthy();
    expect(document.activeElement?.id).toBe('home-recently-finished-heading');
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
    expect(document.querySelectorAll('.home-view__task-icon')).toHaveLength(1);
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
    expect(document.querySelectorAll('.home-view__task-icon')).toHaveLength(0);
// …and the row still says who it was attributed to, in text.
    expect(screen.getAllByText(/Codex/).length).toBeGreaterThan(0);
  });

  test('a row naming no agent at all draws no icon', () => {
    renderHome({ workItems: [item('a', 'Work', 'Station', 3, 'Running')] });
    expect(document.querySelectorAll('.home-view__task-icon')).toHaveLength(0);
  });
});
