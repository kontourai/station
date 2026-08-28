/**
 * Every portable Basis MCP app is built from this explicit manifest. Adding an
 * app is declarative: its browser entry and checked-in generated module stay
 * paired, and the plural generator owns the same procedure for each one.
 */
export const BASIS_MCP_APP_MANIFEST = Object.freeze([
  Object.freeze({
    id: 'task-basis',
    entry: 'packages/basis-pane/src/task-basis-mcp-app.browser.ts',
    output: 'packages/basis-pane/src/task-basis-mcp-app.generated.ts',
  }),
  Object.freeze({
    id: 'session-inventory',
    entry: 'packages/basis-pane/src/session-inventory-mcp-app.browser.ts',
    output: 'packages/basis-pane/src/session-inventory-mcp-app.generated.ts',
  }),
]);
