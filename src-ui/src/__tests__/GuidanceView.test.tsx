/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const navigate = vi.fn();
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('../views/SkillsView', () => ({
  SkillsView: ({ filter }: { filter?: string }) => (
    <div>Skills body{filter ? ` (${filter})` : ''}</div>
  ),
}));
vi.mock('../views/CommandsView', () => ({
  CommandsView: () => <div>Commands body</div>,
}));

import { PageFrame } from '../components/page-frame';
import { GuidanceView } from '../views/GuidanceView';

describe('GuidanceView', () => {
  beforeEach(() => {
    navigate.mockReset();
    sessionStorage.clear();
  });

  // ONE authored concept (Skills) and one runtime view (Commands). There is no
  // Playbooks tab, and nothing resolves to one.
  test('offers exactly the Skills and Commands tabs', () => {
    render(<GuidanceView route={{ type: 'guidance', tab: 'skills' }} />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Skills',
      'Commands',
    ]);
    expect(screen.getByText('Skills body')).toBeTruthy();
  });

  test('renders the URL-selected peer tab and writes it to session memory', () => {
    render(<GuidanceView route={{ type: 'guidance', tab: 'commands' }} />);

    expect(screen.getByText('Commands body')).toBeTruthy();
    expect(sessionStorage.getItem('station-guidance-tab')).toBe('commands');
  });

  test('syncs the rendered tab when an explicit URL tab changes after mount', () => {
    const { rerender } = render(
      <GuidanceView route={{ type: 'guidance', tab: 'skills' }} />,
    );
    expect(screen.getByText('Skills body')).toBeTruthy();

    rerender(<GuidanceView route={{ type: 'guidance', tab: 'commands' }} />);

    expect(screen.getByText('Commands body')).toBeTruthy();
    expect(screen.queryByText('Skills body')).toBeNull();
  });

  test('uses session memory during first render when the URL has no tab', () => {
    sessionStorage.setItem('station-guidance-tab', 'commands');
    render(<GuidanceView route={{ type: 'guidance' }} />);

    expect(screen.getByText('Commands body')).toBeTruthy();
    expect(navigate).toHaveBeenCalledWith('/guidance', { tab: 'commands' });
  });

  test('switches tabs through the canonical URL and drops entity selection', () => {
    render(
      <GuidanceView
        route={{ type: 'guidance', tab: 'skills', selectedId: 'skill-one' }}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Commands' }));

    expect(screen.getByText('Commands body')).toBeTruthy();
    expect(navigate).toHaveBeenLastCalledWith('/guidance', {
      tab: 'commands',
      filter: null,
    });
  });

  test('redirects an entity alias into the matching canonical tab and selection', () => {
    render(
      <GuidanceView
        route={{
          type: 'guidance',
          tab: 'skills',
          selectedId: 'skill one',
          redirectFromAlias: true,
        }}
      />,
    );

    expect(navigate).toHaveBeenCalledWith('/guidance/skill%20one', {
      tab: 'skills',
    });
  });

  // The command-skill list is a narrowed Skills list, and the header has to say
  // so rather than claim to be the whole collection.
  test('passes the commands filter through to the Skills list', () => {
    render(
      <GuidanceView
        route={{ type: 'guidance', tab: 'skills', filter: 'commands' }}
      />,
    );

    expect(screen.getByText('Skills body (commands)')).toBeTruthy();
  });

  test('the filter never reaches Commands, which it would narrow nothing of', () => {
    render(
      <GuidanceView
        route={{ type: 'guidance', tab: 'commands', filter: 'commands' }}
      />,
    );

    expect(screen.getByText('Commands body')).toBeTruthy();
  });

  // archive#4463: the page title is
  // 'Guidance' and must not change when the tab changes — the tab strip
  // already names the section. Only the top-level nav route decides this, so
  // the tabs must not restate it as 'Skills'/'Commands' the way the retired
  // per-tab header used to.
  //
  // Fix round (test-power): the spec's fallback title must NOT equal
  // 'Guidance' — if it did, a GuidanceView that stopped publishing an
  // override entirely would still render 'Guidance' from the FALLBACK and
  // every assertion below would pass despite the view being broken. The
  // placeholder text below can only appear if GuidanceView never calls
  // `usePageHeader` with a title, which is exactly the regression these
  // tests exist to catch.
  const FALLBACK_TITLE = 'FALLBACK — must be overridden';

  describe('the page title stays "Guidance" across tabs', () => {
    function renderFramed(route: Parameters<typeof GuidanceView>[0]['route']) {
      return render(
        <PageFrame spec={{ title: FALLBACK_TITLE }} routeIdentity="guidance">
          <GuidanceView route={route} />
        </PageFrame>,
      );
    }

    test('on the Skills tab', () => {
      renderFramed({ type: 'guidance', tab: 'skills' });
      expect(
        screen.getByRole('heading', { level: 1, name: 'Guidance' }),
      ).toBeTruthy();
      expect(screen.queryByText(FALLBACK_TITLE)).toBeNull();
    });

    test('on the Commands tab', () => {
      renderFramed({ type: 'guidance', tab: 'commands' });
      expect(
        screen.getByRole('heading', { level: 1, name: 'Guidance' }),
      ).toBeTruthy();
      expect(screen.queryByText(FALLBACK_TITLE)).toBeNull();
    });

    test('switching from Skills to Commands does not retitle the page', () => {
      const { rerender } = render(
        <PageFrame spec={{ title: FALLBACK_TITLE }} routeIdentity="guidance">
          <GuidanceView route={{ type: 'guidance', tab: 'skills' }} />
        </PageFrame>,
      );
      expect(
        screen.getByRole('heading', { level: 1, name: 'Guidance' }),
      ).toBeTruthy();

      rerender(
        <PageFrame spec={{ title: FALLBACK_TITLE }} routeIdentity="guidance">
          <GuidanceView route={{ type: 'guidance', tab: 'commands' }} />
        </PageFrame>,
      );
      expect(
        screen.getByRole('heading', { level: 1, name: 'Guidance' }),
      ).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Commands' })).toBeNull();
      expect(screen.queryByText(FALLBACK_TITLE)).toBeNull();
    });

    test('no eyebrow — Guidance is a top-level nav page', () => {
      const { container } = renderFramed({ type: 'guidance', tab: 'skills' });
      expect(container.querySelector('.page__label')).toBeNull();
    });
  });
});
