/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let pendingCount = 0;
let connectionStatus: 'connected' | 'connecting' | 'error' = 'connected';
let connectionReason: string | null = null;
let bundledStatus: { ownership: 'sidecar' | 'service' | 'none' } | null = null;
// archive#4512 — null unless a test arms a locally-tracked pending access
// request; `usePendingPairingApproval` is otherwise stubbed to whatever this
// holds, so the chip's derivation is exercised without a real ticking clock.
let pendingApprovalRecord: { requestKind: 'direct' | 'code' } | null = null;
const recheck = vi.fn();

/** A connection with a `lastSuccessAt` is a "real" saved Station. */
const SAVED_STATION = {
  id: 'c1',
  name: 'Default',
  lastSuccessAt: '2026-08-18T00:00:00.000Z',
  endpoints: [],
};
let savedConnections: unknown[] = [SAVED_STATION];

// Partial: the indicator derivation and labels under test are the real ones;
// only the health coordinator and the dot's pixels are replaced. The stub dot
// records the state it was handed, which is what proves the header stopped
// relying on a hover-only tooltip (archive#3297).
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionStatusDot: ({ status }: { status: string }) => (
    <span data-testid="connection-status" data-state={status} />
  ),
  useConnectionStatus: () => ({
    status: connectionStatus,
    reason: connectionReason,
    recheck,
  }),
  useConnections: () => ({
    activeConnection: savedConnections[0] ?? null,
    connections: savedConnections,
  }),
  usePendingPairingApproval: () => pendingApprovalRecord,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAttentionQuery: () => ({
    data: { items: [], pendingCount },
  }),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ supervisesBundledServer: true }),
}));

vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => bundledStatus,
}));

vi.mock('../components/notifications/NotificationHistory', () => ({
  NotificationHistory: () => null,
}));

vi.mock('../components/header/HelpMenu', () => ({
  HelpMenu: () => null,
}));

vi.mock('../components/header/OverflowMenu', () => ({
  OverflowMenu: () => null,
}));

import { HeaderActions } from '../components/header/HeaderActions';

function renderHeader(onToggleNotifications = vi.fn()) {
  render(
    <HeaderActions
      helpPrompts={[]}
      settingsShortcut="⌘,"
      showHelp={false}
      showNotifications={false}
      showOverflow={false}
      showProfileMenu={false}
      onCloseProfileMenu={vi.fn()}
      onToggleProfileMenu={vi.fn()}
      userInitials="ST"
      onCloseHelp={vi.fn()}
      onCloseNotifications={vi.fn()}
      onCloseOverflow={vi.fn()}
      onHelpPrompt={vi.fn()}
      onOpenConnections={vi.fn()}
      onOpenProfile={vi.fn()}
      onToggleHelp={vi.fn()}
      onToggleNotifications={onToggleNotifications}
      onToggleSettings={vi.fn()}
      onToggleOverflow={vi.fn()}
      onViewAllNotifications={vi.fn()}
    />,
  );
  return onToggleNotifications;
}

function renderConnButton() {
  renderHeader();
  return screen.getByRole('button', { name: /^Manage Stations/ });
}

describe('HeaderActions attention badge', () => {
  beforeEach(() => {
    pendingCount = 0;
    connectionStatus = 'connected';
    connectionReason = null;
    savedConnections = [SAVED_STATION];
    bundledStatus = null;
    pendingApprovalRecord = null;
  });

  test('exposes the projection count in the badge and accessible label', () => {
    pendingCount = 3;
    const onToggleNotifications = renderHeader();

    const notifications = screen.getByRole('button', {
      name: 'Notifications (3 need attention)',
    });
    expect(notifications.textContent).toContain('3');

    fireEvent.click(notifications);
    expect(onToggleNotifications).toHaveBeenCalledOnce();
  });

  test('does not render a badge when no session needs attention', () => {
    renderHeader();

    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  /**
   * Discovered from the DOM rather than from a list of names: the list said
   * ['Notifications', 'Ask Station for help'] and #1552 D1 moved the second into
   * the avatar's menu, which would have left this test naming a control that no
   * longer exists — or, worse, quietly checking one. The claim is about every
   * glyph-bearing control in this row, so the row is what it enumerates.
   */
  test('keeps icon-only button SVGs decorative because their buttons are named', () => {
    renderHeader();

    const glyphButtons = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '.app-toolbar__actions button',
      ),
    ].filter((button) => button.querySelector('svg'));
    // A precondition, not decoration: an empty inventory would pass the loop.
    expect(glyphButtons.length).toBeGreaterThan(1);
    for (const button of glyphButtons) {
      expect(
        button.getAttribute('aria-label'),
        `${button.className} has a glyph and no accessible name`,
      ).toBeTruthy();
      for (const svg of button.querySelectorAll('svg')) {
        expect(svg.getAttribute('aria-hidden')).toBe('true');
      }
    }
  });
});

