// @vitest-environment jsdom

import type {
  ConnectionFailureReason,
  ConnectionStatus,
} from '@kontourai/station-connect';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDockMobileConnection } from '../components/chat-dock/ChatDockMobileConnection';
import { StationDetailsHost } from '../components/notifications/StationConditions';
import { bannerStore } from '../contexts/banner-store';

const connectionStatus = {
  status: 'connected' as ConnectionStatus,
  reason: null as ConnectionFailureReason | null,
  checking: false,
  failureStreak: 0,
  blocked: false,
  failureWindows: [],
  recheck: vi.fn(),
};
let activeConnection: { id: string; name: string; url: string } | null = null;

vi.mock('@kontourai/station-connect', async (importOriginal) => {
  // The real indicator derivation, labels and dot are kept — only the health
  // coordinator is replaced, so these tests exercise the shipped mapping from
  // a failure reason to what the reader sees and where a tap goes.
  const actual =
    await importOriginal<typeof import('@kontourai/station-connect')>();
  return {
    ...actual,
    useConnectionStatus: () => connectionStatus,
    // `usePendingPairingApproval` reads real (empty, per-file jsdom)
    // localStorage and stays null unless a test explicitly seeds a record.
    useConnections: () => ({
      activeConnection,
      connections: [],
      apiBase: 'http://station.test',
    }),
  };
});

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

vi.mock('../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  probeServerConnection: vi.fn(),
}));

beforeEach(() => {
  bannerStore.reset();
  activeConnection = null;
  connectionStatus.status = 'connected';
  connectionStatus.reason = null;
  connectionStatus.failureStreak = 0;
  connectionStatus.recheck.mockClear();
});

/**
 * archive#3297 — the state that needs a decision, on the surface where the
 * decision is needed, distinguishable without hover and without colour.
 */
