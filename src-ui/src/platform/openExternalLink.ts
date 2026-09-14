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
 */
export async function openNativeExternalLink(
  url: string,
): Promise<boolean | null> {
  const native = await nativePlatformPromise;
  if (native.platform !== 'tauri') return null;
  return native.openExternalLink(url);
}
