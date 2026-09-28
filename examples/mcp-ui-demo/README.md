# MCP-UI demo server

The smallest real MCP server that exercises Station's **MCP-UI host** — it
exposes one tool (`status_panel`) whose `_meta.ui.resourceUri` points at a
`ui://` HTML resource, built with the official
[`@modelcontextprotocol/ext-apps/server`](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
helpers on the MCP TypeScript SDK.

Use it to validate the host end-to-end (resolve → resource-read → sandboxed
render) against a real server rather than mocks.

## Run

From the Station repo root (deps already installed there):

```bash
node examples/mcp-ui-demo/server.mjs   # speaks MCP over stdio
```

## Wire it into Station

1. **Register it as a stdio MCP integration.** Add an integration whose command
   launches this server, e.g. id `mcp-ui-demo`:

   ```json
   {
     "id": "mcp-ui-demo",
     "kind": "mcp",
     "transport": "stdio",
     "command": "node",
     "args": ["examples/mcp-ui-demo/server.mjs"]
   }
   ```

   (Add via the Connections → Tools UI, or `POST /integrations`.) Attach it to an
   agent so its tools are discovered.

2. **Reference it from a layout** as an `mcp-tool-ui` component:

   ```json
   {
     "id": "demo-ui",
     "label": "Demo UI",
     "component": {
       "kind": "mcp-tool-ui",
       "ref": "mcp-ui-demo/status_panel",
       "approvalPolicy": "read-only"
     }
   }
   ```

3. Open the layout tab in Station's **web client** — the panel renders in a
   sandboxed frame (see
   [Browser isolation](../../docs/design/mcp-ui-host.md#browser-isolation)).
   The host is on by default. If the panel shows the inert "unsupported"
   state instead, check that the **MCP UI host** setting (`mcpUiHost`) has not
   been turned off. Native shells currently refuse MCP UI frames before
   resolution; enabling the setting does not override that boundary.

Use an absolute server-script path in the integration when Station is not
launched from this repository root. The relative path in the example depends
on the MCP process working directory.

## Verify the server path directly

With the integration registered and attached to an agent, set `API` to the
selected Station's API base. Include the credentials required by that Station;
the examples below show the endpoint paths without authentication headers.

```bash
# Resolve the ref → discovers _meta.ui.resourceUri from the live server
curl -s "$API/integrations/mcp-ui-demo/ui/status_panel" | jq .

# Read the resolved resource content (the HTML above)
curl -s "$API/integrations/mcp-ui-demo/ui/status_panel/resource" | jq .data.mimeType
```

## Going interactive (tool calls)

This demo ships **static** HTML so it renders under the hardened sandbox with no
external assets. To exercise the host bridge (tool input + `tools/call` through
Station's approval flow), make the resource speak the MCP Apps protocol via
the View SDK (`@modelcontextprotocol/ext-apps`). Inline it for this example's
default network-blocking policy; this resource declares no external domains.
Set `approvalPolicy` to `require` for the host's inbox approval or `inherit`
for the current client confirmation dialog. `read-only` refuses these calls.
The dedicated proxy and opaque `srcdoc` fallback have different frame origins;
the host chooses the proxy only when its configured origin is distinct from
Station. The static demo itself sends no bridge messages or interactive calls.
