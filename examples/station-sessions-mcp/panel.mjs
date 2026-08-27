/**
 * Pure render for the Station sessions MCP-UI panel.
 *
 * Kept in its own module (no MCP/transport imports, no top-level side effects)
 * so it can be unit-tested directly and so importing it never opens a stdio
 * server. `server.mjs` imports `renderSessionsPanel` and serves its output as a
 * `ui://` resource.
 *
 * The HTML is deliberately SELF-CONTAINED — inline styles only, no external
 * scripts/styles/assets and no network calls — so it renders cleanly under
 * Station's hardened MCP-UI sandbox (opaque origin + deny-all CSP). Do not add
 * external `<script src>`/`<link href>` or remote fetches here; that would
 * break compliance with the default sandbox.
 */

/** Escape a value for safe interpolation into HTML text/attributes. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Best-effort short, human-readable timestamp; falls back to the raw value. */
function formatTimestamp(value) {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return escapeHtml(value);
  return escapeHtml(new Date(ms).toISOString().replace('T', ' ').slice(0, 19));
}

/**
 * Render an MCP-UI panel listing orchestration sessions.
 *
 * @param {Array<object>} sessions - OrchestrationSessionSummary-shaped rows
 *   (threadId, provider, status, lifecycleState?, projectSlug?,
 *   assignedAgentSlug?, lastEventAt?, updatedAt?). Tolerant of missing fields.
 * @returns {string} a complete, self-contained HTML document.
 */
export function renderSessionsPanel(sessions) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const count = rows.length;

  const body = count
    ? `<table>
      <thead>
        <tr>
          <th>Session</th><th>Agent</th><th>Provider</th>
          <th>State</th><th>Project</th><th>Last activity</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((s) => {
            const state = s?.lifecycleState ?? s?.status ?? 'unknown';
            return `<tr>
          <td><code>${escapeHtml(s?.threadId)}</code></td>
          <td>${escapeHtml(s?.assignedAgentSlug ?? '—')}</td>
          <td>${escapeHtml(s?.provider ?? '—')}</td>
          <td><span class="state state--${escapeHtml(state)}">${escapeHtml(state)}</span></td>
          <td>${escapeHtml(s?.projectSlug ?? '—')}</td>
          <td>${formatTimestamp(s?.lastEventAt ?? s?.updatedAt)}</td>
        </tr>`;
          })
          .join('\n        ')}
      </tbody>
    </table>`
    : `<p class="empty">No active sessions.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Station sessions</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0d1117;
      color: #e6edf3;
      padding: 16px;
    }
    h1 { font-size: 15px; margin: 0 0 2px; }
    .sub { color: #8b949e; margin: 0 0 14px; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      text-align: left;
      padding: 7px 10px;
      border-bottom: 1px solid #21262d;
      vertical-align: top;
    }
    th { color: #8b949e; font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; }
    code { background: #161b22; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .state { font-weight: 600; }
    .state--running, .state--ready { color: #3fb950; }
    .state--error, .state--closed { color: #f85149; }
    .empty { color: #8b949e; padding: 24px 0; }
  </style>
</head>
<body>
  <h1>Station sessions <span class="sub">(${count})</span></h1>
  <p class="sub">Live orchestration sessions, rendered natively by the MCP-UI host.</p>
  ${body}
</body>
</html>`;
}
