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
CSP precedes authored bytes and denies ordinary network connections, remote scripts,
remote images, forms, base URLs and declared frame navigations. Nested srcdoc
execution and WebRTC remain possible as described in the review amendment. Inline scripts/styles and
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
Incoming `htmlReply` and `mcpAppResourceUri` metadata claims are discarded at
ingestion. Only qualified Station render results derive an HTML page reference.
Bounded history windows retain the validated reference as `htmlReply` event
metadata before shortening ordinary tool output to 84 characters. The existing
per-event and per-window byte ceilings still apply; page HTML never enters
that metadata. The shared projector carries it to the tool part.
The authorized read also supplies the current ephemeral sandbox origin; it is
never persisted with the page or borrowed from cached app config.
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

## Review amendment: network and link boundaries

The earlier blanket no-network description was incorrect. CSP denies ordinary
fetch, resource and frame navigation, but does not regulate WebRTC ICE sockets.
The shared MCP wrapper now disables direct peer/ICE constructors before authored
scripts and refuses declared child-frame sources. HTML replies and MCP-UI both
use that bootstrap. This is defense in depth, **not a network isolation boundary**:
a nested srcdoc document inherits CSP, can execute inline code, and gets fresh
constructors. Real UDP listeners observed this bypass in Chromium and WebKit
after the direct-constructor hardening. Permissions-Policy camera/microphone
restrictions do not prevent data-channel ICE. Browser sandbox tokens provide no
portable RTC-denial flag. Preview's process egress policy is separate.

A complete guarantee for remote viewers requires a different execution model
(such as a trusted interpreter without browser networking) or browser/OS network
policy under Station's control. Removing arbitrary scripts would change the
published-page contract. This PR does not claim that guarantee and does not
silently reduce authored scripts to inert content. Viewer IP disclosure and
exfiltration of data a viewer enters into a deceptive page remain residual risks.

The app host and page proxy require live user activation for link requests.
The trusted confirmation names the visual reply, delays Open by 500 ms, and
Cancel mutes further link requests from that mounted reply. Message provenance
alone never establishes user intent. Preview now has operate scope and bounded-
write classification because it launches a browser process.

## Preview host enforcement amendment

The viewer-side RTC residual is accepted by the owner. It does not authorize
network access from Station's disposable preview browser. The HTTP egress proxy and Chromium's command-line
non-proxied-UDP switch alone did not prevent ICE UDP on Chrome 155. Preview
now seeds its fresh profile with Chrome's `webrtc.ip_handling_policy` set to
`disable_non_proxied_udp`. This is the load-bearing RTC control measured on
Chrome 155; the ineffective legacy `multiple_routes_enabled` and
`nonproxied_udp_enabled` keys have been removed.
This applies across realms, including nested srcdoc and closed shadow roots;
it does not depend on hiding constructors. The existing launch flag alone was
insufficient. Browser DNS is denied with host-resolver rules; the deny-all HTTP
proxy refuses destinations before invoking the host DNS resolver. TCP remains
subject to that proxy. These options are specific to preview and do not change
Browser-pane profiles or the accepted viewer residual. Failed CDP experiments
were discarded rather than shipped as a complete guard.
The real socket regression requires both loopback and a non-loopback interface;
missing prerequisites fail rather than becoming a skipped success.

Built-in Station/default Agents attach the full station-control catalog and its
auto-approved bounded writes. Authored Agents require attachment. ACP supports a
whole-server attachment only; per-tool filtering is refused. Link requests use
transient browser activation from interaction with the reply (roughly five
seconds), not proof that the person clicked the requested link.

### ACP publication identities

ACP preserves the engine's reported `name`, falling back to `title`; ACP itself
does not require a universal MCP name spelling. codex-acp reports
`Tool: station-control/html_render` as its title; claude-agent-acp reports
`mcp__station-control__html_render` as the standard name. Both exact forms are
accepted by the snapshot and transcript matchers; arbitrary html_render suffixes
remain rejected. Regression tests drive these engine-shaped updates through the
ACP mapper and canonical newest-window projection.

Behavior sources inspected: [codex-acp thread.rs](https://github.com/zed-industries/codex-acp/blob/296069e841634cd4bb9bc4515602d836e49231ec/src/thread.rs),
[claude-agent-acp renderer](https://github.com/zed-industries/claude-agent-acp/blob/dbf386d8d35d2bc30f17f11f15d1a4305c9d391f/src/tool-calls/renderer.ts).
Other ACP engines may report different titles; their successful publication does
not establish that an unqualified title identifies station-control. Live engine
qualification is reported separately from this adapter regression.


Preview still uses the ordinary acquisition preference for an installed system
Chrome/Edge before the pinned download. It does not assume those browsers honor
profile preferences: before any authored HTML loads, a separate temporary
internal target reads `chrome://prefs-internals/` and requires the effective
`webrtc.ip_handling_policy` value to be `disable_non_proxied_udp`, with no
per-URL overrides. Chromium reports managed-policy precedence in that resolved
value. A mismatch, unreadable/unsupported diagnostic, timeout or URL override
refuses preview with a fixed, clear error. The diagnostic target is closed;
authored content uses a separate fresh target. This keeps system-browser support
while failing closed for enterprise overrides and incompatible browser versions.


Preview passes its complete sandbox document, diagnostic token, theme and theme
values as CDP `Runtime.callFunctionOn` value arguments. The bootstrap function
source is constant; the only preceding evaluation obtains the page global
object. Agent-authored bytes never become part of that function source. The
real preview regression reads script delimiters, Unicode separators and template
syntax back from inside the opaque frame without changing their UTF-8 bytes.


The shared sandbox UDP regression requires Chromium. WebKit runs only when its
Playwright executable is installed; otherwise the test reports an explicit
named skip with the missing executable path. The process-heavy CI lane installs
Chromium alone, so WebKit viewer-residual evidence is local-only and is not a
claim of WebKit verification by that lane. Neither engine's absence is treated
as a passing browser execution.
