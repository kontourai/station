/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MarketplaceSources } from '../components/registry/MarketplaceSources';

const { mutate, select, reset, extraSources } = vi.hoisted(() => ({
  mutate: vi.fn(),
  select: vi.fn(),
  reset: vi.fn(),
  extraSources: [] as Array<Record<string, unknown>>,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useRegistrySourcesQuery: () => ({
    data: [
      {
        id: 'station',
        kind: 'plugins',
        displayName: 'Station',
        origin: 'station',
        enabled: true,
        status: 'ready',
      },
      {
        id: 'community',
        kind: 'skills',
        displayName: 'Community',
        origin: 'user',
        location: '/catalog',
        adapter: 'directory',
        enabled: false,
        status: 'disabled',
      },
      {
        id: 'publisher',
        kind: 'plugins',
        displayName: 'Publisher tools',
        origin: 'plugin',
        owner: 'publisher-plugin',
        enabled: true,
        status: 'stale',
        error: 'Offline catalog. Last successful snapshot retained.',
      },
      ...extraSources,
    ],
    isLoading: false,
    error: null,
  }),
  useRegistrySourceActionMutation: () => ({
    mutate,
    reset,
    isPending: false,
    error: null,
  }),
}));
vi.mock('../components/Dialog', () => ({
  Dialog: ({
    title,
    children,
    footer,
  }: {
    title: string;
    children: React.ReactNode;
    footer: React.ReactNode;
  }) => (
    <section role="dialog" aria-label={title}>
      {children}
      {footer}
    </section>
  ),
}));
afterEach(() => {
  vi.clearAllMocks();
  extraSources.length = 0;
});

const hillClimb = {
  id: 'hill-climb',
  kind: 'skills',
  displayName: 'Bil0000/Hill-Climb',
  origin: 'user',
  location: 'https://github.com/Bil0000/Hill-Climb',
  ref: 'main',
  adapter: 'github',
  enabled: true,
  status: 'ready',
  detection: {
    state: 'detected',
    index: 'claude-marketplace:.claude-plugin/marketplace.json',
    revision: '551c997e9eb3ae81fed9edf1d8a66bd32cd0dbf8',
    checkedAt: new Date().toISOString(),
    kinds: [
      { kind: 'skills', count: 1, via: 'skill-md', installable: true },
      {
        kind: 'plugins',
        count: 1,
        via: 'claude-marketplace',
        installable: false,
        note: 'Claude Code plugin packages are recognized but are not a format Station installs.',
      },
    ],
  },
};

