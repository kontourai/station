import { toastStore } from '../contexts/ToastContext';
import { copyToClipboard } from '../lib/clipboard';
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
 * Tell the reader a link could not be opened, and hand them the link. A
 * refused open must never be a click that does nothing: the app host's
 * `open_external_link` refuses what its policy does not admit (#2480 — the
 * owner chose any https link the user clicks; until that lands, a narrower
 * allowlist) and can fail outright, and `openExternalLink` refuses any scheme
 * but http(s) before asking a host. The notice names the URL and offers
 * a Copy action, so the reader can still get where they were going.
 */
export function reportUnopenedExternalLink(
  url: string,
  reason: 'host-refused' | 'unsupported-scheme',
): void {
  const why =
    reason === 'host-refused'
      ? 'The Station app cannot open this link.'
      : 'Station only opens web (http or https) links.';
  toastStore.show(
    `${why} Copy it to open it yourself: ${url}`,
    undefined,
    0,
    [
      {
        label: 'Copy link',
        variant: 'primary',
        onClick: () => {
          void copyToClipboard(url).then((copied) => {
            if (!copied)
              toastStore.show(
                `Copying was blocked on this device. The link: ${url}`,
                undefined,
                0,
                undefined,
                undefined,
                'warning',
              );
          });
        },
      },
    ],
    undefined,
    'warning',
  );
}

async function invokeNativeExternalLink(url: string): Promise<boolean | null> {
  const native = await nativePlatformPromise;
  if (native.platform !== 'tauri') return null;
  return native.openExternalLink(url);
}

/**
 * Open `url` outside Station through the native host, or `null` when there is
 * no native host to open it (the web build). `null` is not failure: it is
 * "this is not mine", and it lets each caller keep its own web behaviour —
 * the MCP frame navigates the top level, a chat anchor that leaves Station
 * carries `target="_blank"` (a new tab, as #2049 specified).
 *
 * On Tauri a plain `<a href>` NAVIGATES THE WEBVIEW, replacing the running
 * application with the linked page and losing every open conversation. That
 * is what this exists to prevent (#2049).
 *
 * `false` is a REFUSAL or a failure: the app host opens only what its policy
 * admits (#2480: any https link once widened; a narrower allowlist before),
 * so a plain http link, another scheme, or a host error all land here. Every
 * refusal is reported (`reportUnopenedExternalLink`), so no caller can leave
 * one silent, whichever policy the host is running.
 */
export async function openNativeExternalLink(
  url: string,
): Promise<boolean | null> {
  const opened = await invokeNativeExternalLink(url);
  if (opened === false) reportUnopenedExternalLink(url, 'host-refused');
  return opened;
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Open `url` outside Station on either host, for an explicit "open this
 * elsewhere" control: the native host's opener where there is one (which
 * admits only what its policy allows — a refusal is reported, not
 * swallowed), else a
 * new browser tab with no opener, for http(s) URLs only. Anything else is
 * refused visibly. Resolves whether it opened.
 */
export async function openExternalLink(url: string): Promise<boolean> {
  if (!isWebUrl(url)) {
    reportUnopenedExternalLink(url, 'unsupported-scheme');
    return false;
  }
  const native = await openNativeExternalLink(url);
  if (native !== null) return native;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}
