---
status: current
subject: Display recorded MCP app results in chat without granting session actions
decided: 2026-10-17
evidence:
  - kind: adr
    ref: docs/adr/0007-render-mcp-ui-in-an-open-hardened-host.md
---

# MCP app transcript previews

Completed MCP calls may mount the existing hardened web host alongside their
transcript row only when the already-open server's tool definition declares an
App. A cheap successful-content-envelope and provider-identity filter precedes
membership in a per-server UI-tool catalog, cached for five minutes. Unknown or
disconnected servers produce no membership and no card. History discovery,
resolution and resource reads never start stdio servers. Result `_meta.ui` is
neither required nor authority to mount, retain an envelope or read a URI.

At completion, EventStore overwrites any incoming `mcpAppResourceUri` with a
Station-owned stamp from the already-open catalog. Only stamped successful MCP
results fitting the existing 24 KiB event bound retain their full envelope in
windows. Ordinary results retain diagnostic previews independent of catalog
lookup timing. This additive optional runtime-event field leaves older readers
compatible. Pre-stamp history whose output was reduced to text stays ordinary.
Rendering rechecks the current catalog and render policy through the hardened
path; this is current-resource semantics, not a historical HTML snapshot.

Codex exposes the required result envelope and canonical identity. Claude-provider
MCP calls cannot mount: summarizeClaudeToolResult stringifies output and raw
`mcp__` names are ambiguous. ACP and managed-engine preservation remain
unqualified. The definition-only demo and seeded transcript establish browser
resource behavior, not real-provider execution.

The initial slice is preview-only. It sends the recorded tool input/result and
follows the host theme; it refuses app tool calls, resource reads, messages and
links. No transcript frame can post a turn or supply model context. The visible
unavailable state applies independently of whether the engine is running.
Native-shell containment restrictions remain in force.

This builds on ADR 0007 without broadening its bridge authority. A later slice
must bind each app occurrence to the authenticated owning session, integration
and resource before enabling actions, per-message approvals or context delivery.
The [host design](../design/mcp-ui-host.md#transcript-previews) records supported
metadata paths and the remaining capabilities.
