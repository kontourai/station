import {
  type ConnectionIndicatorState,
  ConnectionStatusDot,
  connectionIndicatorActionLabel,
  connectionIndicatorLabel,
  connectionIndicatorState,
  useConnectionStatus,
  useConnections,
  usePendingPairingApproval,
} from '@kontourai/station-connect';
import { useAttentionQuery } from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { APP_DESTINATION_REGISTRY } from '../../app-shell/destination-registry';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { hasRealSavedConnection } from '../../lib/saved-connections';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { useBundledServerStatus } from '../../platform/useBundledServerStatus';
import { SettingsGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import type { HeaderHelpPrompt } from './utils';

/**
 * The notification dropdown renders nothing until it is opened (its own first
 * statement is `if (!isOpen) return null`), so keeping it in the entry chunk
 * bought a panel the header only ever shows on click. Deferring it moves the
 * panel — and the notification/attention row components it pulls — into an
 * on-demand chunk. See archive#2751 for the entry-budget measurement.
 *
 * It stays mounted after the first open (`hasOpenedNotifications` below) rather
 * than unmounting on close, because closing is NOT equivalent to unmounting
 * here. `NotificationHistory` holds dismissals for a 4-second undo window in
 * `setTimeout`s owned by the component, and its unmount effect deliberately
 * flushes them — an app-teardown safety net so a pending dismissal is not lost.
 * Unmounting on close would promote that flush onto the *primary* close path:
 * dismiss the wrong row, click outside, and the dismissal commits instantly
 * with no Undo left to find on reopen — exactly the mis-tap the undo window
 * exists to protect. Keeping it mounted preserves the timer's lifetime while
 * still keeping the chunk out of the entry graph, which is where the saving
 * actually comes from.
 */
const loadNotificationHistory = () =>
  import('../notifications/NotificationHistory').then((m) => ({
    default: m.NotificationHistory,
  }));

/**
 * Both header dropdowns are the same shape as the notification panel above:
 * each opens with `if (!isOpen) return null`, and its only pre-return hook
 * (`useMenuFocus`) already returns early while closed. Mounting them on open
 * keeps the rendered output identical and keeps their markup out of the
 * first-paint chunk.
 */
const loadHelpMenu = () =>
  import('./HelpMenu').then((m) => ({ default: m.HelpMenu }));
const loadOverflowMenu = () =>
  import('./OverflowMenu').then((m) => ({ default: m.OverflowMenu }));

interface HeaderActionsProps {
  currentViewType?: string;
  helpPrompts: HeaderHelpPrompt[];
  settingsShortcut: string;
  showHelp: boolean;
  showNotifications: boolean;
  showOverflow: boolean;
  userInitials: string;
  onCloseHelp: () => void;
  onCloseNotifications: () => void;
  onCloseOverflow: () => void;
  onHelpPrompt: (prompt: string) => void;
  onOpenConnections: () => void;
  onOpenProfile: () => void;
  onToggleHelp: () => void;
  onToggleNotifications: () => void;
  onToggleSettings: () => void;
  onToggleOverflow: () => void;
  onViewAllNotifications: () => void;
}

export function HeaderActions({
  currentViewType,
  helpPrompts,
  settingsShortcut,
  showHelp,
  showNotifications,
  showOverflow,
  userInitials,
  onCloseHelp,
  onCloseNotifications,
  onCloseOverflow,
  onHelpPrompt,
  onOpenConnections,
  onOpenProfile,
  onToggleHelp,
  onToggleNotifications,
  onToggleSettings,
  onToggleOverflow,
  onViewAllNotifications,
}: HeaderActionsProps) {
  const { activeConnection, connections } = useConnections();
  const { apiBase } = useApiBase();
  const profile = usePlatformProfile();
  const bundledStatus = useBundledServerStatus(profile.supervisesBundledServer);
  const {
    status: connStatus,
    reason: connReason,
    recheck: connRecheck,
  } = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  // archive#4512 — the same locally-tracked pending-request fact
  // `ConnectionBannerSource` already reads for the banner layer, so a pending
  // access request against a REACHABLE host reads as "Awaiting approval"
  // here too instead of the generic "Can't connect" a device with no
  // credential yet otherwise produces (every probe 401s until it is
  // approved). The hook decides its own tick from whether a
  // pending record exists, not from `connStatus`.
  const pendingApproval = usePendingPairingApproval(
    activeConnection?.url ?? apiBase,
  );
  const connIndicator = connectionIndicatorState({
    status: connStatus,
    reason: connReason,
    pendingApproval: pendingApproval !== null,
  });
  const { data: attention } = useAttentionQuery(apiBase);
  const notificationDestination = APP_DESTINATION_REGISTRY.get('notifications');
  if (!notificationDestination) {
    throw new Error('Notifications destination is not registered');
  }
  const notificationLabel = notificationDestination.label();
  const notificationBadge = notificationDestination.badge?.({
    attentionCount: attention?.pendingCount ?? 0,
  });
  // Sticky: once the panel has been opened it stays mounted for the rest of the
  // session, so closing it never runs its pending-dismiss unmount flush.
  const [hasOpenedNotifications, setHasOpenedNotifications] = useState(false);
  useEffect(() => {
    if (showNotifications) setHasOpenedNotifications(true);
  }, [showNotifications]);

  // archive#3311: the connection surface is self-describing — status dot +
  // state as visible text + labeled identity — instead of an unlabeled name
  // that vanished when it happened to be 'Default' and a tooltip-only
  // "App only". Blocked/reconnecting are text, not title-only (archive#1094).
  //
  // `connectionIndicatorState` (archive#3297) owns every state the health
  // coordinator can actually produce, including `needs-credential`, which it
  // derives from the observed failure REASON rather than the coordinator's
  // `blocked` scheduling flag. This component adds exactly one state on top of
  // it, and only ever by downgrading `connecting`.
  //
  // `hasStation` is the SAME predicate that decides whether the mobile
  // "No Station connected" banner renders (OnboardingGate). Without it the
  // first-run device reads the coordinator's opening `connecting` and
  // announces "Reconnecting" on a device that has never connected to
  // anything, beside a banner saying the opposite. It is also what makes
  // `idle` a state this chip actually reaches: `useConnectionStatus` only ever
  // reports connecting/connected/error, so nothing else here can produce it.
  //
  // PRECEDENCE: `hasStation` is the LAST thing consulted, not
  // the first. It deliberately excludes injected host connections (`cli-base`,
  // `managed-loopback`), which can be the ACTIVE connection and can never earn
  // a `lastSuccessAt` — so leading with it rendered a terminal auth failure,
  // the one state demanding user action, as a calm "No Station", and printed
  // an identity the state denied ("No Station · Station on this device").
  // Anything the coordinator observed — needs-credential, error, connected —
  // passes through untouched.
  const hasStation = hasRealSavedConnection(connections);
  const connState: ConnectionIndicatorState =
    connIndicator === 'connecting' && !hasStation ? 'idle' : connIndicator;
  // The short visible text beside the dot. `needs-credential` takes
  // archive#3297's own `connectionIndicatorActionLabel` — the short visible
  // word it defines for exactly this ("surfaces with room for one"), so this
  // chip and ChatDockMobileConnection say the same thing. The rest restate
  // `connectionIndicatorLabel`'s wording, which keeps its state phrases
  // module-private; `HeaderActions.test.tsx` asserts every visible label is
  // contained in the accessible name, which is what keeps the two from
  // drifting apart. `idle` is this component's own state: upstream's word for
  // it, "Not running", describes a supervised local server that was
  // deliberately stopped, not a device that never had a Station.
  const connStateLabel: string =
    connectionIndicatorActionLabel(connState) ??
    {
      idle: 'No Station',
      connected: 'Connected',
      connecting: 'Reconnecting',
      error: "Can't connect",
      'needs-credential': 'Pair',
      // Unreachable in practice — `connectionIndicatorActionLabel` never
      // returns null for these two — kept only so this map stays total over
      // `ConnectionIndicatorState` rather than an unsafe cast.
      'awaiting-approval': 'Awaiting approval',
      'needs-repair': 'Needs re-pairing',
    }[connState];
  // The sidecar fact is about the locally supervised bundled server, not about
  // which Station the active connection points at — they are independent, so a
  // desktop app supervising its sidecar while pointed at a REMOTE station used
  // to render "Connected · App only", naming the wrong endpoint on the one
  // surface whose job is to say which Station this is. It qualifies the
  // identity now instead of replacing it.
  //
  // Both are suppressed in `idle`: that state asserts there is no Station, so
  // naming one — or qualifying its lifetime — beside it contradicts the very
  // sentence next to it.
  const isIdle = connState === 'idle';
  const isSidecar = !isIdle && bundledStatus?.ownership === 'sidecar';
  const connIdentity = isIdle ? undefined : activeConnection?.name;
  // The accessible name must contain the visible text (WCAG 2.5.3), and since
  // archive#3311 the visible text is state + identity. `connectionIndicatorLabel`
  // already satisfies that for the states it words — including
  // `needs-credential`, where it deliberately names the REMEDY ("Pair this
  // device again") because the control does something different there. The two
  // it cannot: `connected`, which it collapses to the bare 'Manage Stations'
  // (correct for a tooltip, but it would drop the visible "Connected"), and
  // `idle`, which is this component's state. The bare string stays the `title`
  // (archive#3297's contract and the pointer affordance), so nothing keying on
  // the tooltip changes.
  //
  // `idle` also takes the composed form for the TITLE: upstream words that
  // state "Not running", which describes a stopped supervised server.
  const connTitle =
    connState === 'idle'
      ? `Manage Stations — ${connStateLabel}`
      : connectionIndicatorLabel(connState);
  const connAccessibleName = [
    connState === 'connected'
      ? `Manage Stations — ${connStateLabel}`
      : connTitle,
    connIdentity,
    isSidecar ? 'App only' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // #1536 F: the steady state — connected, one Station, nothing qualifying it
  // — is a 203px chip restating a fact that never changes while you work, in
  // the row that runs out of width first. It collapses to its status dot
  // there and keeps every word in the accessible name and the tooltip.
  //
  // Four conditions, and each one is a thing the chip would otherwise be the
  // only place to read:
  //   `connected`: every other state is NEWS. `connectionIndicatorState` owns
  //     that distinction, so this adds no second opinion about health.
  //   one Station known: with two, the identity is what tells you WHICH one
  //     you are talking to, and a dot cannot carry it. `connections.length`,
  //     not `hasRealSavedConnection`, is the right count here — an injected
  //     host connection (`cli-base`, `managed-loopback`) is not a "real saved
  //     host" but IS a second thing this chip could be pointed at.
  //   not a sidecar: "App only" qualifies the server's lifetime — news the
  //     user has no other route to on this surface.
  //   an identity to fall back on: the collapsed form promises "Connected ·
  //     <name>" in its tooltip and accessible name, so it is only taken when
  //     there is a name to put there.
  // The mobile breakpoint already rendered `connected` dot-only (chat.css,
  // archive#3311); this is the same rule, now that the desktop row has the
  // same problem.
  const compactConn =
    connState === 'connected' &&
    (connections ?? []).length <= 1 &&
    !isSidecar &&
    Boolean(connIdentity);

  return (
    <div className="app-toolbar__actions">
      <div className="header-divider" />

      <button
        type="button"
        // No `app-toolbar__action--secondary`: archive#3311 promotes the
        // connection chip into the mobile toolbar and demotes the profile into
        // the ⋯ overflow. (The full-screen mobile dock hides this whole
        // toolbar; ChatDockMobileConnection is that surface's indicator.)
        className={`app-toolbar__icon-btn app-toolbar__conn app-toolbar__conn--${connState}${compactConn ? ' app-toolbar__conn--compact' : ''}`}
        // ChatDockMobileConnection names itself from the same
        // `connectionIndicatorLabel`. Before station#1048 it rendered
        // unconditionally, so on a phone with the dock merely on screen —
        // collapsed or half-open, the DEFAULT mobile state, not only
        // full-screen — there were two controls whose accessible name
        // started "Manage Stations". It is now gated behind the same
        // toolbar-hidden check this comment's first line describes
        // (`ChatDockMobileHeader`'s `showConnection`), so the two never
        // coexist. This is how a test names THIS one, mirroring that
        // component's own `chat-dock-mobile-connection`.
        data-testid="app-toolbar-connection"
        onClick={() => {
          // archive#3297: transient reachability no longer banners, so the
          // banner's "Try now" is not there to be pressed. Tapping a failing
          // indicator means "check again now", and the retry ladder's own
          // backoff can be up to 10s away. A blocked credential is excluded:
          // re-probing it can only fail again, and the modal this opens
          // carries the remedy. Keyed on the coordinator's own state, not on
          // `connState` — the `idle` downgrade above is presentation.
          //
          // archive#4512: `needs-repair` (identity-mismatch) joins the
          // exclusion for the same reason — the host answered with a
          // different identity, and re-probing the same address proves
          // nothing new; re-pairing (in the modal this still opens) is the
          // only remedy. `awaiting-approval` stays IN the recheck set for a
          // narrower reason than "recheck can answer it" — it cannot: this
          // device has no credential to probe with yet, and a health
          // recheck is not the mechanism that completes a pending exchange
          // (the separate poll in `pendingPairingCompletion.ts` is). An
          // extra harmless probe here just isn't worth carving out. What the
          // tap actually does for this state is `onOpenConnections` below,
          // which surfaces the pending exchange itself. Whether that surface
          // should pause the automatic reconciler while it's already open is
          // a disclosed follow-up, not something this tap changes.
          if (
            connIndicator !== 'connected' &&
            connIndicator !== 'needs-credential' &&
            connIndicator !== 'needs-repair'
          ) {
            connRecheck();
          }
          onOpenConnections();
        }}
        // archive#1094 kept this disambiguation in a `title`, noting the dot
        // "can't distinguish an ordinary reconnect from a blocked
        // (credential-required) one" without expanding its 3-colour contract.
        // archive#3297 expanded the contract instead: the dot now carries the
        // state by SHAPE, so the distinction survives on a device with no
        // hover, and archive#3311 put the state in visible text as well. The
        // title stays as the pointer convenience it always was.
        //
        // #1536 F: except when the chip is collapsed to its dot, where hover
        // is the only channel left for the identity — the bare "Manage
        // Stations" would then name no Station at all. Every state that still
        // renders text keeps the tooltip archive#3297 pinned.
        title={compactConn ? connAccessibleName : connTitle}
        aria-label={connAccessibleName}
      >
        <ConnectionStatusDot status={connState} size={7} />
        {compactConn ? null : (
          <>
            <span
              className={`app-toolbar__conn-state${
                connState === 'needs-credential' ||
                connState === 'awaiting-approval' ||
                connState === 'needs-repair'
                  ? ' app-toolbar__conn-state--alert'
                  : ''
              }`}
            >
              {connStateLabel}
            </span>
            {connIdentity && (
              <span className="app-toolbar__conn-name">{connIdentity}</span>
            )}
            {isSidecar && (
              <span
                className="app-toolbar__conn-note"
                data-testid="desktop-sidecar-indicator"
                // The sidecar's lifetime explanation has no room inline and no
                // longer fits in the button's own title, which archive#3297
                // owns.
                title="Runs while the Station app is open"
              >
                App only
              </span>
            )}
          </>
        )}
      </button>

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className="app-toolbar__icon-btn"
          onClick={onToggleNotifications}
          title={notificationLabel}
          aria-label={`${notificationLabel}${notificationBadge ? ` (${notificationBadge.label})` : ''}`}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
          </svg>
          {notificationBadge && (
            <span className="app-toolbar__notification-badge">
              {notificationBadge.count}
            </span>
          )}
        </button>
        {(showNotifications || hasOpenedNotifications) && (
          <LazyBoundary
            load={loadNotificationHistory}
            componentProps={{
              isOpen: showNotifications,
              onClose: onCloseNotifications,
              onViewAll: onViewAllNotifications,
            }}
            pending={null}
          />
        )}
      </div>

      {/* archive#3311: secondary on mobile — the profile moves into the ⋯
          overflow menu there, freeing the toolbar slot the connection
          status now occupies. */}
      <div className="app-toolbar__action--secondary">
        <button
          type="button"
          className={`app-toolbar__icon-btn ${currentViewType === 'profile' ? 'is-active' : ''}`}
          onClick={onOpenProfile}
          title="Profile"
          aria-label="Profile"
        >
          {userInitials}
        </button>
      </div>

      <div className="app-toolbar__action--secondary">
        <button
          type="button"
          className={`app-toolbar__icon-btn app-toolbar__icon-btn--help ${showHelp ? 'is-active' : ''}`}
          onClick={onToggleHelp}
          title="Ask Station for help"
          aria-label="Ask Station for help"
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </button>
      </div>

      {showHelp && (
        <LazyBoundary
          load={loadHelpMenu}
          componentProps={{
            isOpen: showHelp,
            prompts: helpPrompts,
            onClose: onCloseHelp,
            onSelectPrompt: onHelpPrompt,
          }}
          pending={null}
        />
      )}

      <div className="app-toolbar__overflow" style={{ position: 'relative' }}>
        <button
          type="button"
          className="app-toolbar__icon-btn app-toolbar__overflow-btn"
          onClick={onToggleOverflow}
          aria-label="More actions"
        >
          ⋯
        </button>
        {showOverflow && (
          <LazyBoundary
            load={loadOverflowMenu}
            componentProps={{
              isOpen: showOverflow,
              connStatus,
              userInitials,
              onClose: onCloseOverflow,
              onOpenConnections,
              onOpenHelp: onToggleHelp,
              onOpenProfile,
            }}
            pending={null}
          />
        )}
      </div>

      <button
        type="button"
        className={`app-toolbar__icon-btn ${currentViewType === 'settings' ? 'is-active' : ''}`}
        onClick={onToggleSettings}
        title={`Settings (${settingsShortcut})`}
        aria-label="Open settings"
      >
        <SettingsGlyph />
      </button>
    </div>
  );
}
