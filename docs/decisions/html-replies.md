---
status: current
subject: Contain agent-authored HTML in a page-only sandbox

decided: 2026-10-17
evidence:
  - kind: adr
    ref: docs/adr/0007-render-mcp-ui-in-an-open-hardened-host.md
---

# Agent-authored HTML replies

The first slice provides page preparation and a viewer primitive. It does not
expose publishing tools or place pages in conversation history. Those require
conversation-owned storage and authorization before they can be enabled.

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

## Delivery boundary

The [preparer](../../src-server/services/html-replies.ts),
[frame document](../../packages/shared/src/html-reply-document.ts),
[listener](../../src-server/runtime/mcp/mcp-ui-frame-server.ts), and
[viewer](../../src-ui/src/components/chat/HtmlReply.tsx) own this slice.
Focused tests exercise file embedding/limits, listener and bridge behavior,
and viewer theme/link handling. Browser fixture screenshots establish viewer
appearance and opaque-frame access refusal, not a conversation publication.

Remaining slices must add caller-bound conversation storage/deletion, small
page-reference transcript projections, `html_render` and `html_preview` on the
shared station-control registry, and tool-to-history-to-viewer integration
tests. Preview should reuse Station's acquired Chromium and owned CDP host;
no browser dependency is added here. Real Claude, Codex and ACP delivery and
native/mobile behavior remain unverified.
