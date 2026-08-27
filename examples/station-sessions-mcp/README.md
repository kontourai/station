# Station sessions MCP-UI server

A standalone MCP server that renders **Station's own orchestration sessions** as
a compliant [MCP-UI](https://modelcontextprotocol.io) panel. It demonstrates
the portable distribution path: Station data can travel to another MCP-UI host
and render natively inside Station's own host.

It exposes one tool, `sessions_panel`, whose `_meta.ui.resourceUri` points at a
`ui://station-sessions/panel` HTML resource, built with the official
[`@modelcontextprotocol/ext-apps/server`](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
helpers on the MCP TypeScript SDK (same pattern as `examples/mcp-ui-demo`).

At resource-read time the server fetches Station's local REST API
(`GET /orchestration/sessions`) and **server-side-renders a self-contained HTML
snapshot** — inline styles only, no scripts or external assets — so the panel
needs no network access of its own and renders under the host's hardened sandbox
(opaque origin + deny-all CSP).

## Run

From the Station repo root (deps already installed there):

```bash
node examples/station-sessions-mcp/server.mjs            # speaks MCP over stdio
# point at a non-default Station port:
STATION_API_BASE=http://localhost:3242 node examples/station-sessions-mcp/server.mjs
```

`STATION_API_BASE` defaults to `http://localhost:3141`.

## Wire it into Station

1. **Register it as a stdio MCP integration** (via Connections → Tools, or the
   curated registry entry at `examples/registry/integrations/station-sessions-mcp`):

   ```json
   {
     "id": "station-sessions-mcp",
     "kind": "mcp",
     "transport": "stdio",
     "command": "node",
     "args": ["examples/station-sessions-mcp/server.mjs"],
     "env": { "STATION_API_BASE": "http://localhost:3141" }
   }
   ```

   Attach it to an agent so its tools are discovered.

2. **Reference it from a layout** as an `mcp-tool-ui` component:

   ```json
   {
     "id": "sessions-ui",
     "label": "Sessions",
     "component": {
       "kind": "mcp-tool-ui",
       "ref": "station-sessions-mcp/sessions_panel",
       "approvalPolicy": "read-only"
     }
   }
   ```

3. **Enable the host flag.** `mcpUiHost` is on by default; if disabled, set it in
   Settings (or `config/app`). Open the layout tab — the panel renders in a
   sandboxed iframe.

## Scope

Slice 1 is a **read-only snapshot**, rendered at resource-read time — there is no
`tools/call` from the panel, so it has no dependency on the host's approval/audit
path. Live updates (SSE/poll) are a deliberate follow-up: they require declaring
`connect-src` under the dedicated-frame origin, or a bridge-driven refresh, and
any future action buttons would route their `tools/call` through Station's
host-side approval + audit machinery.

## Verify

```bash
npx vitest run examples/station-sessions-mcp   # renderSessionsPanel unit tests
```
