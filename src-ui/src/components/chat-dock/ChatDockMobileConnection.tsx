import {
  type ConnectionIndicatorState,
  ConnectionStatusDot,
  connectionIndicatorLabel,
  connectionIndicatorState,
  useConnectionStatus,
  useConnections,
  usePendingPairingApproval,
} from '@kontourai/station-connect';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { openConnectionsModal } from '../../lib/connectionModalEvents';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';

/**
 * station#4512 review (H1) — short-form action words for this bar.
 *
 * `connectionIndicatorActionLabel` (the shared package function) returns the
 * toolbar chip's full-sentence-length forms ("Pair", "Awaiting approval",
 * "Needs re-pairing") — that chip has an entire desktop toolbar row to
 * itself. This bar is ONE row shared with six other 44px controls at a
 * 320px minimum width — a budget measured in `index.css`'s comment on
 * `.chat-dock__mobile-conn-label` and spec-pinned by the labelled
 * needs-repair/awaiting-approval transitions in
 * `tests/mobile-chat-composer.spec.ts`'s "320px header contains every pinned
 * control" case (#547). This bar gets its own short vocabulary instead of the
 * chip's; `needs-credential` keeps "Pair" —
 * already short — so this is really only two new words.
 */
const SHORT_ACTION_LABEL: Partial<Record<ConnectionIndicatorState, string>> = {
  'needs-credential': 'Pair',
  'needs-repair': 'Re-pair',
  'awaiting-approval': 'Waiting',
};

/** States with a distinct remedy, carried by the same enlarged triangle dot. */
function isRepairLike(state: ConnectionIndicatorState): boolean {
  return state === 'needs-credential' || state === 'needs-repair';
}

/**
 * Every state that needs a decision (or, for `awaiting-approval`, is the
 * reason nothing else needs one yet) — the amber background and the short
 * label both key off this, not off `needs-credential` alone.
 */
function needsAttention(state: ConnectionIndicatorState): boolean {
  return isRepairLike(state) || state === 'awaiting-approval';
}

/**
 * Connection state on the mobile chat surface — station#3297 part 2.
 *
 * The app toolbar's own indicator is hidden while the dock is full-screen
 * (`app__main--mobile-dock-fullscreen`), and this bar replaced it. So on the
 * one surface where the owner actually met a stale credential, nothing showed
 * connection state at all and a paragraph-sized banner was doing the work.
 *
 * station#1048: that "hidden while full-screen" premise used to be only a
 * CSS fact about the toolbar, not a fact about this component — this
 * component itself rendered on every mobile width regardless of dock state,
 * so it and the toolbar's chip coexisted (both visible, both in the a11y
 * tree, same accessible-name prefix) in the collapsed/half-open dock, which
 * is the default mobile state. `ChatDockMobileHeader` now mounts this only
 * when the toolbar is actually hidden (`showConnection`), matching what this
 * docblock always claimed.
 *

 * Three channels carry `needs-credential` (and, since station#4512 review
 * H1, `needs-repair` too), because a 7px dot can carry none of them alone: a
 * triangle instead of a disc (`ConnectionStatusDot`), a short word, and the
 * button's accessible name. Colour is the fourth, never the only one — and
 * there is deliberately no `title`, because the tooltip is what made this
 * state unreachable on touch in the first place.
 *
 * It shares the health coordinator with every other `useConnectionStatus`
 * caller (they are keyed by connection in one registry), so mounting it here
 * adds no polling. `usePendingPairingApproval` is likewise shared with the
 * toolbar chip and the banner layer — the same locally-tracked pending-
 * exchange fact, read once per surface, not three drifting copies of it.
 */
export function ChatDockMobileConnection({
  showLabel = false,
}: {
  showLabel?: boolean;
}) {
  const { activeConnection } = useConnections();
  const { apiBase } = useApiBase();
  const { status, reason, recheck } = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const pendingApproval = usePendingPairingApproval(
    activeConnection?.url ?? apiBase,
  );
  const state = connectionIndicatorState({
    status,
    reason,
    pendingApproval: pendingApproval !== null,
  });
  const actionLabel = SHORT_ACTION_LABEL[state] ?? null;

  return (
    <button
      type="button"
      className={`app-toolbar__icon-btn chat-dock__mobile-header-icon chat-dock__mobile-conn${
        needsAttention(state) ? ' chat-dock__mobile-conn--attention' : ''
      }`}
      data-testid="chat-dock-mobile-connection"
      data-connection-state={state}
      aria-label={connectionIndicatorLabel(state)}
      data-dock-drag-passthrough=""
      onClick={() => {
        if (isRepairLike(state)) {
          // Exactly one remedy for either, so go to it. A recheck here would
          // be the one action that provably cannot help: `needs-credential`
          // is blocked on a rejected credential and re-probing it can only
          // fail again; `needs-repair` (identity-mismatch) means the host
          // that answered is not the one this device paired with, and
          // re-probing the SAME address proves nothing new. Aligned with the
          // toolbar chip's own exclusion (`HeaderActions.tsx`) so the two
          // surfaces agree on when a tap is worth spending a recheck.
          openConnectionsModal({ mode: 'request-access' });
          return;
        }
        // Tapping a failing indicator means "check again now". Doing it here
        // is what keeps a real retry reachable for transient reachability
        // after station#3297 stopped bannering it: the banner's "Try now"
        // button went with the banner, and the retry ladder's own backoff can
        // be up to 10s away. Also covers `awaiting-approval`: a recheck
        // cannot manufacture a credential out of a pending request (see
        // `HeaderActions.tsx`'s own comment on this), but it is harmless,
        // and the tap's real job for that state is `openConnectionsModal`
        // below, which surfaces the pending exchange itself.
        recheck();
        openConnectionsModal({});
      }}
    >
      <ConnectionStatusDot status={state} size={isRepairLike(state) ? 11 : 8} />
      {(showLabel || actionLabel) && (
        <span className="chat-dock__mobile-conn-label">
          {showLabel
            ? `${activeConnection?.name ?? 'Station'} · ${actionLabel ?? 'Manage Stations'}`
            : actionLabel}
        </span>
      )}
    </button>
  );
}
