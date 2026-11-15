import { navigationStore } from '../contexts/NavigationContext';
import { notificationOpenTarget } from '../lib/notificationOpen';
import { openNotificationTargetHere } from '../lib/notificationStationOpen';

/**
 * archive#3203: opening a notification's target is an acknowledgement.
 *
 * The tray badge counts attention items that carry no `acknowledgedAt`
 * (`AttentionProjectionService.list`), and until then only the Dismiss button
 * recorded one. Acting on a row therefore left the number where it was, so
 * the bell stopped meaning "things you have not seen".
 *
 * "Open session" navigates inside the running app (`navigateToAttentionTarget`),
 * so nothing unloads: the acknowledgement no longer has to finish before the
 * user may leave, and opening waits for nothing. The acknowledgement's own
 * mutation refreshes the count when it lands.
 */
export async function openThenAcknowledge({
  acknowledge,
  navigate,
}: {
  acknowledge?: () => Promise<unknown>;
  navigate: () => void;
}): Promise<void> {
  navigate();
  if (!acknowledge) return;
  try {
    await acknowledge();
  } catch {
    // A failed acknowledgement changes nothing the user asked for. The next
    // `/api/attention` read is the source of truth for the count. This is
    // broader than the SDK's swallow (`acknowledgeAttentionItem` absorbs only
    // the stale-item 404): the ack is incidental to opening.
  }
}

/**
 * Navigation seam for the attention surfaces: an in-app navigation, never a
 * document reload, opened like a notification tap (a failed open is told). A stored Activity-surface link opens the Chat surface
 * that replaced it (the same translation `routing.ts` applies to a loaded
 * URL). Anything that is not an in-app path is left to the browser.
 * Component tests mock this export to observe the target.
 */
export function navigateToAttentionTarget(href: string): void {
  const target = notificationOpenTarget(href);
  if (!target) {
    window.location.assign(href);
    return;
  }
  const params =
    target.params.surface === 'activity'
      ? { ...target.params, surface: 'chat' }
      : target.params;
  // Marked like a notification tap: a conversation that is gone or refused
  // says so instead of clearing silently.
  openNotificationTargetHere(target.pathname, params, (pathname, query) =>
    navigationStore.navigate(pathname, query),
  );
}

/**
 * Whether a click on an `<a>` is the plain left-click whose default navigation
 * we are allowed to replace. A modified click is the browser's own "open in a
 * new tab/window/download" gesture: intercepting it would both break that
 * gesture and record an acknowledgement for a row the user never left, so
 * those clicks fall through to the anchor's untouched default.
 */
export function isPlainLeftClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
