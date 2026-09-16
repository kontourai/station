/**
 * @vitest-environment jsdom
 */

/**
 * #2062 / #2082 — the Board host, smoke-tested.
 *
 * This view had no test at all, which mattered more once the command-palette
 * "New Board" entry started sending first-time users straight at it: on a
 * Station where nobody has made a Board, the palette is the only way in, and
 * this is where it lands.
 *
 * Three cases:
 *
 * 1. The view hands the Board through `layoutWorkspaceShape` — the real one,
 *    it is not stubbed — so the stored `config.tabs` arrive as the renderer's
 *    top-level `tabs` rather than the view reimplementing the translation.
 *    `LayoutRenderer` IS stubbed, so this proves the shape the renderer is
 *    handed and NOT that the real renderer accepts it; see the gap noted
 *    below.
 * 2. A 404 is reported as a missing Board rather than as a failure, and
 *    WITHOUT a retry affordance — retrying a Board that no longer exists
 *    cannot succeed, and the ordinary way a Board's URL stops resolving is
 *    the user promoting it into a project.
 * 3. A failure that is not a 404 keeps its retry — the discriminating half,
 *    without which a view that answered "Board not found" for every error
 *    would pass case 2.
 *
 * NOT COVERED (#2062 review L5): no test in this repo renders a Board through
 * the REAL `LayoutRenderer`. `LayoutView.test.tsx` stubs it too, so neither
 * host proves the renderer accepts its own input. What is true by
 * construction is that both hosts import the same renderer module and call
 * the same derivation; what is unproven is the renderer's behaviour on a
 * Board-shaped layout.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const StationHttpError = vi.hoisted(
  () =>
    class StationHttpError extends Error {
      readonly status: number;
      constructor(status: number, message?: string) {
        super(message ?? `HTTP ${status}`);
        this.name = 'StationHttpError';
        this.status = status;
      }
    },
);

const boardQuery = vi.hoisted(() => ({
  state: {
    data: undefined as unknown,
    isLoading: false,
    error: undefined as unknown,
  },
}));

vi.mock('@kontourai/station-sdk', () => ({
  FullScreenLoader: () => <div data-testid="loader" />,
  LayoutNavigationProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  StationHttpError,
  usePersonalLayoutQuery: () => ({ ...boardQuery.state, refetch: vi.fn() }),
}));

vi.mock('../../core/SDKAdapter', () => ({
  SDKAdapter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const rendered = vi.hoisted(() => ({ layout: undefined as any }));
vi.mock('../../layouts', () => ({
  LayoutRenderer: ({ layout }: { layout: unknown }) => {
    rendered.layout = layout;
    return <div data-testid="layout-renderer" />;
  },
}));

import { PersonalBoardView } from '../PersonalBoardView';

describe('PersonalBoardView (#2062, #2082)', () => {
  test('renders the Board through the shared layout renderer', () => {
    boardQuery.state = {
      data: {
        slug: 'daily',
        name: 'Daily brief',
        config: {
          tabs: [{ id: 'overview', label: 'Overview', component: 'standard' }],
        },
      },
      isLoading: false,
      error: undefined,
    };
    rendered.layout = undefined;

    render(<PersonalBoardView boardSlug="daily" />);

    expect(screen.getByTestId('layout-renderer')).toBeTruthy();
    // The stored record keeps panes under `config`; the renderer takes them at
    // the top level. Seeing them here is what says the translation ran.
    expect(rendered.layout).toMatchObject({
      slug: 'daily',
      name: 'Daily brief',
      tabs: [{ id: 'overview', label: 'Overview', component: 'standard' }],
    });
    // A Board has no project, so the host offers no global action bar and the
    // shape must not carry one — `hostOwnsGlobalActions: false` is what keeps
    // a Board's own declared actions renderable rather than dropped.
    expect(rendered.layout.actions).toBeUndefined();
  });

  test('a 404 reads as a missing Board, with no retry to offer', () => {
    boardQuery.state = {
      data: undefined,
      isLoading: false,
      error: new StationHttpError(404),
    };

    render(<PersonalBoardView boardSlug="gone" />);

    expect(screen.getByText('Board not found')).toBeTruthy();
    // Named, because it is the case a user reaches by promoting their own
    // Board into a project.
    expect(screen.getByText(/moved into a project/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  test('a failure that is not a 404 keeps its retry', () => {
    // The discriminating half: without it, a view that showed "Board not
    // found" for every error would satisfy the case above.
    boardQuery.state = {
      data: undefined,
      isLoading: false,
      error: new StationHttpError(500, 'Board storage is unavailable'),
    };

    render(<PersonalBoardView boardSlug="daily" />);

    expect(screen.getByText('Could not open this Board')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
