/**
 * Per-document focus report count for the fresh-home walkthrough.
 *
 * The walkthrough allowlists the focus rate limit's 429 (its page-load churn
 * exceeds the per-device budget by design), so the 429 can no longer reveal a
 * client that over-posts. This check restores that signal: the reporter
 * (src-ui/src/hooks/focusReporter.ts) debounces state changes by 1 s, sends
 * a hidden once per hiding, and never retries sooner than 1 s, so the same
 * state reported twice by one document less than 1 s apart is a duplicate
 * post (the defect that sent hidden from both pagehide and visibilitychange).
 */
export const DUPLICATE_REPORT_WINDOW_MS = 1_000;

/**
 * @param {{ at: number, headers: Record<string, string>, postData: string | null }[]} requests
 *   POST /api/presence/focus requests as the harness observed them.
 * @returns {string[]} one line per duplicate report
 */
export function focusReportFindings(requests) {
  /** @type {Map<string, { at: number, state: string, seq: number }[]>} */
  const byDocument = new Map();
  const findings = [];
  for (const request of requests) {
    let body;
    try {
      body = JSON.parse(request.postData ?? '');
    } catch {
      findings.push('focus report with an unreadable body');
      continue;
    }
    const document =
      typeof body?.clientSessionId === 'string'
        ? body.clientSessionId
        : request.headers['x-station-client-session'];
    if (!document || typeof body.state !== 'string') {
      findings.push('focus report naming no document or state');
      continue;
    }
    const reports = byDocument.get(document) ?? [];
    reports.push({ at: request.at, state: body.state, seq: body.seq });
    byDocument.set(document, reports);
  }
  for (const [document, reports] of byDocument) {
    reports.sort((a, b) => a.seq - b.seq);
    for (let index = 1; index < reports.length; index += 1) {
      const previous = reports[index - 1];
      const current = reports[index];
      const gap = current.at - previous.at;
      if (
        current.state === previous.state &&
        gap < DUPLICATE_REPORT_WINDOW_MS
      ) {
        findings.push(
          `document ${document.slice(0, 8)} reported ${current.state} twice ${gap} ms apart (seq ${previous.seq}, ${current.seq})`,
        );
      }
    }
  }
  return findings;
}

/** localStorage key the in-page recorder appends to (survives page loads). */
export const FOCUS_REPORT_LOG_KEY = '__stationWalkthroughFocusReports';

/**
 * Init script: records every focus report this origin's documents send.
 * Playwright's request events and a page CDP session both miss the reports
 * a document sends while it unloads (observed: 14 unload-time hiddens sent,
 * none seen), and those are the reports this check is about. So the page
 * records them itself, synchronously, before handing the call to the real
 * fetch unchanged. Self-contained: it runs in the page, not in Node.
 */
export function recordFocusReportsInPage(key) {
  const original = window.fetch;
  window.fetch = function recordingFetch(...args) {
    const [input, init] = args;
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (new URL(url, location.href).pathname === '/api/presence/focus') {
        const headers = Object.fromEntries(
          new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : {}),
          ).entries(),
        );
        const log = JSON.parse(localStorage.getItem(key) ?? '[]');
        log.push({
          at: Date.now(),
          headers,
          postData: typeof init?.body === 'string' ? init.body : null,
        });
        localStorage.setItem(key, JSON.stringify(log));
      }
    } catch {
      // Recording must never change what the page does.
    }
    return original.apply(this, args);
  };
}
