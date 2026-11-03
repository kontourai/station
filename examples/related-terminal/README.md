# Related Terminal

A Station plugin whose **Terminal launcher** pane opens a shell for its
Project in the bottom panel, through the SDK's related-pane capability
(`useRelatedPanes`) and the closed built-in terminal target
(`{ kind: 'terminal', binding, terminalId?, new? }`; see
[the terminal design](../../docs/design/terminal.md#plugins) and the
[SDK reference](../../docs/reference/sdk.md#related-panes)). It imports only
the public SDK.

## What it demonstrates

- The plugin names a binding (`project`, or `thread:<id>` for a session of
  the same Project) and asks for a `new` shell. It never names a program or a
  working directory: the server resolves the shell and decides the cwd from
  the binding.
- Station renders the terminal itself, on its own socket, as the person
  viewing. A new shell needs their `terminal:operate`; without it the open is
  `not-authorized`. Opening an existing `terminalId` needs
  `terminal:observe` and is read-only without `terminal:operate`.
- A binding outside the plugin's Project, or a session that does not run
  there, is a `context-mismatch`.
- `reveal` and `close` take the handle `open` returned. Closing the pane
  leaves the shell running.

## Install and try

1. Build it with `station plugin build` in this directory, then install the
   directory with `station plugin install ./examples/related-terminal` (or
   through **Plugins → Install plugin**).
2. Open a Project, choose **Add pane**, and open **Terminal launcher**.
3. Choose **Open a terminal**. A shell opens with the Tools, below.

## Verify

The host's admission and refusals are unit-tested in
`src-ui/src/workspace-panes/__tests__/relatedPanesHost.test.tsx`, the pane in
`src-ui/src/workspace-panes/__tests__/TerminalSessionPane.test.tsx`, and the
import boundary in
`packages/sdk/src/__tests__/terminal-view/import-boundary.test.ts`.
