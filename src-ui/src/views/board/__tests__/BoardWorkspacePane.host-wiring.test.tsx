/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The CALL SITE, not the adapter (archive#4201).
 *
 * `inProcessPaneHost.test.tsx` proves the adapter works when a harness hands
 * it its own props. That cannot catch the mounter wiring it wrongly, and the
 * confirm path has exactly one production call site — `BoardWorkspacePane`
 * rendering `{confirmChrome}` next to the pane. Delete that one expression
 * and every other test in the repo still passes, while the Board's
 * consent-gated intents become permanently unanswerable in production: the
 * promise never settles and no dialog ever appears. A silent hang, not an
 * error.
 *
 * Before the pane refit this was structurally impossible — the pane rendered
 * its own modal. Lifting the chrome to the mounter is what created a wire
 * that can be cut, so these tests pin it.
 *
 * Note on why this drives `host.confirm` directly rather than a real intent:
 * the installed `@kontourai/console-ui`'s `BoardView` emits exactly one
 * intent (`boardCardSelectIntent`) — verified against `dist-lib/BoardView.js`
 * — so no consent-required intent can be raised through the real UI yet. The
 * host seam is the honest place to drive it from.
 */

const hoisted = vi.hoisted(() => ({
  navigate: vi.fn(),
  /** Set by the mocked pane to whatever host the mounter handed it. */
  capturedHost: null as { confirm: (r: unknown) => Promise<string> } | null,
}));

vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: hoisted.navigate }),
}));
vi.mock('../../../contexts/ConfigContext', () => ({ useConfig: () => ({}) }));
vi.mock('../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));

vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: vi.fn(),
  useOperatingStateQuery: () => ({
    data: { processes: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useBoardAvailabilityQuery: () => ({
    data: { hasBuilderRun: true },
    isLoading: false,
  }),
  useProjectsQuery: () => ({
    data: [{ id: 'demo-id', slug: 'demo', name: 'Demo project' }],
    isLoading: false,
    isError: false,
  }),
  useProjectLayoutsQuery: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
  useConsoleBoardIntentMutation: () => ({ mutate: vi.fn() }),
}));

// Only the packaged surface is replaced. The route host and the canonical
// occurrence check stay REAL, so the host still has to travel the whole
// production path to reach this stand-in.
vi.mock('@kontourai/station-board-pane', () => ({
  ConsoleBoardPane: ({
    host,
  }: {
    host: { confirm: (r: unknown) => Promise<string> };
  }) => {
    hoisted.capturedHost = host;
    return <div data-testid="board-pane-stand-in" />;
  },
}));

import { ConsoleBoardView } from '../../ConsoleBoardView';

describe('BoardWorkspacePane host wiring', () => {
  beforeEach(() => {
    hoisted.navigate.mockClear();
    hoisted.capturedHost = null;
  });

  test('the mounter renders the host confirm chrome, so a pane confirm reaches a real dialog', async () => {
    render(<ConsoleBoardView projectSlug="demo" />);
    expect(screen.getByTestId('board-pane-stand-in')).toBeTruthy();

    const host = hoisted.capturedHost;
    if (!host) throw new Error('the mounter handed the pane no host');

    let decision: Promise<string> | null = null;
    // Exactly what ConsoleBoardPane does on a `consent-required` result.
    decision = host.confirm({
      title: 'Confirm action',
      message: 'Proceed with "restart"?',
    });

    // If `{confirmChrome}` is not rendered by the mounter, there is no dialog
    // and this promise can never settle.
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Proceed with "restart"?');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(decision).resolves.toBe('confirmed');
  });

  test('dismissing the dialog resolves cancelled through the same wire', async () => {
    render(<ConsoleBoardView projectSlug="demo" />);
    const host = hoisted.capturedHost;
    if (!host) throw new Error('the mounter handed the pane no host');

    const decision = host.confirm({
      title: 'Confirm action',
      message: 'Sure?',
    });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(decision).resolves.toBe('cancelled');
  });
});
