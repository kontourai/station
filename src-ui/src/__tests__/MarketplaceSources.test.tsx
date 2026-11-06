/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
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

test('adds the selected supported adapter with the entered location and name', () => {
  render(<MarketplaceSources selected="all" onSelect={select} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add marketplace' }));
  fireEvent.change(screen.getByLabelText('Marketplace name'), {
    target: { value: 'Engineering workflows' },
  });
  fireEvent.change(screen.getByLabelText('Repository URL'), {
    target: { value: 'https://github.com/mattpocock/skills' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect marketplace' }));
  expect(mutate).toHaveBeenCalledWith(
    {
      action: 'add',
      source: {
        displayName: 'Engineering workflows',
        adapter: 'github',
        location: 'https://github.com/mattpocock/skills',
      },
    },
    expect.any(Object),
  );
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
  fireEvent.click(screen.getByText('Manage connected marketplaces'));
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
    .getByText('Unapproved folder')
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
    .getByText('Community')
    .closest('article') as HTMLElement;
  const enableCommunity = Array.from(community.querySelectorAll('button')).find(
    (button) => button.textContent === 'Enable',
  ) as HTMLButtonElement;
  expect(enableCommunity.disabled).toBe(false);
});
