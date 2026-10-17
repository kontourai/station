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
transcript row. Rendering uses the current catalog-declared resource through
the existing authorized resolver and resource route. A recorded result is
presentation data, never authority to execute the tool again or read a new URI.

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
