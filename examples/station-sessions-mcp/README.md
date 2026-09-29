# Station sessions MCP-UI server

A standalone MCP server and HTML renderer for a session snapshot.
**The current data reader needs repair before use with Station:**
[#2785](https://github.com/kontourai/station/issues/2785) tracks its route,
authentication and false-empty response behavior. A rendered empty panel is
not evidence that Station has no sessions.

It exposes one tool, `sessions_panel`, whose `_meta.ui.resourceUri` points at a
`ui://station-sessions/panel` HTML resource, built with the official
[`@modelcontextprotocol/ext-apps/server`](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
helpers on the MCP TypeScript SDK (same pattern as `examples/mcp-ui-demo`).

At resource-read time the server attempts `GET /orchestration/sessions` beneath
`STATION_API_BASE`, without an authentication header. The canonical Station
route is `/api/orchestration/sessions` and requires the request's authority.
The reader turns non-OK responses, invalid data and exceptions into an empty
array. Adding `/api` to the base only addresses the prefix; it does not supply
authentication or distinguish a failed read from a verified empty result.

The renderer produces self-contained HTML with inline styles and escaped text,
without scripts or external assets. This is the rendering contract exercised
by its tests; it is not a qualified live Station or external-host journey.

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

The panel is a **read-only snapshot**, rendered at resource-read time — there is no
`tools/call` from the panel, so it has no dependency on the host's approval/audit
path. Live updates (SSE/poll) are a deliberate follow-up: they require declaring
`connect-src` under the dedicated-frame origin, or a bridge-driven refresh, and
any future action buttons would route their `tools/call` through Station's
host-side approval + audit machinery.

## Verify

```bash
npm run test:focused -- examples/station-sessions-mcp/__tests__/render.test.mjs
```
