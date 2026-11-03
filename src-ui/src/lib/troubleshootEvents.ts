/**
 * Troubleshoot-with-an-agent open event (#4470).
 *
 * Same shape as `reportProblemEvents`: entry points (help menu, ⌘K palette,
 * Settings) dispatch this window event, and `TroubleshootHost`, mounted from
 * `DeferredAppOverlays`, listens and runs the start flow. The help menu
 * inlines the literal for the same entry-chunk reason it inlines the
 * report-problem event.
 */
export const OPEN_TROUBLESHOOT_EVENT = 'station:open-troubleshoot';

export function requestTroubleshoot(): void {
  window.dispatchEvent(new CustomEvent(OPEN_TROUBLESHOOT_EVENT));
}
