/**
 * station#3203: opening a notification's target is an acknowledgement.
 *
 * The tray badge counts attention items that carry no `acknowledgedAt`
 * (`AttentionProjectionService.list`), and until now only the Dismiss button
 * recorded one. Acting on a row therefore left the number where it was, so
 * the bell stopped meaning "things you have not seen" — the reported "clicking
 * on a notification that needs attention should probably make the notification
 * number decrement as seen".
 *
 * The ordering matters and is the whole reason this is a function rather than
 * an `onClick` one-liner. "Open session" is a real document navigation, and a
 * fire-and-forget POST racing an unload is cancelled by the browser; even when
 * it survives, the destination document fetches `/api/attention` on mount and
 * can read the pre-ack count. Awaiting the ack before navigating is what makes
 * the decrement observable on arrival rather than one refetch later.
 */
export async function acknowledgeThenOpen({
  acknowledge,
  navigate,
}: {
  acknowledge: () => Promise<unknown>;
  navigate: () => void;
}): Promise<void> {
  try {
    await acknowledge();
  } catch {
    // A failed acknowledgement must never trap the user on the tray: the
    // request they made was "open this". The next `/api/attention` read is the
    // source of truth for the count either way, exactly as the SDK's own
    // `acknowledgeAttentionItem` already treats a 404.
  }
  navigate();
}

/**
 * Browser navigation seam for the attention surfaces. `<a href>`'s default
 * action is suppressed when a row acknowledges first, so the navigation has to
 * be re-issued explicitly; keeping it behind one named export lets component
 * tests observe the target without jsdom attempting a real navigation.
 */
export function navigateToAttentionTarget(href: string): void {
  window.location.assign(href);
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