// archive#3311 (supersedes the archive#1094 title-only pin): the connection surface
// is self-describing — connection state and identity are visible text with a
// matching accessible name, not tooltip-only metadata.
describe('HeaderActions — self-describing connection surface', () => {
  beforeEach(() => {
    pendingCount = 0;
    connectionStatus = 'connected';
    connectionReason = null;
    savedConnections = [SAVED_STATION];
    bundledStatus = null;
    pendingApprovalRecord = null;
  });

  /**
   * #1536 F: the ONE state that stopped being visible text. Connected, a
   * single known Station, no sidecar qualification — nothing here changes
   * while you work, and the chip was 203px of the row that runs out of width
   * first. The words survive in the accessible name AND the tooltip, which is
   * the only channel a dot leaves for the identity.
   */
  test('collapses the connected single-Station chip to its dot, keeping every word in the name and tooltip', () => {
    const button = renderConnButton();

    expect(button.querySelector('.app-toolbar__conn-state')).toBeNull();
    expect(button.querySelector('.app-toolbar__conn-name')).toBeNull();
    expect(button.textContent).toBe('');
    expect(button.classList).toContain('app-toolbar__conn--compact');
    // No 'Default'-name special-casing: identity is always named.
    expect(button.getAttribute('aria-label')).toBe(
      'Manage Stations — Connected · Default',
    );
    expect(button.title).toBe('Manage Stations — Connected · Default');
    // The dot is still the state channel that survives a device with no hover.
    expect(screen.getByTestId('connection-status').dataset.state).toBe(
      'connected',
    );
  });

  test('a second known Station keeps the full chip — the identity is what says which one', () => {
    savedConnections = [
      SAVED_STATION,
      { ...SAVED_STATION, id: 'c2', name: 'Laptop' },
    ];
    const button = renderConnButton();

    expect(button.classList).not.toContain('app-toolbar__conn--compact');
    expect(button.textContent).toContain('Connected');
    expect(button.textContent).toContain('Default');
  });

  test('a sidecar-qualified connection keeps the full chip — "App only" is news', () => {
    bundledStatus = { ownership: 'sidecar' };
    const button = renderConnButton();

    expect(button.classList).not.toContain('app-toolbar__conn--compact');
    expect(button.textContent).toContain('Connected');
    expect(screen.getByTestId('desktop-sidecar-indicator').textContent).toBe(
      'App only',
    );
  });

  // The one invariant that keeps this component's visible wording and
  // @kontourai/station-connect's control names from drifting apart: whatever
  // the chip shows must appear in the name a screen reader announces
  // (WCAG 2.5.3). It is also the reason `needs-credential` shows "Pair" —
  // connectionIndicatorActionLabel's own word — rather than a fifth phrase
  // invented here.
  // `connected` is deliberately absent: since #1536 F its single-Station form
  // renders NO visible label, which the test above pins on its own terms. The
  // invariant here is about the states that still show text.
  test.each([
    ['connecting', null, 'Reconnecting'],
    ['error', 'unreachable', "Can't connect"],
    ['error', 'authentication-failed', 'Pair'],
    // archive#4512: an identity mismatch is a host that answered, not one
    // that stopped answering — it gets its own remedy word, not the generic
    // "Can't connect" a genuinely unreachable host produces.
    ['error', 'identity-mismatch', 'Needs re-pairing'],
  ] as const)(
    'the visible label for %s/%s is inside the accessible name',
    (status, reason, visible) => {
      connectionStatus = status;
      connectionReason = reason;
      renderHeader();
      // By class, not by name: `needs-credential` renames the control to its
      // remedy, which is the very thing this asserts.
      const button = document.querySelector<HTMLElement>('.app-toolbar__conn');
      expect(button, '.app-toolbar__conn not rendered').not.toBeNull();
      const state = button!.querySelector('.app-toolbar__conn-state');
      expect(state?.textContent).toBe(visible);
      expect(button!.getAttribute('aria-label')).toContain(visible);
    },
  );
});

