// @vitest-environment jsdom

import type {
  ConnectionFailureReason,
  ConnectionStatus,
} from '@kontourai/station-connect';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDockMobileConnection } from '../components/chat-dock/ChatDockMobileConnection';

const connectionStatus = {
  status: 'connected' as ConnectionStatus,
  reason: null as ConnectionFailureReason | null,
  checking: false,
  failureStreak: 0,
  blocked: false,
  failureWindows: [],
  recheck: vi.fn(),
};

vi.mock('@kontourai/station-connect', async (importOriginal) => {
  // The real indicator derivation, labels and dot are kept — only the health
  // coordinator is replaced, so these tests exercise the shipped mapping from
  // a failure reason to what the reader sees and where a tap goes.
  const actual =
    await importOriginal<typeof import('@kontourai/station-connect')>();
  return {
    ...actual,
    useConnectionStatus: () => connectionStatus,
    // No active connection, no saved endpoint — `usePendingPairingApproval`
    // reads real (empty, per-file jsdom) localStorage and stays null unless
    // a test explicitly seeds a pending record.
    useConnections: () => ({ activeConnection: null, connections: [] }),
  };
});

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

vi.mock('../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  probeServerConnection: vi.fn(),
}));

function openedModals() {
  const opened: unknown[] = [];
  const listener = (event: Event) =>
    opened.push(event instanceof CustomEvent ? event.detail : null);
  window.addEventListener('station:open-connections-modal', listener);
  return {
    opened,
    stop: () =>
      window.removeEventListener('station:open-connections-modal', listener),
  };
}

beforeEach(() => {
  connectionStatus.status = 'connected';
  connectionStatus.reason = null;
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
    expect(button.getAttribute('aria-label')).toBe('Pair this device again');
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

  it('never recheck-taps an identity mismatch — retrying the same address proves nothing new', () => {
    connectionStatus.status = 'error';
    connectionStatus.reason = 'identity-mismatch';
    const { opened, stop } = openedModals();
    try {
      render(<ChatDockMobileConnection />);
      fireEvent.click(screen.getByTestId('chat-dock-mobile-connection'));
      expect(opened).toEqual([{ mode: 'request-access' }]);
      expect(connectionStatus.recheck).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  /**
   * archive#4512 — `awaiting-approval` reaches this bar through
   * the `reason` door archive#4512 wired directly into
   * `connectionIndicatorState` (a native `mid_authorization` refusal), not
   * only through a locally-tracked pending record. It is NOT repair-like:
   * the dot stays the ordinary 8px circle, and the tap still spends a
   * recheck — not because a recheck can complete the exchange (it cannot:
   * this device has no credential to probe with until the separate
   * pending-exchange poll finishes, `HeaderActions.tsx`'s own retraction
   * of this exact claim), but because it is harmless and the tap's real
   * job for this state is `openConnectionsModal` below, which surfaces the
   * pending exchange itself.
   */
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

  it('still recheck-taps a pending approval — harmless, and the real job is opening the sheet', () => {
    connectionStatus.status = 'error';
    connectionStatus.reason = 'awaiting-approval';
    const { opened, stop } = openedModals();
    try {
      render(<ChatDockMobileConnection />);
      fireEvent.click(screen.getByTestId('chat-dock-mobile-connection'));
      expect(connectionStatus.recheck).toHaveBeenCalledOnce();
      expect(opened).toEqual([{}]);
    } finally {
      stop();
    }
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

  it('stays present and quiet while the connection is healthy', () => {
    render(<ChatDockMobileConnection />);

    const button = screen.getByTestId('chat-dock-mobile-connection');
    expect(button.dataset.connectionState).toBe('connected');
    expect(button.textContent).toBe('');
  });

  it('opens re-pairing directly — one tap, no list to navigate', () => {
    connectionStatus.status = 'error';
    connectionStatus.reason = 'authentication-failed';
    const { opened, stop } = openedModals();
    try {
      render(<ChatDockMobileConnection />);
      fireEvent.click(screen.getByTestId('chat-dock-mobile-connection'));
      expect(opened).toEqual([{ mode: 'request-access' }]);
      // Re-probing a rejected credential can only fail again. Doing it would
      // be the same "offer a fix that cannot work" the copy avoids.
      expect(connectionStatus.recheck).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('retries immediately for a reachability failure, then opens the list', () => {
    // This is where the banner's "Try now" went when transient reachability
    // stopped bannering (archive#3297). Tapping a failing indicator
    // means "check again now"; the retry ladder's backoff can be 10s away.
    connectionStatus.status = 'error';
    connectionStatus.reason = 'unreachable';
    const { opened, stop } = openedModals();
    try {
      render(<ChatDockMobileConnection />);
      fireEvent.click(screen.getByTestId('chat-dock-mobile-connection'));
      expect(connectionStatus.recheck).toHaveBeenCalledOnce();
      expect(opened).toEqual([{}]);
    } finally {
      stop();
    }
  });

  /**
   * archive#4512 (-4) — WCAG 2.5.3 (Label in Name): the
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
