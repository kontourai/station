/**
 * Whether this document is the desktop app's `main` window (#2587).
 *
 * Every workspace-pane pop-out window renders the whole app, so anything
 * that must happen once per app — OS alerts — would otherwise run once per
 * window: each pop-out kept its own feed cursor and posted the same alert
 * again, and an unfocused pop-out alerted while `main` was in use. The
 * native host names windows (`main`, `workspace-pane-pop-out-<uuid>`) and
 * Tauri exposes the current label synchronously; without it, a pop-out is
 * recognised by the pane route its host opens it on.
 */
export function isMainDesktopWindow(): boolean {
  const label = (
    window as {
      __TAURI_INTERNALS__?: {
        metadata?: { currentWindow?: { label?: unknown } };
      };
    }
  ).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  if (typeof label === 'string') return label === 'main';
  return !/^\/projects\/[^/]+\/layouts\/[^/]+\/panes\//.test(
    window.location.pathname,
  );
}
