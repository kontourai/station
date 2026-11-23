/**
 * @vitest-environment jsdom
 *
 * Each remaining catalogue is a page of its own, entered from where its kind
 * is used: no tab strip joins them into one place, the page names what it
 * lists, and its eyebrow climbs back to the place that opened it.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

const header = vi.hoisted(() => ({
  last: undefined as
    | { eyebrow?: ReactNode; title?: string; subtitle?: string }
    | undefined,
}));
vi.mock('../components/page-frame', () => ({
  PageEyebrowTrail: ({
    segments,
  }: {
    segments: Array<{ label: string; onClick?: () => void }>;
  }) => (
    <>
      {segments.map((segment) => (
        <button key={segment.label} type="button" onClick={segment.onClick}>
          {segment.label}
        </button>
      ))}
    </>
  ),
  PageFrameActions: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  usePageHeader: (value: typeof header.last) => {
    header.last = value;
  },
}));

import {
  RegistryCatalog,
  type RegistryCatalogActions,
  type RegistryCatalogModel,
} from '../components/registry/RegistryCatalog';

const model = (
  activeTab: RegistryCatalogModel['activeTab'],
): RegistryCatalogModel => ({
  activeTab,
  search: '',
  message: null,
  isLoading: false,
  loadError: null,
  isCheckingInstalled: false,
  installedStatusError: null,
  available: [],
  filtered: [],
  installedIds: new Set(),
  installationOverrides: new Map(),
  selectedItem: null,
  selectedItemId: null,
  selectedInstalled: false,
  selectedActionPending: false,
  layoutPending: false,
});

function makeActions(): RegistryCatalogActions {
  return {
    setSearch: vi.fn(),
    clearMessage: vi.fn(),
    select: vi.fn(),
    runAction: vi.fn(),
    runLayoutAction: vi.fn(),
    onUseLayout: vi.fn(),
    manageSkills: vi.fn(),
    managePlugins: vi.fn(),
    openProjects: vi.fn(),
    retryInstalled: vi.fn(),
    retryCatalog: vi.fn(),
    openOwner: vi.fn(),
  };
}

describe('RegistryCatalog pages', () => {
  test.each([
    ['agents', 'Browse agents', 'Agents', '/agents', 'Search agents'],
    [
      'skills',
      'Browse skills',
      'Skills',
      '/guidance?tab=skills',
      'Search skills',
    ],
    [
      'integrations',
      'Browse tool servers',
      'Tools',
      '/customize/tools',
      'Search tool servers',
    ],
  ] as const)(
    "the %s catalogue is its own page that climbs back to %s's owner",
    (tab, title, ownerLabel, ownerPath, searchLabel) => {
      const actions = makeActions();
      render(<RegistryCatalog model={model(tab)} actions={actions} />);
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(screen.queryByRole('tab')).toBeNull();
      expect(screen.getByRole('textbox', { name: searchLabel })).toBeTruthy();
      expect(header.last?.title).toBe(title);
      const eyebrow = render(<>{header.last?.eyebrow}</>);
      fireEvent.click(eyebrow.getByRole('button', { name: ownerLabel }));
      expect(actions.openOwner).toHaveBeenCalledWith(ownerPath);
    },
  );

  test.each([
    ['layouts', 'Browse layouts'],
    ['kits', 'Browse kits'],
  ] as const)(
    'the %s catalogue names itself and has no owner to climb to',
    (tab, title) => {
      render(<RegistryCatalog model={model(tab)} actions={makeActions()} />);
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(header.last?.title).toBe(title);
      expect(header.last?.eyebrow).toBeUndefined();
    },
  );

  test('no page title or copy names the Registry', () => {
    for (const tab of [
      'agents',
      'skills',
      'integrations',
      'layouts',
      'kits',
    ] as const) {
      const view = render(
        <RegistryCatalog model={model(tab)} actions={makeActions()} />,
      );
      expect(`${header.last?.title} ${header.last?.subtitle}`).not.toMatch(
        /registry|integration/i,
      );
      expect(view.container.textContent).not.toMatch(/registry/i);
      view.unmount();
    }
  });
});
