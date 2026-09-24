import { hasTauriRuntime, nativePlatformPromise } from './native';

/**
 * Whether this host owns external navigation — i.e. whether a link that leaves
 * Station must be handed to the platform instead of being followed in place.
 *
 * Synchronous, because a click handler has to decide whether to prevent the
 * anchor's default BEFORE it can await anything. It reads Tauri's runtime
 * marker through the same `hasTauriRuntime` the adapter selection uses, so
 * the two can never disagree about which host this is.
 */
export function hostOwnsExternalLinks(): boolean {
  return hasTauriRuntime();
}

/**
 * Open `url` outside Station through the native host, or `null` when there is
 * no native host to open it (the web build). `null` is not failure: it is
 * "this is not mine", and it lets each caller keep its own web behaviour —
 * the MCP frame navigates the top level, a chat anchor simply does what an
 * anchor does.
 *
 * On Tauri a plain `<a href>` NAVIGATES THE WEBVIEW, replacing the running
 * application with the linked page and losing every open conversation. That
 * is what this exists to prevent (#2049); the MCP frame already routed around
 * it, and this is that route, shared.
 *
 * DEVIATION, stated plainly: #2049's plan said external links open "in a new
 * tab on web". They do not. A chat anchor's web branch is the anchor's own
 * default, which REPLACES the Station tab — the behaviour before #2049. Only
 * the native half was extracted, so the MCP frame keeps its `location.assign`
 * byte for byte and no caller silently changed. Opening a new tab is a
 * separate change with its own question (whether a model-written link should
 * be able to open one), and `docs/design/placement.md` records it as open.
 */
/**
 * Open `url` outside Station on either host: the native host's opener (on a
 * phone that hands a forge link to its app), else a new browser tab with no
 * opener. For an explicit "open this elsewhere" control, where leaving is the
 * point — not for a model-written link, whose web behaviour stays the
 * anchor's own (`ChatMarkdownAnchor`).
 */
export async function openExternalLink(url: string): Promise<void> {
  const native = await openNativeExternalLink(url);
  if (native !== null) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function openNativeExternalLink(
  url: string,
): Promise<boolean | null> {
  const native = await nativePlatformPromise;
  if (native.platform !== 'tauri') return null;
  return native.openExternalLink(url);
}
