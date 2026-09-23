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

3. Open the layout tab — the panel renders in a sandboxed frame (see
   [Browser isolation](../../docs/design/mcp-ui-host.md#browser-isolation)).
   The host is on by default. If the panel shows the inert "unsupported"
   state instead, check that the **MCP UI host** setting (`mcpUiHost`) has not
   been turned off.

## Verify the server path directly

With the integration registered and attached to an agent:

```bash
# Resolve the ref → discovers _meta.ui.resourceUri from the live server
curl -s "$API/integrations/mcp-ui-demo/ui/status_panel" | jq .

# Read the resolved resource content (the HTML above)
curl -s "$API/integrations/mcp-ui-demo/ui/status_panel/resource" | jq .data.mimeType
```

## Going interactive (tool calls)

This demo ships **static** HTML so it renders under the hardened sandbox with no
external assets. To exercise the host bridge (tool input + `tools/call` through
Station's approval flow), the resource HTML must speak the MCP Apps protocol via
the View SDK (`@modelcontextprotocol/ext-apps`) **inlined into the HTML** (the
deny-all CSP blocks fetching it at runtime), and the layout component's
`approvalPolicy` set to `require` (or `inherit`). That richer variant builds on
this same wiring.
