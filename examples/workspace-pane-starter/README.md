# Workspace Pane Starter

This example contributes a portable, data-only Workspace Pane backed by the
sandboxed MCP App in [station-sessions-mcp](../station-sessions-mcp/README.md).
It demonstrates the current `workspacePanes` manifest contract rather than the
legacy `layout` shape.

## What It Demonstrates

- Separate descriptor, renderer, integration, and tool identities.
- Project-scoped suitability through a declared Pane mode.
- `secondary` and `standalone` placement without owning host geometry.
- A read-only MCP renderer with explicit plugin and MCP provenance.
- Required integration and tool declarations without loading plugin code.

The manifest deliberately has no `entrypoint` or `serverModule`. Installing it
registers inert Pane metadata; the MCP server remains the renderer authority.

## Try It

1. Register and run the
   [Station sessions MCP server](../station-sessions-mcp/README.md#wire-it-into-station).
2. Install this directory from the repository root:

   ```bash
   station plugin install ./examples/workspace-pane-starter
   ```

3. Open a Project, add **Session activity**, and choose a supported placement.

The Pane remains unavailable until the declared MCP integration and renderer
capability are available. Installation alone does not prove runtime
availability.

## Verify

From the Station repository root:

```bash
npm run workspace-pane:conformance
npm run test:focused -- scripts/__tests__/examples-conformance.test.ts
```

The focused test parses the checked-in manifest through the public SDK
descriptor parser and proves the integration, tool, mode, placement, and
provenance identities remain exact.