/**
 * archive#1094 put the blocked/reconnecting distinction in a `title`, noting
 * the dot could not carry it. archive#3297 moved it into the dot itself: a
 * title is a hover tooltip, and the surface where this failure is actually
 * met has no hover. These now pin the channels that survive touch.
 */
describe('HeaderActions — a rejected credential is distinguishable without hover', () => {
  beforeEach(() => {
    pendingCount = 0;
    connectionStatus = 'connected';
    connectionReason = null;
    savedConnections = [SAVED_STATION];
    bundledStatus = null;
    pendingApprovalRecord = null;
  });

  test('keeps the healthy control reachable by the name the E2E selectors key on', () => {
    renderHeader();
    // archive#3311 put the state and identity in the accessible name, so the
    // name is no longer the bare string. It is the NAME the E2E selectors key
    // on (`/^Manage Stations/`, tests/connect-modal.spec.ts), not the title —
    // and #1536 F's collapsed chip needs the tooltip for the identity its
    // visible text no longer carries, so the bare archive#3297 string is what
    // every still-labelled state keeps (see the `needs-credential` case
    // below).
    const button = screen.getByRole('button', { name: /^Manage Stations/ });
    expect(button.title).toBe('Manage Stations — Connected · Default');
    expect(screen.getByTestId('connection-status').dataset.state).toBe(
      'connected',
    );
  });

  test('a still-labelled state keeps the bare archive#3297 tooltip', () => {
    connectionStatus = 'error';
    connectionReason = 'unreachable';
    renderHeader();
    const button = document.querySelector<HTMLElement>('.app-toolbar__conn');
    // `connectionIndicatorLabel`'s own wording for the state, unchanged.
    expect(button?.title).toBe("Manage Stations — Can't connect");
  });

  test('hands the dot a distinct state, not just a different tooltip', () => {
    connectionStatus = 'error';
    connectionReason = 'authentication-failed';
    renderHeader();
    // The channel that works on a touch screen.
    expect(screen.getByTestId('connection-status').dataset.state).toBe(
      'needs-credential',
    );
    // And the accessible name names the remedy, not just the state.
    expect(
      screen.getByRole('button', { name: /^Pair this device again/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^Pair this device again/ }).title,
    ).toBe('Pair this device again');
  });

  test('does not claim a credential problem for an ordinary reconnect', () => {
    connectionStatus = 'error';
    connectionReason = 'unreachable';
    renderHeader();
    expect(screen.getByTestId('connection-status').dataset.state).toBe('error');
    expect(
      screen.queryByRole('button', { name: /^Pair this device again/ }),
    ).toBeNull();
  });

  test('re-probes on tap for a recoverable failure, and never for a blocked credential', () => {
    connectionStatus = 'error';
    connectionReason = 'unreachable';
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: /^Manage Stations/ }));
    expect(recheck).toHaveBeenCalledTimes(1);

    recheck.mockClear();
    cleanup();
    connectionReason = 'authentication-failed';
    renderHeader();
    fireEvent.click(
      screen.getByRole('button', { name: /^Pair this device again/ }),
    );
    expect(recheck).not.toHaveBeenCalled();
  });
});

/**
 * archive#4512 — a pending access request against a REACHABLE host used to
 * read as "Can't connect" (red): the device has no credential yet, so every
 * health probe 401s exactly like a dead host's would. The chip now consumes
 * the same locally-tracked pending-exchange fact `ConnectionBannerSource`
 * already reads for the banner layer (`usePendingPairingApproval`).
 */
