---
status: current
subject: Contain agent-authored HTML in a page-only sandbox

decided: 2026-10-17
evidence:
  - kind: adr
    ref: docs/adr/0007-render-mcp-ui-in-an-open-hardened-host.md
---

# Agent-authored HTML replies

Agents publish through `station-control` using `html_render`. The tool returns
only a page reference; the transcript fetches bytes with current Session-read
authority. `html_preview` uses the existing Chromium acquisition and owned CDP
host, with a disposable profile rather than a Browser-pane session.

## Decision

Treat page HTML and scripts as hostile, including when an agent generated them
for the person viewing the conversation. Reuse the asset-free MCP sandbox
listener, with a separate `/html-reply/frame` endpoint and a page-only bridge.
Do not add executable content to `render_component` or `UIBlock`.

The trusted outer frame accepts messages only from the configured Station
parent origins. The inner frame has `sandbox="allow-scripts"`, without same
origin, forms, popups, downloads, top navigation or permissions. Its host-built
CSP precedes authored bytes and denies network connections, remote scripts,
remote images, forms, base URLs and nested frames. Inline scripts/styles and
data images/fonts are permitted, following the MCP CSP model. The outer
frame's HTTP policy restricts child navigation to the isolated origin. No
Station assets, cookies or session credentials are delivered to page HTML.

The bridge accepts page bytes and theme tokens from the host. From a page it
forwards only bounded HTTP(S) link requests. It has no MCP AppBridge, tool calls,
resource reads, message sending, or session APIs. Even a forged link message
requires confirmation in trusted Station chrome before external opening.
The viewer checks both the frame window and its exact origin on every message.
An absent or same-origin frame configuration refuses rendering.

`prepareHtmlReply` accepts a caller-owned authorized workspace root, never a
root chosen by public tool input. Quoted absolute PNG/JPEG/GIF/WebP paths in
HTML attributes, CSS `url()` and JS strings are embedded in the captured page.
Canonical paths must stay inside that workspace; content must have a supported
raster signature. Reads require regular files, use descriptor checks and a
bounded extra-byte read, and reject over-limit input instead of publishing a
prefix. The service assumes the workspace's directory ancestry is not being
concurrently replaced by a hostile same-user filesystem actor. It is not a
filesystem permission boundary against another process running as that user.

## Limits and residual risks

The contract caps source HTML at 256 KiB, one image at 2 MiB, the expanded page
at 8 MiB, distinct images at 32, and requested height at 100–2000 pixels.
A malicious script can still consume renderer CPU/memory or draw misleading
content inside its own frame. Isolation is not HTML correctness, factual
verification, or protection from browser vulnerabilities. Pages can request
external navigation, but cannot silently open it through this bridge.

Unquoted paths, constructed/escaped JS paths, SVG, AVIF and arbitrary external
resources are not embedded by this slice. Network resources remain blocked.

## Identity, retention and deletion lineage

Each publication receives a server-generated UUID. Its immutable record contains
the prepared bytes, requested height, publishing execution Session ID, canonical
conversation ID and creation time. The EventStore's SQLite table
`orchestration_html_reply_pages` is the byte owner. Publication checks the Session
still exists and atomically enforces the conversation's 32-page/32-MiB quota.
A delayed publish cannot recreate pages after the Session was deleted.

The small `{version, pageId, sessionId}` reference travels in the ordinary MCP
tool result and therefore in canonical tool-completed history. Both live and
replayed transcript paths recognize it at the tool position. The display
reference is not authority: the read route checks the same `canUserReadSession`
predicate used by other history reads, then looks up that Session/page pair.
Bounded history windows retain the validated reference as `htmlReply` event
metadata before shortening ordinary tool output to 84 characters. The existing
per-event and per-window byte ceilings still apply; page HTML never enters
that metadata. The shared projector carries it to the tool part.
JSON responses use no-store and nosniff; HTML executes only in the dedicated
sandbox. Page bytes are not copied into transcript tool-output budgets.

Deletion follows the publishing **execution Session**, not a borrowed predecessor
or global content digest. `EventStore.deleteThread` deletes page rows in its own
transaction. If deletion rolls back, pages remain. Existing conversation Draft
discard deletes every execution member, so it removes every page in that lineage.
Deleting one diagnostic/member Session removes only its own pages. Copying or
adopting transcript history retains the original page reference, not a second
copy of its bytes; source-session read authority and deletion still govern it. Closing,
archiving or retaining a conversation is not physical deletion and preserves its
pages, just as it preserves the transcript. This introduces no new permission to
delete runtime history and does not change the existing read-only-history rule
on legacy conversation deletion routes. Raw backups and forensic SQLite free
pages remain subject to Station's existing database/backup retention; logical
row deletion is not a secure-erasure claim.

## Preview resources and trust

Preview prepares the same bounded HTML, then starts a disposable Chromium through
`ChromiumServerHost`; no new browser dependency is introduced. The host uses a
128-MiB V8 heap limit and an egress policy denying every destination, in addition
to the page CSP. At most two previews run concurrently. The render deadline is
15 seconds; shutdown also bounds its Browser.close request and terminates the
owned process tree. Viewports, content height, PNG output and console output are
bounded as documented in the [user guide](../user/html-replies.md). Native browser
allocations are not fully capped by the V8 limit; browser vulnerabilities and
resource exhaustion remain residual risks.

An early inline bootstrap relays page console calls, uncaught errors and size
observations to the preview host. Messages require both the exact frame window
and a fresh per-render token held in its bootstrap closure; the bootstrap removes
its script element before authored scripts run. The host rejects output overflow.
A successful screenshot is an observation of authored code, not proof of its
claims or immunity from malicious author interference.

## Owners and evidence

The [preparer](../../src-server/services/html-replies.ts),
[page store](../../src-server/services/orchestration/html-reply-pages.ts),
[tool registrar](../../src-server/tools/station-control-html-reply-tools.ts),
[route](../../src-server/routes/orchestration/html-replies.ts),
[preview](../../src-server/services/html-reply-preview.ts),
[frame document](../../packages/shared/src/html-reply-document.ts), and
[transcript viewer](../../src-ui/src/components/chat/PublishedHtmlReply.tsx)
own the path. Focused tests exercise registered MCP publication, SQLite reopen,
canonical result projection, mounted transcript rendering, deletion rollback,
quotas, preview PNG/height/console and output rejection. Real Codex delivery has
been exercised locally; Claude/ACP use the existing shared passthroughs, with
live provider and native/mobile qualification reported separately.
