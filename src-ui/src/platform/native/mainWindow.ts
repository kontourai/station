/**
 * Whether this document is the desktop app's `main` window (#2587).
 *
 * Every workspace-pane pop-out window renders the whole app, so anything
 * that must happen once per app — OS alerts — would otherwise run once per
 * window: each pop-out kept its own feed cursor and posted the same alert
 * again, and an unfocused pop-out alerted while `main` was in use. The
 * native host names windows (`main`, `workspace-pane-pop-out-<uuid>`) and
 * Tauri sets the current label synchronously in every webview. With no
 * label (not a Tauri webview) the document is treated as `main`: a guess
 * from the route would also match the main window's own pane routes and
 * silently drop its alerts.
 */
export function isMainDesktopWindow(): boolean {
  const label = (
    window as {
      __TAURI_INTERNALS__?: {
        metadata?: { currentWindow?: { label?: unknown } };
      };
    }
  ).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  return typeof label !== 'string' || label === 'main';
}