describe('HeaderActions — a pending access request reads as waiting, not broken', () => {
  beforeEach(() => {
    pendingCount = 0;
    connectionStatus = 'error';
    connectionReason = 'authentication-failed';
    savedConnections = [SAVED_STATION];
    bundledStatus = null;
    pendingApprovalRecord = { requestKind: 'direct' };
    recheck.mockClear();
  });

  test('shows Awaiting approval, not Can’t connect, while a request is open', () => {
    renderHeader();
    const button = document.querySelector<HTMLElement>('.app-toolbar__conn');
    expect(button, '.app-toolbar__conn not rendered').not.toBeNull();
    expect(button!.className).toContain('app-toolbar__conn--awaiting-approval');
    expect(button!.textContent).toContain('Awaiting approval');
    expect(button!.textContent).not.toContain("Can't connect");
    expect(screen.getByTestId('connection-status').dataset.state).toBe(
      'awaiting-approval',
    );
    expect(button!.getAttribute('aria-label')).toContain('Awaiting approval');
  });

  // Precedence (archive#4512): the pending-request fact is independent of
  // `reason` and wins even over identity-mismatch, mirroring
  // `ConnectionBannerSource`'s own `!pendingApproval` gate — while a request
  // is open, nothing else this endpoint's probes say is more true than
  // "still waiting".
  test('outranks an identity mismatch while the same request is open', () => {
    connectionReason = 'identity-mismatch';
    const button = renderConnButton();
    expect(button.textContent).toContain('Awaiting approval');
    expect(button.textContent).not.toContain('Needs re-pairing');
  });

  test('re-probes on tap: a pending request can genuinely resolve on a check', () => {
    renderHeader();
    fireEvent.click(
      screen.getByRole('button', {
        name: /^Manage Stations — Awaiting approval/,
      }),
    );
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  test('falls back to the underlying reason once the local record expires', () => {
    // Once the request is no longer open, "still waiting" is no longer the
    // most honest read — the coordinator's own classification of this
    // (unresolved) authentication failure takes back over.
    pendingApprovalRecord = null;
    renderHeader();
    // `needs-credential` renames the control to its remedy ("Pair this
    // device again"), so it no longer starts with "Manage Stations" —
    // `renderConnButton` would not find it.
    const button = screen.getByRole('button', {
      name: /^Pair this device again/,
    });
    expect(button.textContent).not.toContain('Awaiting approval');
    expect(button.className).not.toContain(
      'app-toolbar__conn--awaiting-approval',
    );
    expect(button.textContent).toContain('Pair');
    expect(button.className).toContain('app-toolbar__conn--needs-credential');
  });
});

/**
 * archive#4512 — an identity mismatch (a reset/reinstalled host, or a
 * different machine now answering at the same address) is not a dead host:
 * retrying cannot fix it, so it gets its own remedy word and its tap must
 * not spend a recheck that can only fail again.
 */
describe('HeaderActions — an identity mismatch is distinguished from a dead host', () => {
  beforeEach(() => {
    pendingCount = 0;
    connectionStatus = 'error';
    connectionReason = 'identity-mismatch';
    savedConnections = [SAVED_STATION];
    bundledStatus = null;
    pendingApprovalRecord = null;
    recheck.mockClear();
  });

  test('shows Needs re-pairing and a distinct dot state', () => {
    const button = renderConnButton();
    expect(button.className).toContain('app-toolbar__conn--needs-repair');
    expect(button.textContent).toContain('Needs re-pairing');
    expect(screen.getByTestId('connection-status').dataset.state).toBe(
      'needs-repair',
    );
  });

  test('never recheck-taps a mismatch — retrying the same address proves nothing new', () => {
    renderHeader();
    fireEvent.click(
      screen.getByRole('button', {
        name: /^Manage Stations — Needs re-pairing/,
      }),
    );
    expect(recheck).not.toHaveBeenCalled();
  });
});

describe('HeaderActions — desktop sidecar state', () => {
  beforeEach(() => {
    pendingCount = 0;
    connectionStatus = 'connected';
    connectionReason = null;
    savedConnections = [SAVED_STATION];
    bundledStatus = null;
    pendingApprovalRecord = null;
  });

  test('qualifies the connection identity with App only rather than replacing it', () => {
    // The sidecar describes the locally supervised bundled server; the
    // identity names the Station the connection points at. They are
    // independent facts, and a desktop app supervising its sidecar while
    // pointed at a remote Station must not render the sidecar's name in
    // place of that Station's.
    savedConnections = [{ ...SAVED_STATION, name: 'Kontour' }];
    bundledStatus = { ownership: 'sidecar' };
    const button = renderConnButton();
    expect(screen.getByTestId('desktop-sidecar-indicator').textContent).toBe(
      'App only',
    );
    expect(button.textContent).toContain('Kontour');
    expect(button.getAttribute('aria-label')).toBe(
      'Manage Stations — Connected · Kontour · App only',
    );
    // The button's own title is archive#3297's control name; the sidecar's
    // lifetime explanation moved onto the note it describes.
    expect(button.title).toBe('Manage Stations');
    expect(screen.getByTestId('desktop-sidecar-indicator').title).toBe(
      'Runs while the Station app is open',
    );
  });

  test('does not show the App only indicator for an attached service', () => {
    bundledStatus = { ownership: 'service' };
    renderHeader();
    expect(screen.queryByTestId('desktop-sidecar-indicator')).toBeNull();
  });
});

// archive#3311: `idle` was unreachable — the health coordinator only
// ever reports connecting/connected/error — while a comment and the mobile
// CSS both claimed it meant "no Station connected yet". It now derives from
// the SAME predicate that renders MobileConnectionBanner, so a first run
// reads honestly instead of announcing a reconnection that never happened.
describe('HeaderActions — a device with no Station saved', () => {
  beforeEach(() => {
    pendingCount = 0;
    connectionStatus = 'connecting';
    connectionReason = null;
    savedConnections = [];
    bundledStatus = null;
    pendingApprovalRecord = null;
  });

  test('says No Station instead of Reconnecting, and carries the idle modifier', () => {
    const button = renderConnButton();
    expect(button.textContent).toContain('No Station');
    expect(button.textContent).not.toContain('Reconnecting');
    expect(button.className).toContain('app-toolbar__conn--idle');
    expect(button.getAttribute('aria-label')).toBe(
      'Manage Stations — No Station',
    );
    expect(screen.getByTestId('connection-status').dataset.state).toBe('idle');
  });

  test('an injected host connection is not a saved Station', () => {
    savedConnections = [
      { id: 'cli-base', name: 'CLI', endpoints: [], lastSuccessAt: 'x' },
    ];
    expect(renderConnButton().textContent).toContain('No Station');
  });

  test('a saved Station that is mid-probe genuinely is reconnecting', () => {
    savedConnections = [SAVED_STATION];
    expect(renderConnButton().textContent).toContain('Reconnecting');
  });
});

// `hasRealSavedConnection` deliberately excludes injected host
// connections (`cli-base`, `managed-loopback`), and those CAN be the active
// one — ConnectionStore prefers an injected connection with a URL, and an
// injected connection can never earn a `lastSuccessAt`. Consulting the
// predicate FIRST therefore rendered a terminal auth failure as a calm
// "No Station", and printed an identity the state denied.
describe('HeaderActions — connection state precedence', () => {
  const INJECTED_ACTIVE = {
    id: 'managed-loopback',
    name: 'Station on this device',
    endpoints: [],
  };

  beforeEach(() => {
    pendingCount = 0;
    connectionStatus = 'connecting';
    connectionReason = null;
    savedConnections = [INJECTED_ACTIVE];
    bundledStatus = { ownership: 'sidecar' };
    pendingApprovalRecord = null;
  });

  test('needs-credential outranks idle even with no saved Station', () => {
    connectionStatus = 'error';
    connectionReason = 'authentication-failed';
    renderHeader();
    const button = screen.getByRole('button', {
      name: /^Pair this device again/,
    });
    expect(button.textContent).toContain('Pair');
    expect(button.textContent).not.toContain('No Station');
    expect(button.className).toContain('app-toolbar__conn--needs-credential');
  });

  test('error outranks idle even with no saved Station', () => {
    connectionStatus = 'error';
    const button = renderConnButton();
    expect(button.textContent).toContain("Can't connect");
    expect(button.className).toContain('app-toolbar__conn--error');
  });

  test('connected outranks idle, and names the connection it reached', () => {
    connectionStatus = 'connected';
    const button = renderConnButton();
    expect(button.textContent).toContain('Connected');
    expect(button.textContent).toContain('Station on this device');
    expect(button.className).toContain('app-toolbar__conn--connected');
  });

  test('idle prints no identity for the state to contradict', () => {
    const button = renderConnButton();
    expect(button.textContent).toContain('No Station');
    // Neither the connection's name nor the sidecar lifetime note: both would
    // qualify a Station the sentence beside them says does not exist.
    expect(button.textContent).not.toContain('Station on this device');
    expect(screen.queryByTestId('desktop-sidecar-indicator')).toBeNull();
    expect(button.getAttribute('aria-label')).toBe(
      'Manage Stations — No Station',
    );
    // Not connectionIndicatorLabel('idle') ("Not running"), which describes a
    // supervised local server that was stopped, not a device with no Station.
    expect(button.title).toBe('Manage Stations — No Station');
  });
});
