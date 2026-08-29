/**
 * Report-a-problem open event (#766 item 4).
 *
 * Same shape as `connectionModalEvents`: entry points (⌘K palette action,
 * help menu) dispatch this window event, and the host mounted from
 * `DeferredAppOverlays` listens and lazily mounts the dialog. Every module
 * touching this constant lives in lazy chunks, so the entry bundle carries
 * none of it.
 */
export const OPEN_REPORT_PROBLEM_EVENT = 'station:open-report-problem';

export function requestReportProblem(): void {
  window.dispatchEvent(new CustomEvent(OPEN_REPORT_PROBLEM_EVENT));
}
