# Station sessions MCP-UI server

A standalone MCP server that exposes the read-only tool `sessions_panel` and
the self-contained resource `ui://station-sessions/panel`.

Both read `GET /api/orchestration/sessions/read-model?limit=200` when called.
The snapshot contains up to 200 of the latest Sessions visible to the
configured credential. The tool returns a count only after validating the
success envelope and rows. Failed tool reads report an MCP error and failed
resource reads render an unavailable panel. The panel shows an empty snapshot
only after a valid empty Station response.

## Run

Use the Station checkout's managed dependencies. Configure
`STATION_API_BASE` with the Station origin, such as
`http://127.0.0.1:3242`, with no path. HTTPS is required away from loopback.
Supply `STATION_API_CREDENTIAL` to the child process through the operator's
secret-injection mechanism. Use a credential with orchestration read access for
the intended Station. Keep it out of command arguments, registry files and
shared examples.

```bash
node examples/station-sessions-mcp/server.mjs
```

The reader sends the credential only to the configured origin and refuses
redirects. A response deadline and size limit also apply to the response body.

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

   For a Station-managed child, bind an instance-owned secret to
   `STATION_API_CREDENTIAL` using the integration's secret environment
   bindings. The integration uses this credential's read scope for all its
   tool and resource calls. Attach it where that scope is intended.

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
path. Scheduled or interactive refresh is a separate integration: they require declaring
`connect-src` under the dedicated-frame origin, or a bridge-driven refresh, and
any future action buttons would route their `tools/call` through Station's
host-side approval + audit machinery.

## Verify

```bash
npm run test:focused -- examples/station-sessions-mcp/__tests__/render.test.mjs examples/station-sessions-mcp/__tests__/server.process.test.mjs
```

The stdio test uses a loopback fixture with synthetic credentials. An
independent run against an isolated Station also verified a paired Device's
empty snapshot and then verified refusal from the same connected stdio
client after Device revocation. External-host rendering remains unverified.
[Real Station receipt](https://github.com/kontourai/station/issues/2785#issuecomment-6995173513)