describe('ChatDockMobileConnection', () => {
  it('marks a rejected credential by shape and word, not by colour', () => {
    connectionStatus.status = 'error';
    connectionStatus.reason = 'authentication-failed';

    render(<ChatDockMobileConnection />);

    const button = screen.getByTestId('chat-dock-mobile-connection');
    expect(button.dataset.connectionState).toBe('needs-credential');
    // Channel 1: a visible word. Survives a colour-blind reader.
    expect(button.textContent).toContain('Pair');
    // Channel 2: the accessible name, which also names the action.
    expect(button.getAttribute('aria-label')).toBe(
      'Pair this device again · Station',
    );
    // Channel 3: a different mark, not a recoloured dot.
    expect(button.querySelector('svg path')).not.toBeNull();
    // Channel 4: the amber attention background (archive#4512 —
    // all three attention states carry it, not needs-credential alone).
    expect(button.className).toContain('chat-dock__mobile-conn--attention');
  });

  /**
   * archive#4512 — `needs-repair` (identity-mismatch) gets the
   * same treatment as `needs-credential`: short word, enlarged triangle,
   * attention background, and a tap that goes straight to the remedy rather
   * than spending a recheck that can only fail again (aligned with the
   * toolbar chip's own exclusion, `HeaderActions.test.tsx`).
   */
  it('marks an identity mismatch with its own short word and the repair shape', () => {
    connectionStatus.status = 'error';
    connectionStatus.reason = 'identity-mismatch';

    render(<ChatDockMobileConnection />);

    const button = screen.getByTestId('chat-dock-mobile-connection');
    expect(button.dataset.connectionState).toBe('needs-repair');
    expect(button.textContent).toBe('Re-pair');
    expect(button.textContent).not.toContain('Needs re-pairing');
    expect(button.querySelector('svg path')).not.toBeNull();
    expect(button.className).toContain('chat-dock__mobile-conn--attention');
  });

  it('marks a pending approval as waiting, not broken', () => {
    connectionStatus.status = 'error';
    connectionStatus.reason = 'awaiting-approval';

    render(<ChatDockMobileConnection />);

    const button = screen.getByTestId('chat-dock-mobile-connection');
    expect(button.dataset.connectionState).toBe('awaiting-approval');
    expect(button.textContent).toBe('Waiting');
    expect(button.className).toContain('chat-dock__mobile-conn--attention');
    // The ordinary circle, not the enlarged repair triangle.
    expect(button.querySelector('svg')).toBeNull();
  });

  it('does not mark an ordinary reconnect as a credential problem', () => {
    connectionStatus.status = 'error';
    connectionStatus.reason = 'unreachable';

    render(<ChatDockMobileConnection />);

    const button = screen.getByTestId('chat-dock-mobile-connection');
    expect(button.dataset.connectionState).toBe('error');
    expect(button.textContent).not.toContain('Pair');
    expect(button.querySelector('svg')).toBeNull();
  });

  // station#2327: the dock hands the coordinator's streak to the indicator,
  // so a Station busy for about a minute stops reading as merely busy.
  it('shows a Station busy past the outage streak as an error, not busy', () => {
    connectionStatus.status = 'error';
    connectionStatus.reason = 'busy';
    connectionStatus.failureStreak = 6;
    const { unmount } = render(<ChatDockMobileConnection />);
    expect(
      screen.getByTestId('chat-dock-mobile-connection').dataset.connectionState,
    ).toBe('busy');
    unmount();

    connectionStatus.failureStreak = 7;
    render(<ChatDockMobileConnection />);
    expect(
      screen.getByTestId('chat-dock-mobile-connection').dataset.connectionState,
    ).toBe('error');
  });

  it('stays present and quiet while the connection is healthy', () => {
    render(<ChatDockMobileConnection />);

    const button = screen.getByTestId('chat-dock-mobile-connection');
    expect(button.dataset.connectionState).toBe('connected');
    expect(button.textContent).toBe('Station');
    expect(button.getAttribute('aria-label')).toContain('Connected');
    expect(button.getAttribute('aria-label')).toContain('Station');
  });

  it('labels the healthy control with the active Station identity when available', () => {
    activeConnection = {
      id: 'saved-station',
      name: 'Kontour',
      url: 'https://station.test',
    };
    render(<ChatDockMobileConnection />);

    const button = screen.getByTestId('chat-dock-mobile-connection');
    expect(button.textContent).toBe('Station · Kontour');
    expect(button.getAttribute('aria-label')).toBe(
      'Manage Stations — Connected · Station · Kontour',
    );
  });

  it('shows the saved Station label and status in the expanded mobile connection sheet', () => {
    activeConnection = {
      id: 'saved-station',
      name: 'Kontour',
      url: 'https://station.test',
    };
    render(<ChatDockMobileConnection showLabel />);

    const button = screen.getByTestId('chat-dock-mobile-connection');
    expect(button.textContent).toBe('Station · Kontour · Connected');
    expect(button.className).toContain('chat-dock__mobile-conn--details');
    expect(button.getAttribute('aria-label')).toContain('Connected');
  });

  it.each([
    ['authentication-failed', false],
    ['identity-mismatch', false],
    ['awaiting-approval', true],
    ['unreachable', true],
  ] as const)(
    'opens Station details for %s and retries only when useful',
    (reason, retries) => {
      connectionStatus.status = 'error';
      connectionStatus.reason = reason;
      activeConnection = {
        id: 'saved-station',
        name: 'Kontour',
        url: 'https://station.test',
      };
      render(
        <>
          <ChatDockMobileConnection />
          <StationDetailsHost />
        </>,
      );
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByTestId('chat-dock-mobile-connection'));
      expect(
        screen.getByRole('dialog', { name: 'Station details' }),
      ).toBeTruthy();
      expect(screen.getByText('Kontour')).toBeTruthy();
      expect(connectionStatus.recheck).toHaveBeenCalledTimes(retries ? 1 : 0);
    },
  );

  /**
   * archive#4512 — WCAG 2.5.3 (Label in Name): the
   * accessible name must contain the visible label text. HeaderActions
   * (the toolbar chip) already pins this, and it holds there by
   * CONSTRUCTION — the chip's visible label and its accessible name both
   * come from the same shared wording. This bar's short vocabulary
   * (`SHORT_ACTION_LABEL`, archive#4512) diverges from
   * `connectionIndicatorLabel` — the shared function this button's
   * `aria-label` still uses — so today's three pairs hold only by
   * COINCIDENCE: each short word happens to be a case-insensitive
   * substring of its own long form ("Waiting" ⊂ "Awaiting approval",
   * "Re-pair" ⊂ "Needs re-pairing", "Pair" ⊂ "Pair this device again").
   * Renaming a short word alone (e.g. "Waiting" → "Pending") would break
   * this silently without a test naming the contract explicitly.
   */
  it.each([
    ['authentication-failed', 'Pair'],
    ['identity-mismatch', 'Re-pair'],
    ['awaiting-approval', 'Waiting'],
  ] as const)(
    'the visible label for reason %s is inside the accessible name (case-insensitively)',
    (reason, visibleLabel) => {
      connectionStatus.status = 'error';
      connectionStatus.reason = reason;

      render(<ChatDockMobileConnection />);

      const button = screen.getByTestId('chat-dock-mobile-connection');
      expect(button.textContent).toBe(visibleLabel);
      expect(button.getAttribute('aria-label')?.toLowerCase()).toContain(
        visibleLabel.toLowerCase(),
      );
    },
  );
});