test('adds a source from a location and optional ref, with no type to choose, then shows what was detected', () => {
  render(<MarketplaceSources selected="all" onSelect={select} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
  const dialog = screen.getByRole('dialog', { name: 'Add source' });
  expect(within(dialog).queryByRole('combobox')).toBeNull();
  fireEvent.change(within(dialog).getByLabelText('Location'), {
    target: { value: ' https://github.com/Bil0000/Hill-Climb ' },
  });
  fireEvent.change(within(dialog).getByLabelText(/^Ref/), {
    target: { value: 'main' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add source' }));
  expect(mutate).toHaveBeenCalledWith(
    {
      action: 'add',
      source: {
        location: 'https://github.com/Bil0000/Hill-Climb',
        ref: 'main',
      },
    },
    expect.any(Object),
  );
  const { onSuccess } = mutate.mock.calls[0]![1] as {
    onSuccess: (source: unknown) => void;
  };
  act(() => onSuccess(hillClimb));
  const result = screen.getByRole('dialog', {
    name: 'Added Bil0000/Hill-Climb',
  });
  expect(result.textContent).toContain('1 skill');
  expect(result.textContent).toContain(
    '1 plugin · recognized, not installable',
  );
  expect(result.textContent).toContain('Nothing is installed yet');
  fireEvent.click(
    within(result).getByRole('button', { name: 'Browse this source' }),
  );
  expect(select).toHaveBeenCalledWith('hill-climb', 'skills');
});

test('a source card shows its trust tier, detected kinds with counts and its freshness', () => {
  extraSources.push(hillClimb, {
    id: 'notes',
    kind: 'skills',
    displayName: 'Notes',
    origin: 'user',
    location: '/notes',
    adapter: 'directory',
    enabled: true,
    status: 'ready',
    detection: {
      state: 'nothing-recognized',
      kinds: [],
      checkedAt: new Date().toISOString(),
    },
  });
  render(<MarketplaceSources selected="all" onSelect={select} />);
  const card = screen
    .getByText('Bil0000/Hill-Climb', { selector: 'strong' })
    .closest('article') as HTMLElement;
  expect(within(card).getByText('Unverified')).toBeTruthy();
  expect(card.textContent).toContain(
    'https://github.com/Bil0000/Hill-Climb @ main',
  );
  const kinds = within(card).getByRole('list', {
    name: 'What this source provides',
  });
  expect(
    within(kinds)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['1 skill', '1 plugin · recognized, not installable']);
  expect(card.textContent).toContain('revision 551c997');
  const notes = screen
    .getByText('Notes', { selector: 'strong' })
    .closest('article') as HTMLElement;
  expect(notes.textContent).toContain('Nothing Station recognizes yet');
  const station = screen
    .getByText('Station', { selector: 'strong' })
    .closest('article') as HTMLElement;
  expect(within(station).getByText('Ships with Station')).toBeTruthy();
});

test('a kinds-filtered view includes a source that supplies that kind beside its primary one', () => {
  extraSources.push({
    ...hillClimb,
    id: 'mixed',
    displayName: 'Mixed folder',
    detection: {
      ...hillClimb.detection,
      kinds: [
        { kind: 'skills', count: 2, via: 'skill-md', installable: true },
        {
          kind: 'plugins',
          count: 1,
          via: 'station-manifest',
          installable: true,
        },
      ],
    },
  });
  render(
    <MarketplaceSources selected="all" onSelect={select} kinds={['plugins']} />,
  );
  const options = within(screen.getByLabelText('Browse marketplace'))
    .getAllByRole('option')
    .map((option) => option.textContent);
  expect(options).toContain('Mixed folder');
  // Recognized-but-not-installable plugins do not make a source a plugin catalog.
  expect(options).not.toContain('Bil0000/Hill-Climb');
  expect(options).not.toContain('Community (disabled)');
});

test('filters by host source identity and keeps plugin ownership and offline status visible', () => {
  render(<MarketplaceSources selected="all" onSelect={select} />);
  fireEvent.change(screen.getByLabelText('Browse marketplace'), {
    target: { value: 'publisher' },
  });
  expect(select).toHaveBeenCalledWith('publisher', 'plugins');
  expect(screen.getByText('Provided by plugin publisher-plugin')).toBeTruthy();
  expect(
    screen.getByText('Offline catalog. Last successful snapshot retained.'),
  ).toBeTruthy();
  fireEvent.click(screen.getByText('Manage sources (3)'));
  expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
  expect(mutate).toHaveBeenCalledWith(
    { id: 'community', action: 'enable' },
    expect.any(Object),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'More actions for Community' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove source' }));
  expect(mutate).toHaveBeenLastCalledWith(
    { id: 'community', action: 'remove' },
    expect.any(Object),
  );
});

test('#4521: a source the managed policy refuses shows why and cannot be enabled', () => {
  extraSources.push({
    id: 'unapproved',
    kind: 'skills',
    displayName: 'Unapproved folder',
    origin: 'user',
    location: '/team/skills',
    enabled: false,
    status: 'disabled',
    managedDenial:
      "Acme's policy manages this marketplace: it is turned off. Contact your administrator for help.",
  });
  render(<MarketplaceSources selected="all" onSelect={select} />);
  const card = screen
    .getByText('Unapproved folder', { selector: 'strong' })
    .closest('article') as HTMLElement;
  expect(card.textContent).toContain(
    "Acme's policy manages this marketplace: it is turned off.",
  );
  const enable = Array.from(card.querySelectorAll('button')).find(
    (button) => button.textContent === 'Enable',
  );
  expect(enable).toBeDefined();
  expect((enable as HTMLButtonElement).disabled).toBe(true);
  // The ordinary disabled source stays enable-able.
  const community = screen
    .getByText('Community', { selector: 'strong' })
    .closest('article') as HTMLElement;
  const enableCommunity = Array.from(community.querySelectorAll('button')).find(
    (button) => button.textContent === 'Enable',
  ) as HTMLButtonElement;
  expect(enableCommunity.disabled).toBe(false);
});

test('a kind the managed policy refuses is marked on that kind, not on the whole source', () => {
  extraSources.push({
    ...hillClimb,
    id: 'partly',
    displayName: 'Partly refused',
    detection: {
      ...hillClimb.detection,
      kinds: [
        {
          kind: 'skills',
          count: 1,
          via: 'skill-md',
          installable: true,
          managedDenial:
            "Acme's policy manages skills from marketplaces, because they cannot be signed.",
        },
        {
          kind: 'plugins',
          count: 3,
          via: 'station-manifest',
          installable: true,
        },
      ],
    },
  });
  render(<MarketplaceSources selected="all" onSelect={select} />);
  const card = screen
    .getByText('Partly refused', { selector: 'strong' })
    .closest('article') as HTMLElement;
  const items = within(card).getAllByRole('listitem');
  expect(items.map((item) => item.textContent)).toEqual([
    '1 skill · blocked by policy',
    '3 plugins',
  ]);
  expect(items[0]!.getAttribute('title')).toContain('cannot be signed');
});
